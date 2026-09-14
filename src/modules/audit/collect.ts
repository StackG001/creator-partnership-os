import { getEnv } from '../../lib/env.js';
import { createLogger, type Logger } from '../../lib/logger.js';
import { fetchPageText, type PageText } from '../../lib/page-text.js';
import { extractPalette, type SwatchColor } from '../../lib/palette.js';
import { normalizeHandle } from '../../lib/paths.js';
import { InstagramClient } from '../finder/instagram.js';
import { YouTubeClient } from '../finder/youtube.js';
import { AUDIT_POSTS_SAMPLED, type CommentMetric, type DiscoveredProfile, type PostMetric } from '../finder/types.js';
import { detectDigitalProduct, type ProductSignal } from '../finder/product-signals.js';
import type { AuditSourceSummary } from './schema.js';

/**
 * Everything the audit reasons over, gathered before a single model call.
 *
 * Collection is best-effort by design. A blocked link-in-bio page or a video
 * with comments disabled reduces what the audit can say, and is recorded in
 * `gaps` so the report states what it could not see — rather than a model
 * filling the hole with something plausible.
 */

export interface CollectedAudit {
  profile: DiscoveredProfile;
  /**
   * True when the creator was seen commenting on their own posts. The scorer
   * wants this for reachability but discovery is too shallow to see it.
   */
  repliesToComments: boolean;
  /** Selling signals found in the creator's OWN comments — conclusive. */
  selfPromoSignals: ProductSignal[];
  /** Newest first, up to --posts. */
  posts: PostMetric[];
  /** The best-performing posts, which is where comments were sampled. */
  topPosts: PostMetric[];
  comments: Array<CommentMetric & { postUrl?: string; postLabel?: string }>;
  pinnedPosts: PostMetric[];
  linkPages: PageText[];
  palette: SwatchColor[];
  summary: AuditSourceSummary;
}

export interface CollectOptions {
  handle: string;
  /** Forced platform; otherwise inferred from the input. */
  platform?: 'INSTAGRAM' | 'YOUTUBE';
  posts?: number;
  /** How many top posts to pull comments from. */
  topPosts?: number;
  commentsPerPost?: number;
  /** How many images to sample for the palette. */
  images?: number;
  skipImages?: boolean;
  skipLinks?: boolean;
  log?: Logger;
  clients?: {
    instagram?: Pick<InstagramClient, 'fetchProfiles' | 'fetchComments'>;
    youtube?: Pick<YouTubeClient, 'fetchProfiles' | 'fetchComments'>;
  };
}

/**
 * Work out what was passed: a YouTube channel URL/id, or an Instagram handle.
 * The brief allows either, so the CLI takes one flag and this resolves it.
 */
export function resolveTarget(input: string): {
  platform: 'INSTAGRAM' | 'YOUTUBE';
  /** What the backend needs: a channel id for YouTube, a handle for Instagram. */
  lookup: string;
  handle: string;
} {
  const trimmed = input.trim();

  const channelId = /youtube\.com\/channel\/(UC[\w-]{20,})/i.exec(trimmed)?.[1] ?? (/^UC[\w-]{20,}$/.test(trimmed) ? trimmed : undefined);
  if (channelId) {
    return { platform: 'YOUTUBE', lookup: channelId, handle: normalizeHandle(channelId) };
  }

  if (/youtube\.com|youtu\.be/i.test(trimmed)) {
    // A /@handle or /c/name URL — the caller must supply a channel id, because
    // resolving a vanity URL costs a search call and can return the wrong channel.
    throw new Error(
      `"${input}" is a YouTube URL but not a channel-id URL. Pass the https://www.youtube.com/channel/UC... form, or the bare UC... id — the shortlist CSV has it in profile_url.`,
    );
  }

  return { platform: 'INSTAGRAM', lookup: normalizeHandle(trimmed), handle: normalizeHandle(trimmed) };
}

function buildYouTube(options: CollectOptions) {
  if (options.clients?.youtube) return options.clients.youtube;
  const apiKey = getEnv().YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY (or YT_API_KEY) is not set — the audit needs it to read this channel.');
  return new YouTubeClient({ apiKey });
}

function buildInstagram(options: CollectOptions) {
  if (options.clients?.instagram) return options.clients.instagram;
  const token = getEnv().APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not set — the audit needs it to read this Instagram profile.');
  return new InstagramClient({ token });
}

/** Engagement-weighted: the posts worth reading the comments on. */
function rankPosts(posts: PostMetric[]): PostMetric[] {
  return [...posts].sort((a, b) => {
    const score = (post: PostMetric) => (post.views ?? 0) + ((post.likes ?? 0) + (post.comments ?? 0)) * 10;
    return score(b) - score(a);
  });
}

export async function collect(options: CollectOptions): Promise<CollectedAudit> {
  const log = options.log ?? createLogger('audit');
  const target = resolveTarget(options.handle);
  const postLimit = options.posts ?? AUDIT_POSTS_SAMPLED;
  const topCount = options.topPosts ?? 20;
  const perPost = options.commentsPerPost ?? 20;
  const gaps: string[] = [];

  log.info(`collecting ${target.platform} ${target.handle}: up to ${postLimit} posts`);

  // --- profile + posts -------------------------------------------------------
  let profile: DiscoveredProfile | undefined;

  if (target.platform === 'YOUTUBE') {
    const client = buildYouTube(options);
    [profile] = await client.fetchProfiles([target.lookup], postLimit);
  } else {
    const client = buildInstagram(options);
    [profile] = await client.fetchProfiles([target.lookup], postLimit);
  }

  if (!profile) {
    throw new Error(
      `Could not read ${target.platform} profile "${options.handle}". Check the handle/channel id, and that the account is public.`,
    );
  }

  const posts = profile.posts;
  if (posts.length < 50) {
    gaps.push(`Only ${posts.length} posts available (the brief asks for 50-100) — the channel may not have more.`);
  }
  log.info(`${posts.length} posts`);

  // --- comments on the best posts -------------------------------------------
  const ranked = rankPosts(posts);
  const topPosts = ranked.slice(0, topCount);
  const comments: CollectedAudit['comments'] = [];

  // Some backends embed comments with the post; only fetch what is missing.
  const needFetching = topPosts.filter((post) => !post.commentSample?.length);

  for (const post of topPosts) {
    for (const comment of post.commentSample ?? []) {
      comments.push({ ...comment, postUrl: post.url, postLabel: post.caption?.slice(0, 80) });
    }
  }

  if (needFetching.length) {
    if (target.platform === 'YOUTUBE') {
      const client = buildYouTube(options);
      const channelId = (profile.raw as { id?: string })?.id;
      for (const post of needFetching) {
        if (!post.id) continue;
        try {
          const fetched = await client.fetchComments(post.id, perPost, channelId);
          if (!fetched.length) continue;
          for (const comment of fetched) {
            comments.push({ ...comment, postUrl: post.url, postLabel: post.caption?.slice(0, 80) });
          }
        } catch (error) {
          gaps.push(`Comments unavailable on ${post.url ?? post.id}: ${(error as Error).message}`);
        }
      }
    } else {
      const client = buildInstagram(options);
      const urls = needFetching.map((post) => post.url).filter((url): url is string => Boolean(url));
      try {
        const byPost = await client.fetchComments(urls, perPost);
        for (const post of needFetching) {
          for (const comment of byPost.get(post.url ?? '') ?? []) {
            comments.push({ ...comment, postUrl: post.url, postLabel: post.caption?.slice(0, 80) });
          }
        }
      } catch (error) {
        gaps.push(`Instagram comment fetch failed: ${(error as Error).message}`);
      }
    }
  }

  if (!comments.length) {
    gaps.push('No comments could be read — pains are drawn from captions alone, which is weaker evidence.');
  }
  log.info(`${comments.length} comments from ${topPosts.length} top posts`);

  // --- what the creator's own comments reveal --------------------------------
  const creatorComments = comments.filter((comment) => comment.byCreator);
  const repliesToComments = creatorComments.length > 0;

  // A creator selling in their own comment is conclusive, and the bio-and-links
  // check at discovery time cannot see it. Keywords are safe to use here
  // because these are the creator's own words, not a hundred mixed captions.
  const selfPromo = detectDigitalProduct({
    bio: creatorComments.map((comment) => comment.text).join('\n'),
    externalLinks: [],
  });
  const selfPromoSignals = selfPromo.signals;

  if (selfPromoSignals.length) {
    gaps.push(
      `The creator sells in their own comments (${selfPromoSignals
        .map((signal) => signal.match)
        .join(', ')}) — discovery only reads the bio, so hasDigitalProduct may be wrong for this creator.`,
    );
  }

  // --- pinned ----------------------------------------------------------------
  const pinnedPosts = posts.filter((post) => post.pinned);
  if (!pinnedPosts.length) {
    gaps.push('No pinned post identified (the platform may not expose it).');
  }

  // --- link-in-bio -----------------------------------------------------------
  const linkPages: PageText[] = [];
  if (!options.skipLinks) {
    // The first couple of links are the ones a creator actually promotes.
    for (const url of profile.externalLinks.slice(0, 3)) {
      const page = await fetchPageText(url);
      linkPages.push(page);
      if (!page.ok) gaps.push(`Link-in-bio page ${url} could not be read: ${page.error}`);
    }
    if (!profile.externalLinks.length) gaps.push('No link in bio to read.');
  }
  log.info(`${linkPages.filter((p) => p.ok).length}/${linkPages.length} link pages read`);

  // --- palette ---------------------------------------------------------------
  let palette: SwatchColor[] = [];
  let imagesSampled = 0;
  if (!options.skipImages) {
    const imageUrls = ranked
      .map((post) => post.imageUrl)
      .filter((url): url is string => Boolean(url))
      .slice(0, options.images ?? 12);

    if (imageUrls.length) {
      const result = await extractPalette(imageUrls);
      palette = result.colors;
      imagesSampled = result.sampled;
      if (result.failed.length) {
        gaps.push(`${result.failed.length}/${imageUrls.length} images could not be read for the palette: ${result.failed[0]?.error}`);
      }
    } else {
      gaps.push('No post images available for palette extraction.');
    }
  }
  log.info(`palette: ${palette.length} colours from ${imagesSampled} image(s)`);

  return {
    profile,
    repliesToComments,
    selfPromoSignals,
    posts,
    topPosts,
    comments,
    pinnedPosts,
    linkPages,
    palette,
    summary: {
      handle: profile.handle,
      platform: profile.platform,
      postsAnalysed: posts.length,
      commentsAnalysed: comments.length,
      pinnedPosts: pinnedPosts.length,
      imagesSampled,
      linkPagesRead: linkPages.filter((page) => page.ok).length,
      gaps,
      collectedAt: new Date().toISOString(),
    },
  };
}
