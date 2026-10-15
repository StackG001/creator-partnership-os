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
  'DISCOVERED',
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
  /** A sibling variant of a message that was sent — never sent itself. */
  'SUPERSEDED',
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const QUOTE_AUTHORS = ['CREATOR_CAPTION', 'FOLLOWER_COMMENT'] as const;
export type QuoteAuthor = (typeof QUOTE_AUTHORS)[number];

export const QUOTE_ORIGINS = ['APIFY_AUDIT', 'YOUTUBE_AUDIT', 'CHROME_RESEARCH', 'MANUAL', 'LEGACY_SEED'] as const;
export type QuoteOrigin = (typeof QUOTE_ORIGINS)[number];

export const LAUNCH_PLATFORMS = ['WHOP', 'GUMROAD', 'STRIPE', 'MANUAL'] as const;
export type LaunchPlatform = (typeof LAUNCH_PLATFORMS)[number];

export const LAUNCH_STATUSES = ['PENDING', 'LIVE', 'PAUSED', 'ENDED', 'FAILED'] as const;
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];

/** Qualification window from the blueprint: engaged micro-creators only. */
export const QUALIFICATION = {
  minFollowers: 10_000,
  maxFollowers: 200_000,
  /** 0-1. Below this the audience is not engaged enough to buy. */
  minEngagementRate: 0.02,
  /**
   * Scorer 0-100 cutoff for the outreach shortlist. Set 2026-09-22 from a
   * real distribution of 15 genuinely-measured creators (score range 37-72,
   * post engagement-nullability fix): 65 caught 6-7 of them, 70 caught only
   * 2 — too thin a sample off one discovery run to commit to the higher bar.
   * Revisit once more of the pool has real engagement data.
   */
  minScore: 65,
  /**
   * Scorer's reach sub-score floor (0-100 scale) for anyone inside the
   * follower window. Set 2026-09-22: the old pure log-scale gave someone
   * just above minFollowers a reach near 0, which punished meeting the
   * qualification floor as if it were disqualifying. Clearing 10k is real
   * credit — 40 is the floor, scaling up to 100 at maxFollowers.
   */
  reachFloor: 40,
} as const;

/** Target shape of the generated PDF. */
export const PRODUCT_SPEC = {
  minPages: 35,
  maxPages: 50,
  /** Rough words per rendered A4 page at our body size — used to size outlines. */
  wordsPerPage: 320,
} as const;

/** Identity every outreach message sends from and signs off as. */
export const OUTREACH_SENDER = {
  name: 'Gerald Ebere Ozokwelu',
  email: 'gerald@iclipmedia.com',
  company: 'iClipmedia',
} as const;

/** How long to wait after a send, with no reply, before the next follow-up is due. */
export const FOLLOW_UP = {
  /** Weekends don't count — a Friday send is due the following Wednesday. */
  businessDays: 3,
  /** Sequence 3 is the closing note — once it's sent, no further follow-up is owed. */
  finalSequence: 3,
} as const;

/**
 * Apify spending limits. The plan's monthly cap, cycle dates and current usage
 * are read live from GET /v2/users/me/limits — never hard-coded — and enforced
 * in src/lib/sources/apify.ts before and during every actor run.
 */
export const APIFY = {
  /** Instagram may use this share of the plan's monthly limit; the rest is headroom. */
  instagramShareOfPlan: 0.8,
  /** No single actor run may cost more than this. Passed as maxTotalChargeUsd and watched while it runs. */
  maxRunUsd: 1,
} as const;

/**
 * Instagram audit depth — the paid stage, only for creators who passed the
 * free/cheap stage-1 checks. Profile (1 result) + posts + comments on the
 * posts with the most comments (that's where the audience asks for things).
 * At the Starter-tier $0.0023/result: 1 + 18 + 6×25 = 169 results ≈ $0.39.
 */
export const INSTAGRAM_AUDIT = {
  posts: 18,
  commentPosts: 6,
  commentsPerPost: 25,
} as const;

/**
 * Stage-1 Instagram filter: business categories that mean a company/shop, not
 * an individual creator. Instagram's own category for creators ("Digital
 * creator", "Blogger", "Public figure"…) passes.
 */
export const IG_BRAND_CATEGORIES =
  /\b(product\/service|shopping|retail|brand|company|business|store|shop|grocery|restaurant|cafe|bakery|farm|nursery|garden center|manufactur|wholesale|supplier|agency|e-?commerce|organization|local business)\b/i;

/** Automatic email sending from the daily pipeline. */
export const AUTO_SEND = {
  /** Switched on 2026-10-15 after Gerald approved the dry run. Every check in outreach `sendChecks` must still pass. */
  enabled: true,
  /** Protects the iclipmedia.com sending reputation. Counts every SENT email today, auto or manual. */
  maxEmailsPerDay: 15,
} as const;

export const NICHE_ORIGINS = ['SEED', 'GENERATED', 'SIMILAR_ACCOUNTS', 'PROVEN', 'LEGACY'] as const;
export type NicheOrigin = (typeof NICHE_ORIGINS)[number];

export const NICHE_STATUSES = ['EXPLORING', 'PRODUCING', 'RETIRED'] as const;
export type NicheStatus = (typeof NICHE_STATUSES)[number];

/**
 * The niche library (src/modules/niches). No niche is off limits: anywhere
 * creators teach, show or struggle with something and their audience asks
 * questions. These categories only steer the weekly generator — it invents
 * niches and sub-niches inside and beyond them.
 */
export const NICHE_LIBRARY = {
  categories: [
    'cooking', 'baking', 'budgeting', 'parenting', 'relationships', 'fitness', 'health conditions',
    'mental wellness', 'personal finance', 'crafts', 'gardening', 'pets', 'beauty', 'hair care', 'skin care',
    'fashion', 'home & cleaning', 'careers', 'study', 'languages', 'faith', 'travel', 'cars', 'DIY',
    'small business', 'hobbies', 'disability & chronic illness life', 'life situations', 'outdoors', 'music',
  ],
  /** New niches the weekly generator adds. */
  newNichesPerWeek: 24,
  /** Days between generator runs. */
  generateEveryDays: 7,
  /** Share of each run's searches spent exploring niches that haven't produced yet; the rest exploits producers. */
  exploreShare: 0.3,
  /** A search term runs at most once in this many days. */
  rotationDays: 7,
  /** A niche with no new qualified creator this many runs in a row is retired. */
  retireAfterEmptyRuns: 3,
} as const;

/** The niches the pipeline started with (pre-library) — migrated into the library as LEGACY. */
export const LEGACY_NICHES = [
  { niche: 'Mushroom cultivation', category: 'gardening', queries: ['mushroom cultivation', 'growing mushrooms at home', 'oyster mushroom grow kit'] },
  { niche: 'Microgreens & sprouting', category: 'gardening', queries: ['growing microgreens at home', 'microgreens business', 'sprouting seeds at home'] },
] as const;

/**
 * The automated discovery pipeline (`npm run pipeline`). YouTube runs daily
 * (free YouTube Data API quota); Instagram runs twice a week through Apify,
 * inside the APIFY limits. Scoped to the niches being actively worked — edit
 * `niches` to change what it searches; each query becomes a search Source
 * (YT_SEARCH on YouTube, IG_SEARCH on Instagram).
 */
/**
 * The automated pipeline (`npm run pipeline -- --daily --part youtube|instagram`).
 * YouTube at 09:00 (free API), Instagram at 10:00 (Apify, inside APIFY). Search
 * terms come from the niche library, not a fixed list.
 */
export const PIPELINE = {
  /** Brand-new YouTube creators the pipeline may add per calendar day. */
  dailyNewCreatorCap: 5,
  /** YouTube searches per day at most (100 quota units each of the 10,000/day). */
  youtubeSearchesPerDay: 12,
  /** Variants drafted per message; the auto-sender sends the first that passes every check. */
  outreachVariants: 2,
  /** A search term that adds no new qualified creator this many runs in a row is paused. */
  pauseAfterEmptyRuns: 2,
  instagram: {
    /** Instagram runs every day (0 = Sunday). The budget is spread over the run days left in the cycle. */
    runDays: [0, 1, 2, 3, 4, 5, 6],
    /**
     * Pre-measurement estimates. After 3 live runs the pipeline sizes runs from
     * the measured averages instead (PipelineRun rows).
     */
    estimate: {
      /** Gerald's planning number for one paid audit. The formula from INSTAGRAM_AUDIT is reported alongside. */
      auditUsd: 0.36,
      /** Stage-1 profiles checked per creator who qualifies (a guess until measured). */
      profilesPerQualified: 20,
    },
    /** Never more than this many paid audits in one run, however much budget there is. */
    maxAuditsPerRun: 10,
    /** Measured runs needed before sizing switches from the estimate to real averages. */
    measuredRunsBeforeResize: 3,
  },
} as const;
