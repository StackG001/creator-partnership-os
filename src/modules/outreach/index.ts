import type { OutreachChannel } from '../../lib/constants.js';

export interface OutreachDraft {
  channel: OutreachChannel;
  sequence: number;
  variant: string;
  subject?: string;
  body: string;
  hooks: string[];
}

/**
 * Drafts messages grounded in the audit — specific posts, specific audience
 * pains, the specific product angle. Saves OutreachMessage rows with status
 * DRAFT; nothing is ever sent automatically.
 */
export async function draftOutreach(
  _handle: string,
  _channel: OutreachChannel,
  _sequence = 1,
  _variants = 2,
): Promise<OutreachDraft[]> {
  throw new Error('outreach: not implemented yet');
}
