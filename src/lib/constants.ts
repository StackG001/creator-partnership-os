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
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

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
