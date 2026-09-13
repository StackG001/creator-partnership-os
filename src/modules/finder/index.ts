import type { Creator } from '@prisma/client';

export interface FinderOptions {
  platform: 'INSTAGRAM' | 'YOUTUBE' | 'BOTH';
  query?: string;
  niche?: string;
  sourceId?: string;
  limit: number;
  minFollowers: number;
  maxFollowers: number;
  minEngagement: number;
  dryRun?: boolean;
}

export interface FinderResult {
  sourceId: string;
  found: number;
  qualified: number;
  created: Creator[];
  skipped: Array<{ handle: string; reason: string }>;
}

/**
 * Pull candidates from a discovery source, apply the qualification window
 * (follower range, engagement floor, no existing digital product), and upsert
 * them as Creators with status DISCOVERED.
 */
export async function findCreators(_options: FinderOptions): Promise<FinderResult> {
  throw new Error('finder: not implemented yet');
}
