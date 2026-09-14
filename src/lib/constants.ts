/**
 * String unions mirrored by the String columns in prisma/schema.prisma.
 * SQLite has no enums, so this file is the single source of truth — change a
 * value here and change the comment on the matching Prisma field.
 */

export const PLATFORMS = ['INSTAGRAM', 'YOUTUBE', 'BOTH'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const SOURCE_KINDS = [
  'HASHTAG',
  'YT_SEARCH',
  'IG_SEARCH',
  'SIMILAR_TO',
  'NEWSLETTER',
  'MANUAL',
  'CSV_IMPORT',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CREATOR_STATUSES = [
  'FOUND',
  'SCORED',
  'AUDITED',
  'CONTACTED',
  'REPLIED',
  'AGREED',
  'LAUNCHED',
  'DECLINED',
  'DISQUALIFIED',
] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];

export const CONTACT_METHODS = [
  'EMAIL',
  'IG_DM',
  'YT_ABOUT',
  'WEBSITE_FORM',
  'MANAGER',
] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

export const PRODUCT_STATUSES = [
  'DRAFT',
  'RESEARCHING',
  'OUTLINED',
  'WRITING',
  'BRANDED',
  'RENDERED',
  'APPROVED',
  'PUBLISHED',
  'ARCHIVED',
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const OUTREACH_CHANNELS = ['EMAIL', 'IG_DM', 'YT_ABOUT', 'X_DM', 'MANUAL'] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export const OUTREACH_STATUSES = [
  'DRAFT',
  'APPROVED',
  'SENT',
  'REPLIED',
  'BOUNCED',
  'IGNORED',
  'DECLINED',
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const LAUNCH_PLATFORMS = ['WHOP', 'GUMROAD', 'STRIPE', 'MANUAL'] as const;
export type LaunchPlatform = (typeof LAUNCH_PLATFORMS)[number];

export const LAUNCH_STATUSES = ['PENDING', 'LIVE', 'PAUSED', 'ENDED', 'FAILED'] as const;
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];

/**
 * Scorer weights, summing to 100. The scorer asserts the sum at load time, so
 * changing one without rebalancing the others fails fast instead of quietly
 * producing scores that no longer top out at 100.
 */
export const SCORE_WEIGHTS = {
  /** Is the niche specific, and is the content actually educational? */
  nicheSpecificity: 25,
  /** Engagement rate, plus whether comments show buying/《how do I》intent. */
  engagement: 20,
  /** No product yet, and not already saturated with sponsorships. */
  monetisationGap: 20,
  /** Will this audience pay? LLM estimate, anchored by CPC data when present. */
  spendingPower: 15,
  /** Posting cadence and how consistent it is. */
  consistency: 10,
  /** Can we actually reach them — public email, replies to comments. */
  reachability: 10,
} as const;

export type ScoreComponent = keyof typeof SCORE_WEIGHTS;

export const SCORE_VERDICTS = ['GO', 'MAYBE', 'NO'] as const;
export type ScoreVerdict = (typeof SCORE_VERDICTS)[number];

/** Score thresholds that map a 0-100 score to a verdict when the LLM is off. */
export const VERDICT_THRESHOLDS = { go: 70, maybe: 50 } as const;

/**
 * Bio/link fingerprints that say a creator already sells something. Hitting any
 * of these sets hasDigitalProduct — the whole thesis is finding creators who
 * have an audience but nothing to sell it yet.
 */
export const PRODUCT_SIGNALS = {
  /** Storefront and course platforms: a hit here is near-conclusive. */
  platforms: [
    'stan.store',
    'gumroad.com',
    'whop.com',
    'kajabi.com',
    'teachable.com',
    'thinkific.com',
    'payhip.com',
    'podia.com',
    'lemonsqueezy.com',
    'ko-fi.com/s/',
    'patreon.com',
    'skool.com',
    'beacons.ai/store',
    'shopify.com',
    'etsy.com',
    'samcart.com',
    'thrivecart.com',
    'kartra.com',
    'clickfunnels.com',
    'systeme.io',
    'learnworlds.com',
    'sellfy.com',
    'hotmart.com',
    'buy.stripe.com',
    'checkout.stripe.com',
  ],
  /** Words in a bio that advertise a product. Weaker — needs the link check. */
  keywords: [
    'ebook',
    'e-book',
    'course',
    'guide',
    'template',
    'masterclass',
    'workbook',
    'bootcamp',
    'coaching',
    'my book',
    'shop now',
    'link to buy',
    'enroll',
  ],
} as const;

/** Qualification window from the blueprint: engaged micro-creators only. */
export const QUALIFICATION = {
  minFollowers: 10_000,
  maxFollowers: 200_000,
  /** 0-1. Below this the audience is not engaged enough to buy. */
  minEngagementRate: 0.02,
} as const;

/**
 * Engagement floors are per platform because the denominators are not
 * comparable. An Instagram post is shown to a large share of its followers, so
 * likes-per-follower lands in the low percent. A YouTube video reaches a small
 * slice of subscribers and is mostly watched by non-subscribers, so the same
 * formula lands two orders of magnitude lower — a healthy channel routinely
 * measures 0.01% per subscriber. Judging YouTube on Instagram's 2% floor
 * flags every channel ever published.
 *
 * ENGAGEMENT_PER_VIEW is the fairer read for YouTube (likes + comments over
 * views) and is what the scorer uses there.
 */
export const ENGAGEMENT_FLOORS = {
  INSTAGRAM: 0.02,
  YOUTUBE: 0.0005,
} as const;

/** Floor for the per-view rate, used on YouTube where views are the denominator. */
export const ENGAGEMENT_PER_VIEW_FLOOR = 0.02;

/** Target shape of the generated PDF. */
export const PRODUCT_SPEC = {
  minPages: 35,
  maxPages: 50,
  /** Rough words per rendered A4 page at our body size — used to size outlines. */
  wordsPerPage: 320,
} as const;
