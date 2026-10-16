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
  /** Instagram profiles found on Google (via Serper) with the follower count read from the snippet — free pre-filter. */
  'IG_GOOGLE',
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
  /** Taken out of the pipeline (e.g. the pre-fresh-start batch). See Creator.doNotContact. */
  'RETIRED',
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
  /** Pending message withdrawn before it went out (e.g. its creator was retired). Never sent. */
  'CANCELLED',
] as const;

/**
 * Fresh start: every creator found before this date was retired (status
 * RETIRED). Anyone who had been sent a message is doNotContact forever;
 * the rest may come back only if a new search rediscovers them.
 */
export const FRESH_START = { date: '2026-10-15', reason: 'pre-fresh-start batch' } as const;
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
 * free/cheap stage-1 checks. Profile (1 result) + posts + comments on the top 8
 * posts by comment count (that's where the audience asks for things).
 * Raised 2026-10-16 from 3×20 (79 results ≈ $0.18) to 8×20 so audits see a
 * problem repeat across posts, closer to YouTube's 300-comment depth:
 * 1 + 18 + 8×20 = 179 results ≈ $0.41 at the Starter-tier $0.0023/result.
 */
export const INSTAGRAM_AUDIT = {
  posts: 18,
  commentPosts: 8,
  commentsPerPost: 20,
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
/**
 * The one test every niche must pass: the audience is LEARNING A SKILL and
 * getting STUCK — not watching for entertainment, lifestyle or inspiration.
 */
export const NICHE_SKILL_TEST =
  'Would a beginner in this niche search YouTube for help when something goes wrong? If yes, accept. If no, reject.';

/**
 * Hard reject: niches whose audience is mainly watching for entertainment,
 * lifestyle or inspiration. Checked in code against a niche's name, category
 * and search terms — when generated and again before any search runs — and
 * given to the generator. Not exhaustive: the generator also applies
 * NICHE_SKILL_TEST to anything similar.
 */
export const NICHE_REJECT: ReadonlyArray<{ type: string; match: RegExp }> = [
  { type: 'Van life, travel vlogs, couple vlogs, solo travel diaries', match: /\bvan ?life\b|\brv life\b|\bfull[- ]time rv\b|\btravel (vlog|diar|stor)|\bcouples? vlog|\bsolo (female )?(travel|touring|trip)|\bmotorcycle touring\b|\bdigital nomad|\broad ?trip|\bbackpacking (vlog|diar|stor)/i },
  { type: 'Fitness motivation, gym transformation, body progress vlogs', match: /\bfitness motivation|\bgym (motivation|transformation|vlog)|\b(body|fitness|weight ?loss) (transformation|progress)|\bbody progress\b/i },
  { type: 'Day-in-my-life, morning routine lifestyle', match: /\bday in (my|the) life\b|\bditl\b|\bmorning routine\b|\bnight routine\b|\blifestyle vlog|\bthat girl\b|\baesthetic routine/i },
  { type: 'Storytime, reaction videos, commentary channels', match: /\bstory ?time\b|\breaction (video|channel)s?\b|\breacts?\b|\breacting to\b|\bcommentary\b|\bdrama (channel|recap)/i },
  { type: 'Music performance, comedy skits', match: /\bmusic performance|\bcover songs?\b|\bsinging covers?\b|\blive performance|\bcomedy\b|\bskits?\b|\bprank/i },
  { type: 'Relationship advice vlogs, dating life content', match: /\brelationship (advice|vlog|goals)|\bdating (life|advice|vlog|stor)|\bcouple goals\b/i },
  { type: 'Food review channels (eating food, not making it)', match: /\bfood review|\brestaurant review|\bmukbang\b|\btaste test|\beating (show|challenge)|\bfast food review/i },
  { type: 'Vlogs of any kind (watching someone live, not learning a skill)', match: /\bvlogs?\b|\bvlogging\b/i },
];

/** Which reject type a niche/term falls under, or null if it may run. */
export function nicheRejectReason(text: string): string | null {
  return NICHE_REJECT.find((r) => r.match.test(text))?.type ?? null;
}

/**
 * Approved directions for the generator — a starting point, NOT a limit. Any
 * niche in any category passes if NICHE_SKILL_TEST does (woodworking, pottery,
 * aquarium keeping, calligraphy, beekeeping, car detailing, electronics repair,
 * dog training, horse care, amateur astronomy…).
 */
export const NICHE_APPROVED_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  'Food & Fermentation': ['sourdough bread baking', 'kombucha brewing', 'home cheesemaking', 'kimchi and fermentation', 'cake decorating for beginners', 'fresh pasta from scratch', 'home canning and preserving', 'bread baking troubleshooting'],
  'Plants & Growing': ['houseplant care for beginners', 'succulent propagation', 'bonsai for beginners', 'vegetable gardening from seed', 'hydroponics at home', 'composting', 'orchid care and reblooming'],
  'Hair & Beauty': ['4c natural hair care', 'loc maintenance and growth', 'twist-out techniques', 'curly hair method (CGM)', 'DIY hair growth routines', 'skincare for eczema-prone skin', 'hyperpigmentation treatments', 'acne skincare routines'],
  'Crafts & Making': ['watercolour painting for beginners', 'embroidery and cross-stitch', 'crochet for beginners', 'knitting for beginners', 'leather crafting', 'soy candle making', 'resin art', 'sewing for beginners', 'macramé'],
  'Music & Language': ['fingerstyle guitar for beginners', 'self-teaching piano', 'music production and beat making', 'learning Korean for beginners', 'learning Japanese for beginners', 'learning Arabic for beginners', 'accent reduction'],
  'Health & Body': ['posture correction exercises', 'pelvic floor recovery', 'managing PCOS naturally', 'hypothyroid diet and lifestyle', 'IBS management', 'meal prep for specific diets'],
  'Home & Finance': ['cash envelope budgeting', 'sinking fund system', 'credit score repair', 'thrift store flipping', 'home organization methods', 'decluttering systems'],
  'Tech Skills': ['Notion setup for beginners', 'Excel for non-technical people', 'CapCut video editing', 'DaVinci Resolve for beginners', 'Procreate digital art', '3D printing troubleshooting'],
};

export const NICHE_LIBRARY = {
  /** Directions, not limits — every category is a place people learn a skill and get stuck. */
  categories: [
    ...Object.keys(NICHE_APPROVED_EXAMPLES),
    'woodworking & DIY', 'pottery & ceramics', 'pets & animal training', 'cars & repair', 'electronics',
    'outdoors skills', 'study skills', 'small business skills', 'parenting skills', 'hobbies',
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
  /** Brand-new YouTube creators the pipeline may add per calendar day (free API — raised from 5 on 2026-10-15). */
  dailyNewCreatorCap: 20,
  /** YouTube searches per day at most (100 quota units each of the 10,000/day; channel/video lookups use the rest). */
  youtubeSearchesPerDay: 40,
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
      /** Gerald's original planning number for one audit — what the 3-run report compares against. Sizing uses the INSTAGRAM_AUDIT formula until runs are measured. */
      auditUsd: 0.36,
      /** Stage-1 profiles checked per creator who qualifies (a guess until measured). */
      profilesPerQualified: 20,
    },
    /**
     * Which search kinds Instagram discovery uses. IG_GOOGLE (Google/Serper pre-filter by
     * snippet follower count, then one batched Apify confirm) since 2026-10-15: hashtags
     * only return the newest posts (from tiny accounts), similar-accounts lists come back
     * empty from this actor, and keyword account search mostly returns nothing. Those
     * terms stay in the library, unused, in case that changes.
     */
    discoveryKinds: ['IG_GOOGLE'],
    /** Never more than this many paid audits in one run, however much budget there is. */
    maxAuditsPerRun: 10,
    /** Measured runs needed before sizing switches from the estimate to real averages. */
    measuredRunsBeforeResize: 3,
    /**
     * Per-audit cost is averaged only over runs on or after this day (PipelineRun.day) —
     * INSTAGRAM_AUDIT went from 3 to 8 comment posts on 2026-10-16, so older audits
     * ($0.17) would undersize the ceiling check. Until 3 runs since then, the formula is used.
     */
    auditCostSince: '2026-10-16',
  },
} as const;
