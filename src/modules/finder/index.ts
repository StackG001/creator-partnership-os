import { PRODUCT_PLATFORM_DOMAINS, QUALIFICATION, type Platform, type SourceKind } from '../../lib/constants.js';
import { prisma } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import { ensureCreatorDir, normalizeHandle, toRelative } from '../../lib/paths.js';
import {
  getRecentVideos,
  resolveChannel,
  searchChannelIds,
  getChannels,
  type Channel,
  type Video,
} from '../../lib/youtube.js';

/**
 * Discovery. Turns a search term or a known channel into Creator rows carrying
 * the metrics the scorer needs, and nothing more: no model is called here, so a
 * finder run is cheap, deterministic and reproducible.
 *
 * Qualification is recorded rather than enforced. A channel outside the window
 * is stored as DISQUALIFIED with the reason, because "we looked at them and
 * said no, for this reason" is worth more later than a silent omission.
 */

const log = createLogger('finder');

export interface CreatorMetrics {
  avgViews: number;
  avgLikes: number;
  avgComments: number;
  /** (likes + comments) / views across the sample. 0-1, not a percentage. */
  engagementRate: number;
  postsPerWeek: number;
  sampleSize: number;
}

export interface ProductEvidence {
  hasDigitalProduct: boolean;
  matches: Array<{ domain: string; url: string; where: string }>;
}

export interface FoundCreator {
  handle: string;
  channelId: string;
  displayName: string;
  url: string;
  followers?: number;
  metrics: CreatorMetrics;
  evidence: ProductEvidence;
  qualified: boolean;
  disqualifiedFor?: string;
  created: boolean;
}

export interface FinderResult {
  query: string;
  kind: SourceKind;
  found: FoundCreator[];
  qualified: number;
  quotaUnits: number;
}

/** Averages over the sampled uploads. Views of 0 would divide by zero. */
export function computeMetrics(videos: Video[]): CreatorMetrics {
  if (videos.length === 0) {
    return { avgViews: 0, avgLikes: 0, avgComments: 0, engagementRate: 0, postsPerWeek: 0, sampleSize: 0 };
  }

  const sum = (pick: (v: Video) => number) => videos.reduce((t, v) => t + pick(v), 0);
  const views = sum((v) => v.views);
  const likes = sum((v) => v.likes);
  const comments = sum((v) => v.comments);

  const dates = videos.map((v) => Date.parse(v.publishedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const spanWeeks =
    dates.length > 1 ? Math.max((dates[dates.length - 1]! - dates[0]!) / (7 * 24 * 3600 * 1000), 1 / 7) : 1;

  return {
    avgViews: Math.round(views / videos.length),
    avgLikes: Math.round(likes / videos.length),
    avgComments: Math.round(comments / videos.length),
    engagementRate: views > 0 ? (likes + comments) / views : 0,
    postsPerWeek: Number((videos.length / spanWeeks).toFixed(2)),
    sampleSize: videos.length,
  };
}

const URL_PATTERN = /https?:\/\/[^\s)<>"']+/gi;

/**
 * Does this creator already sell something digital? Link-based rather than
 * language-based on purpose: "link in bio to my course" is noise, a gumroad URL
 * is evidence. The audit revisits this properly with the model.
 */
export function detectDigitalProduct(channel: Channel, videos: Video[]): ProductEvidence {
  const haystacks: Array<{ text: string; where: string }> = [
    { text: channel.description, where: 'channel description' },
    ...videos.map((v) => ({ text: v.description, where: `video: ${v.title.slice(0, 60)}` })),
  ];

  const matches: ProductEvidence['matches'] = [];
  for (const { text, where } of haystacks) {
    for (const url of text.match(URL_PATTERN) ?? []) {
      const domain = PRODUCT_PLATFORM_DOMAINS.find((d) => url.toLowerCase().includes(d));
      if (domain && !matches.some((m) => m.url === url)) matches.push({ domain, url, where });
    }
  }
  return { hasDigitalProduct: matches.length > 0, matches };
}

/** The qualification window, with the reason spelled out when it fails. */
export function qualify(
  followers: number | undefined,
  metrics: CreatorMetrics,
  evidence: ProductEvidence,
): { qualified: boolean; reason?: string } {
  if (followers === undefined) return { qualified: false, reason: 'subscriber count is hidden' };
  if (followers < QUALIFICATION.minFollowers) {
    return { qualified: false, reason: `${followers.toLocaleString()} subs is below the ${QUALIFICATION.minFollowers.toLocaleString()} floor` };
  }
  if (followers > QUALIFICATION.maxFollowers) {
    return { qualified: false, reason: `${followers.toLocaleString()} subs is above the ${QUALIFICATION.maxFollowers.toLocaleString()} ceiling` };
  }
  if (metrics.sampleSize === 0) return { qualified: false, reason: 'no public uploads to measure' };
  if (metrics.engagementRate < QUALIFICATION.minEngagementRate) {
    return {
      qualified: false,
      reason: `engagement ${(metrics.engagementRate * 100).toFixed(2)}% is under the ${(QUALIFICATION.minEngagementRate * 100).toFixed(0)}% floor`,
    };
  }
  if (evidence.hasDigitalProduct) {
    return { qualified: false, reason: `already sells on ${evidence.matches[0]?.domain}` };
  }
  return { qualified: true };
}

/** Prefer the @handle; fall back to the channel id so the key is always stable. */
export function handleFor(channel: Channel): string {
  return normalizeHandle(channel.handle ?? channel.id);
}

export interface FindOptions {
  /** A channel URL, @handle or UC… id. Cheap: 1 quota unit. */
  channel?: string;
  /** Keyword discovery. Expensive: 100 quota units per call. */
  query?: string;
  limit?: number;
  /** How many recent uploads to sample for metrics. */
  videos?: number;
  niche?: string;
  dryRun?: boolean;
}

export async function findCreators(options: FindOptions): Promise<FinderResult> {
  const { channel, query, limit = 10, videos: videoSample = 12, niche, dryRun = false } = options;

  if (!channel && !query) throw new Error('finder needs either --channel or --query');

  let channels: Channel[] = [];
  let quotaUnits = 0;
  const kind: SourceKind = channel ? 'MANUAL' : 'YT_SEARCH';
  const term = channel ?? query ?? '';

  if (channel) {
    const resolved = await resolveChannel(channel);
    quotaUnits += 1;
    if (!resolved) {
      throw new Error(
        `YouTube has no channel matching "${channel}". It may be mistyped, or deleted, suspended or private — the API reports all four the same way.`,
      );
    }
    channels = [resolved];
  } else {
    const ids = await searchChannelIds(query!, limit);
    quotaUnits += 100;
    channels = await getChannels(ids);
    quotaUnits += Math.ceil(ids.length / 50);
  }

  log.info(`${channels.length} channel(s) to profile`);

  const found: FoundCreator[] = [];

  for (const ch of channels) {
    const recent = await getRecentVideos(ch, videoSample);
    quotaUnits += Math.ceil(videoSample / 50) * 2;

    const metrics = computeMetrics(recent);
    const evidence = detectDigitalProduct(ch, recent);
    const verdict = qualify(ch.subscribers, metrics, evidence);
    const handle = handleFor(ch);

    log.info(
      `${handle} · ${ch.subscribers?.toLocaleString() ?? '?'} subs · ` +
        `${(metrics.engagementRate * 100).toFixed(2)}% eng · ` +
        (verdict.qualified ? 'qualified' : `skipped — ${verdict.reason}`),
    );

    let created = false;
    if (!dryRun) {
      const source = await prisma.source.upsert({
        where: { platform_kind_query: { platform: 'YOUTUBE', kind, query: term } },
        create: { platform: 'YOUTUBE', kind, query: term, ...(niche ? { niche } : {}) },
        update: {},
      });

      const existing = await prisma.creator.findUnique({ where: { handle } });
      created = !existing;

      const outputDir = toRelative(await ensureCreatorDir(handle));
      const data = {
        platform: 'YOUTUBE' as Platform,
        displayName: ch.title,
        profileUrl: ch.url,
        ...(niche ? { niche } : {}),
        bio: ch.description.slice(0, 2000),
        ...(ch.language ? { language: ch.language } : {}),
        ...(ch.country ? { country: ch.country } : {}),
        ...(ch.subscribers !== undefined ? { followers: ch.subscribers } : {}),
        ...(ch.videoCount !== undefined ? { postCount: ch.videoCount } : {}),
        avgViews: metrics.avgViews,
        avgLikes: metrics.avgLikes,
        avgComments: metrics.avgComments,
        engagementRate: metrics.engagementRate,
        postsPerWeek: metrics.postsPerWeek,
        metricsAt: new Date(),
        hasDigitalProduct: evidence.hasDigitalProduct,
        productEvidence: evidence as object,
        outputDir,
        sourceId: source.id,
        // Keep the sample itself, not just its size: the scorer reads titles
        // straight from here instead of spending quota fetching them again.
        raw: {
          channel: ch as object,
          videos: recent.map((v) => ({
            id: v.id,
            title: v.title,
            url: v.url,
            publishedAt: v.publishedAt,
            views: v.views,
            likes: v.likes,
            comments: v.comments,
          })),
        },
        status: verdict.qualified ? 'DISCOVERED' : 'DISQUALIFIED',
        ...(verdict.reason ? { disqualifiedFor: verdict.reason } : {}),
      };

      await prisma.creator.upsert({ where: { handle }, create: { handle, ...data }, update: data });

      await prisma.source.update({
        where: { id: source.id },
        data: {
          lastRunAt: new Date(),
          runCount: { increment: 1 },
          foundCount: { increment: 1 },
          ...(verdict.qualified ? { qualifiedCount: { increment: 1 } } : {}),
        },
      });
    }

    found.push({
      handle,
      channelId: ch.id,
      displayName: ch.title,
      url: ch.url,
      ...(ch.subscribers !== undefined ? { followers: ch.subscribers } : {}),
      metrics,
      evidence,
      qualified: verdict.qualified,
      ...(verdict.reason ? { disqualifiedFor: verdict.reason } : {}),
      created,
    });
  }

  return { query: term, kind, found, qualified: found.filter((f) => f.qualified).length, quotaUnits };
}
