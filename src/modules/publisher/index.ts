export interface PublishResult {
  launchId: string;
  url: string;
  checkoutUrl: string;
  externalProductId: string;
  revShareCreatorPct: number;
}

export interface LaunchStats {
  launchId: string;
  visits: number;
  checkouts: number;
  sales: number;
  revenueCents: number;
}

/**
 * Creates the Whop product, plans (core + bump + upsell) and checkout link,
 * then records a Launch row. --dry-run prints the payload without calling Whop.
 */
export async function publishLaunch(
  _handle: string,
  _revShareCreatorPct: number,
): Promise<PublishResult> {
  throw new Error('publisher: not implemented yet');
}

/** Pulls current numbers for every LIVE launch back into the database. */
export async function syncLaunchStats(): Promise<LaunchStats[]> {
  throw new Error('publisher: not implemented yet');
}
