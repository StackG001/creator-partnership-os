import type { Creator } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import { getEnv } from '../../lib/env.js';
import { createLogger, type Logger } from '../../lib/logger.js';
import {
  ENGAGEMENT_FLOORS,
  ENGAGEMENT_PER_VIEW_FLOOR,
  type Platform,
  type SourceKind,
} from '../../lib/constants.js';
import { InstagramClient } from './instagram.js';
import { YouTubeClient } from './youtube.js';
import { readHandlesCsv, readHandlesStdin, type CsvRow } from './csv.js';
import { detectDigitalProduct, type ProductDetection } from './product-signals.js';
import { computeMetrics, type DiscoveredProfile } from './types.js';
import type { FetchImpl } from '../../lib/http.js';

/**
 * Discovery orchestration: run a backend, dedupe, apply the qualification
 * window, detect an existing product, and upsert Creators with status FOUND.
 *
 * The backends are injectable so the whole pipeline is testable without a
 * network: pass `clients` and nothing reaches out.
 */

export type FinderPlatform = 'ig' | 'yt' | 'csv';

export interface FinderOptions {
  platform: FinderPlatform;
  /** Search phrases. One Source row is created per phrase. */
  queries: string[];
  niche?: string;
  limit: number;
  minFollowers: number;
  maxFollowers: number;
  /** 0-1. Creators below this are kept but flagged, not discarded. */
  minEngagement?: number;
  /** CSV path, or "-" for stdin. Required when platform is csv. */
  csvPath?: string;
  /** Which backend enriches CSV rows that don't name a platform. */
  csvPlatform?: Exclude<Platform, 'BOTH'>;
  dryRun?: boolean;
  /** Apify actor override. */
  actor?: string;
  log?: Logger;
  /** Test seam — injected clients bypass all network access. */
  clients?: {
    instagram?: Pick<InstagramClient, 'searchHandles' | 'fetchProfiles'>;
    youtube?: Pick<YouTubeClient, 'searchChannelIds' | 'fetchProfiles'>;
    fetchImpl?: FetchImpl;
  };
}

export interface FinderCandidate {
  profile: DiscoveredProfile;
  detection: ProductDetection;
  metrics: ReturnType<typeof computeMetrics>;
  qualified: boolean;
  /** Why it failed the window, if it did. */
  reason?: string;
  sourceId?: string;
}

export interface FinderResult {
  sourceIds: string[];
  /** Distinct profiles fetched, after in-run dedupe. */
  found: number;
  qualified: number;
  created: number;
  updated: number;
  candidates: FinderCandidate[];
  skipped: Array<{ handle: string; reason: string }>;
}

const SOURCE_KIND: Record<FinderPlatform, SourceKind> = {
  ig: 'IG_SEARCH',
  yt: 'YT_SEARCH',
  csv: 'CSV_IMPORT',
};

const SOURCE_PLATFORM: Record<FinderPlatform, Platform> = {
  ig: 'INSTAGRAM',
  yt: 'YOUTUBE',
  csv: 'BOTH',
};

/**
 * The qualification window. Engagement below the floor is recorded as a reason
 * but does not disqualify: a 9k-follower account is out of scope, whereas a
 * quiet week is a scoring problem, and the scorer is better placed to judge it.
 */
function qualify(
  profile: DiscoveredProfile,
  metrics: ReturnType<typeof computeMetrics>,
  options: Pick<FinderOptions, 'minFollowers' | 'maxFollowers' | 'minEngagement'>,
): { qualified: boolean; reason?: string } {
  const followers = profile.followers;

  if (followers === undefined) return { qualified: false, reason: 'follower count unavailable' };
  if (followers < options.minFollowers) {
    return { qualified: false, reason: `${followers.toLocaleString()} followers < ${options.minFollowers.toLocaleString()}` };
  }
  if (followers > options.maxFollowers) {
    return { qualified: false, reason: `${followers.toLocaleString()} followers > ${options.maxFollowers.toLocaleString()}` };
  }

  // YouTube is judged on engagement per view, Instagram on engagement per
  // follower — see ENGAGEMENT_FLOORS for why the two are not comparable.
  // An explicit --minEngagement overrides whichever applies.
  const onYouTube = profile.platform === 'YOUTUBE';
  const rate = onYouTube ? metrics.engagementPerView : metrics.engagementRate;
  const floor =
    options.minEngagement ??
    (onYouTube ? ENGAGEMENT_PER_VIEW_FLOOR : ENGAGEMENT_FLOORS.INSTAGRAM);
  const basis = onYouTube ? 'per view' : 'per follower';

  if (rate !== undefined && rate < floor) {
    return {
      qualified: true,
      reason: `low engagement ${(rate * 100).toFixed(2)}% ${basis} < ${(floor * 100).toFixed(2)}%`,
    };
  }

  return { qualified: true };
}

function buildInstagramClient(options: FinderOptions) {
  if (options.clients?.instagram) return options.clients.instagram;
  const token = getEnv().APIFY_TOKEN;
  if (!token) {
    throw new Error(
      'APIFY_TOKEN is not set — Instagram discovery needs it. Add it to .env (see .env.example), or use `--platform csv` to import handles instead.',
    );
  }
  return new InstagramClient({
    token,
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.clients?.fetchImpl ? { fetchImpl: options.clients.fetchImpl } : {}),
  });
}

function buildYouTubeClient(options: FinderOptions) {
  if (options.clients?.youtube) return options.clients.youtube;
  const apiKey = getEnv().YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'YOUTUBE_API_KEY (or YT_API_KEY) is not set — YouTube discovery needs it. Add it to .env (see .env.example).',
    );
  }
  return new YouTubeClient({
    apiKey,
    ...(options.clients?.fetchImpl ? { fetchImpl: options.clients.fetchImpl } : {}),
  });
}

/** Find or create the Source row a run is attributed to. */
async function upsertSource(
  platform: FinderPlatform,
  query: string,
  niche: string | undefined,
  dryRun: boolean,
): Promise<string | undefined> {
  if (dryRun) return undefined;
  const where = {
    platform_kind_query: {
      platform: SOURCE_PLATFORM[platform],
      kind: SOURCE_KIND[platform],
      query,
    },
  };
  const source = await prisma.source.upsert({
    where,
    create: {
      platform: SOURCE_PLATFORM[platform],
      kind: SOURCE_KIND[platform],
      query,
      ...(niche ? { niche } : {}),
    },
    update: {},
  });
  return source.id;
}

/** Collect profiles for one query, tagged with the Source they came from. */
async function discover(
  options: FinderOptions,
  log: Logger,
): Promise<Array<{ profile: DiscoveredProfile; sourceId?: string }>> {
  const collected: Array<{ profile: DiscoveredProfile; sourceId?: string }> = [];
  const seen = new Set<string>();
  const dryRun = options.dryRun ?? false;

  if (options.platform === 'csv') {
    const path = options.csvPath;
    if (!path) throw new Error('--csv <path> is required when --platform is csv (use "-" to read stdin).');

    const rows: CsvRow[] =
      path === '-'
        ? await readHandlesStdin(options.csvPlatform ?? 'INSTAGRAM')
        : await readHandlesCsv(path, options.csvPlatform ?? 'INSTAGRAM');

    log.info(`csv: ${rows.length} handle(s) from ${path === '-' ? 'stdin' : path}`);
    const sourceId = await upsertSource('csv', path, options.niche, dryRun);

    // Enrich through the same backends the live platforms use.
    const byPlatform = {
      INSTAGRAM: rows.filter((r) => r.platform === 'INSTAGRAM').map((r) => r.handle),
      YOUTUBE: rows.filter((r) => r.platform === 'YOUTUBE').map((r) => r.handle),
    };

    if (byPlatform.INSTAGRAM.length) {
      const client = buildInstagramClient(options);
      const profiles = await client.fetchProfiles(byPlatform.INSTAGRAM.slice(0, options.limit));
      for (const profile of profiles) {
        if (seen.has(profile.handle)) continue;
        seen.add(profile.handle);
        collected.push({ profile, ...(sourceId ? { sourceId } : {}) });
      }
    }

    if (byPlatform.YOUTUBE.length) {
      const client = buildYouTubeClient(options);
      // CSV YouTube rows are channel ids or @handles; the API takes ids here.
      const profiles = await client.fetchProfiles(byPlatform.YOUTUBE.slice(0, options.limit));
      for (const profile of profiles) {
        if (seen.has(profile.handle)) continue;
        seen.add(profile.handle);
        collected.push({ profile, ...(sourceId ? { sourceId } : {}) });
      }
    }

    return collected;
  }

  // Live search: spread the limit across the queries so one phrase cannot
  // consume the whole run.
  const perQuery = Math.max(1, Math.ceil(options.limit / Math.max(1, options.queries.length)));

  for (const phrase of options.queries) {
    if (collected.length >= options.limit) break;

    const sourceId = await upsertSource(options.platform, phrase, options.niche, dryRun);
    const room = Math.min(perQuery, options.limit - collected.length);
    log.info(`searching ${options.platform}: "${phrase}" (up to ${room})`);

    let profiles: DiscoveredProfile[];
    if (options.platform === 'ig') {
      const client = buildInstagramClient(options);
      const handles = await client.searchHandles(phrase, room);
      log.debug(`"${phrase}" -> ${handles.length} handle(s)`);
      const fresh = handles.filter((h) => !seen.has(h));
      profiles = fresh.length ? await client.fetchProfiles(fresh) : [];
    } else {
      const client = buildYouTubeClient(options);
      const ids = await client.searchChannelIds(phrase, room);
      log.debug(`"${phrase}" -> ${ids.length} channel(s)`);
      profiles = ids.length ? await client.fetchProfiles(ids) : [];
    }

    for (const profile of profiles) {
      // Dedupe by handle across every query in the run.
      if (seen.has(profile.handle)) {
        log.debug(`duplicate handle skipped: ${profile.handle}`);
        continue;
      }
      seen.add(profile.handle);
      collected.push({ profile, ...(sourceId ? { sourceId } : {}) });
      if (collected.length >= options.limit) break;
    }
  }

  return collected;
}

/** Persist one qualified candidate, preserving pipeline progress on re-runs. */
async function upsertCreator(
  candidate: FinderCandidate,
  niche: string | undefined,
): Promise<{ creator: Creator; created: boolean }> {
  const { profile, detection, metrics } = candidate;

  const shared = {
    platform: profile.platform,
    displayName: profile.displayName ?? null,
    profileUrl: profile.profileUrl ?? null,
    bio: profile.bio ?? null,
    country: profile.country ?? null,
    followers: profile.followers ?? null,
    followingCount: profile.followingCount ?? null,
    postCount: profile.postCount ?? null,
    avgViews: metrics.avgViews ?? null,
    avgLikes: metrics.avgLikes ?? null,
    avgComments: metrics.avgComments ?? null,
    engagementRate: metrics.engagementRate ?? null,
    engagementPerView: metrics.engagementPerView ?? null,
    postsPerWeek: metrics.postsPerWeek ?? null,
    metricsAt: new Date(),
    hasDigitalProduct: detection.hasDigitalProduct,
    productEvidence: detection as unknown as object,
    contactEmail: profile.contactEmail ?? null,
    contactMethod: profile.contactEmail
      ? 'EMAIL'
      : profile.platform === 'INSTAGRAM'
        ? 'IG_DM'
        : 'YT_ABOUT',
    altProfiles: { links: profile.externalLinks } as unknown as object,
    raw: profile.raw as object,
    ...(niche ? { niche } : {}),
    ...(candidate.sourceId ? { sourceId: candidate.sourceId } : {}),
  };

  const existing = await prisma.creator.findUnique({ where: { handle: profile.handle } });

  const creator = await prisma.creator.upsert({
    where: { handle: profile.handle },
    create: { handle: profile.handle, status: 'FOUND', ...shared },
    // A re-run refreshes metrics but must not drag a creator who is already
    // AUDITED or CONTACTED back to FOUND.
    update: shared,
  });

  return { creator, created: !existing };
}

export async function findCreators(options: FinderOptions): Promise<FinderResult> {
  const log = options.log ?? createLogger('finder');
  const dryRun = options.dryRun ?? false;

  const discovered = await discover(options, log);

  const candidates: FinderCandidate[] = [];
  const skipped: FinderResult['skipped'] = [];

  for (const { profile, sourceId } of discovered) {
    const metrics = computeMetrics(profile);
    const detection = detectDigitalProduct(profile);
    const { qualified, reason } = qualify(profile, metrics, options);

    const candidate: FinderCandidate = {
      profile,
      detection,
      metrics,
      qualified,
      ...(reason ? { reason } : {}),
      ...(sourceId ? { sourceId } : {}),
    };
    candidates.push(candidate);
    if (!qualified) skipped.push({ handle: profile.handle, reason: reason ?? 'did not qualify' });
  }

  let created = 0;
  let updated = 0;

  if (!dryRun) {
    for (const candidate of candidates.filter((c) => c.qualified)) {
      const result = await upsertCreator(candidate, options.niche);
      if (result.created) created += 1;
      else updated += 1;
    }

    // Source bookkeeping, so a repeat run is attributable.
    const sourceIds = [...new Set(candidates.map((c) => c.sourceId).filter(Boolean))] as string[];
    for (const sourceId of sourceIds) {
      const forSource = candidates.filter((c) => c.sourceId === sourceId);
      await prisma.source.update({
        where: { id: sourceId },
        data: {
          lastRunAt: new Date(),
          runCount: { increment: 1 },
          foundCount: { increment: forSource.length },
          qualifiedCount: { increment: forSource.filter((c) => c.qualified).length },
        },
      });
    }
  }

  return {
    sourceIds: [...new Set(candidates.map((c) => c.sourceId).filter(Boolean))] as string[],
    found: candidates.length,
    qualified: candidates.filter((c) => c.qualified).length,
    created,
    updated,
    candidates,
    skipped,
  };
}
