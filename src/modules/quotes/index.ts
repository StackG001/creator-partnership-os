import fs from 'node:fs/promises';
import path from 'node:path';
import type { Quote } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import { creatorDir, normalizeHandle } from '../../lib/paths.js';
import type { QuoteAuthor, QuoteOrigin } from '../../lib/constants.js';
import {
  isVerbatimIn,
  normalizeQuoteText,
  originForPlatform,
  placeholderIn,
  quoteProblems,
  QuoteSourceError,
  refreshReviewFlag,
  resolveAuditQuotes,
  saveQuote,
} from '../../lib/quotes.js';

const log = createLogger('quotes');

async function creatorByHandle(handleOrUrl: string) {
  const handle = normalizeHandle(handleOrUrl);
  const creator = await prisma.creator.findUnique({ where: { handle } });
  if (!creator) throw new Error(`No creator found for handle "${handle}".`);
  return creator;
}

/** "creator" → their own caption; "@name" / "name" → a named follower's comment. */
export function parseAuthor(raw: string): { authorType: QuoteAuthor; authorHandle: string | null; handleUnknown?: boolean } {
  const value = raw.trim();
  if (/^(creator|caption|own|self)$/i.test(value)) return { authorType: 'CREATOR_CAPTION', authorHandle: null };
  // A follower whose handle wasn't recorded — saved, but blocked until --fix adds the handle.
  if (/^follower$/i.test(value)) return { authorType: 'FOLLOWER_COMMENT', authorHandle: null, handleUnknown: true };
  if (!value) throw new QuoteSourceError('--author is empty — pass "creator" or the follower\'s @handle.');
  return { authorType: 'FOLLOWER_COMMENT', authorHandle: value };
}

function parseDate(raw: string | undefined): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`--found "${raw}" is not a date (use YYYY-MM-DD).`);
  return d;
}

// --- check ------------------------------------------------------------------------------

export interface FlaggedCreator {
  handle: string;
  displayName: string | null;
  status: string;
  reason: string;
  quotes: Array<{ id: string; text: string; problems: string[]; origin: string; foundAt: Date | null }>;
  placeholders: Array<{ field: string; label: string }>;
  pendingMessages: number;
  sentMessages: number;
}

/** Re-check every creator, set/clear review flags, and return the ones that need a human. */
export async function checkAllCreators(): Promise<{ checked: number; flagged: FlaggedCreator[] }> {
  const creators = await prisma.creator.findMany({ orderBy: { createdAt: 'asc' } });
  const flagged: FlaggedCreator[] = [];
  for (const creator of creators) {
    const status = await refreshReviewFlag(creator);
    if (!status.blocked.length && !status.placeholders.length) continue;
    const fresh = await prisma.creator.findUniqueOrThrow({ where: { id: creator.id } });
    const [pendingMessages, sentMessages] = await Promise.all([
      prisma.outreachMessage.count({ where: { creatorId: creator.id, status: { in: ['DRAFT', 'APPROVED'] } } }),
      prisma.outreachMessage.count({ where: { creatorId: creator.id, sentAt: { not: null } } }),
    ]);
    flagged.push({
      handle: creator.handle,
      displayName: creator.displayName,
      status: creator.status,
      reason: fresh.reviewFlag ?? '',
      quotes: status.blocked.map(({ quote, problems }) => ({
        id: quote.id,
        text: quote.text,
        problems,
        origin: quote.origin,
        foundAt: quote.foundAt,
      })),
      placeholders: status.placeholders,
      pendingMessages,
      sentMessages,
    });
  }
  return { checked: creators.length, flagged };
}

// --- add / fix / drop / list ------------------------------------------------------------------

export interface AddQuoteInput {
  handle: string;
  text: string;
  url?: string;
  author?: string;
  fullText?: string;
  trimmed?: boolean;
  origin: QuoteOrigin;
  found?: string;
  pain?: string;
}

export async function addQuote(input: AddQuoteInput): Promise<Quote> {
  if (!input.url) {
    throw new QuoteSourceError(
      'No source URL — ask Gerald for the link to the post this quote is from before saving it. Nothing was saved.',
    );
  }
  if (!input.author) {
    throw new QuoteSourceError('--author is required: "creator" for their own caption, or the follower\'s @handle.');
  }
  const creator = await creatorByHandle(input.handle);
  const quote = await saveQuote({
    creatorId: creator.id,
    text: input.text,
    sourceUrl: input.url,
    ...parseAuthor(input.author),
    foundAt: parseDate(input.found),
    origin: input.origin,
    fullText: input.fullText ?? null,
    ...(input.trimmed ? { isTrimmed: true } : {}),
    pain: input.pain ?? null,
  });
  await refreshReviewFlag(creator);
  return quote;
}

/** Give an existing (usually hand-seeded) quote its missing source details. */
export async function fixQuote(
  id: string,
  patch: { url?: string; author?: string; found?: string; trimmed?: boolean; fullText?: string; text?: string },
): Promise<Quote> {
  const quote = await prisma.quote.findUnique({ where: { id }, include: { creator: true } });
  if (!quote) throw new Error(`No quote with id "${id}".`);
  // Word for word: the (new) text must appear exactly in the full text it claims to come from.
  const text = patch.text ?? quote.text;
  const fullText = patch.fullText ?? quote.fullText;
  if (fullText && !isVerbatimIn(text, fullText)) {
    throw new QuoteSourceError(`Quote text is not word for word in the full text — nothing changed.\n  text: "${text}"\n  full: "${fullText}"`);
  }
  const isTrimmed = patch.trimmed || (fullText ? normalizeQuoteText(text) !== normalizeQuoteText(fullText) : quote.isTrimmed);
  if (patch.url !== undefined && !/^https?:\/\/\S+$/i.test(patch.url)) {
    throw new QuoteSourceError(`"${patch.url}" is not a URL — ask Gerald for the post link.`);
  }
  const { handleUnknown: _unused, ...author } = patch.author ? parseAuthor(patch.author) : {};
  const updated = await prisma.quote.update({
    where: { id },
    data: {
      ...(patch.url ? { sourceUrl: patch.url } : {}),
      ...author,
      ...(patch.found ? { foundAt: parseDate(patch.found) } : {}),
      ...(patch.text ? { text: patch.text } : {}),
      isTrimmed,
      ...(patch.fullText ? { fullText: patch.fullText } : {}),
    },
  });
  await refreshReviewFlag(quote.creator);
  return updated;
}

export async function dropQuote(id: string): Promise<{ handle: string; text: string }> {
  const quote = await prisma.quote.findUnique({ where: { id }, include: { creator: true } });
  if (!quote) throw new Error(`No quote with id "${id}".`);
  await prisma.quote.delete({ where: { id } });
  await refreshReviewFlag(quote.creator);
  return { handle: quote.creator.handle, text: quote.text };
}

export async function listQuotes(handle: string): Promise<Array<Quote & { problems: string[] }>> {
  const creator = await creatorByHandle(handle);
  const quotes = await prisma.quote.findMany({ where: { creatorId: creator.id }, orderBy: { createdAt: 'asc' } });
  return quotes.map((q) => ({ ...q, problems: quoteProblems(q) }));
}

// --- one-time backfill of data saved before the quote rules -------------------------------------

export interface BackfillResult {
  auditQuotes: Array<{ handle: string; saved: number; dropped: Array<{ quote: string; reason: string }> }>;
  legacyQuotes: string[];
  biosCleaned: Array<{ handle: string; removed: string }>;
}

/**
 * Idempotent. (1) Traces each creator's latest audit quotes back to their
 * post URL/author through outputs/<handle>/research/raw.json. (2) Turns
 * hand-seeded quotes (Creator.raw.quote) into Quote rows with what's known —
 * no URL, so they stay blocked until fixed. (3) Moves seeded analysis out of
 * the bio field (it was never the creator's real bio) into contactNotes.
 */
export async function backfill(): Promise<BackfillResult> {
  const result: BackfillResult = { auditQuotes: [], legacyQuotes: [], biosCleaned: [] };
  const creators = await prisma.creator.findMany({
    include: { audits: { orderBy: { createdAt: 'desc' }, take: 1 }, quotes: true },
  });

  for (const creator of creators) {
    // (1) audit quotes
    const audit = creator.audits[0];
    if (audit && !creator.quotes.some((q) => q.auditId === audit.id)) {
      const pains = (audit.raw as { top10Pains?: Array<{ pain: string; quote: string; source: string; postRef: string }> } | null)?.top10Pains;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(creatorDir(creator.handle), 'research', 'raw.json'), 'utf8'));
        if (pains?.length && Array.isArray(raw.posts) && Array.isArray(raw.comments)) {
          const { resolved, dropped } = resolveAuditQuotes(pains, raw);
          for (const q of resolved) {
            await saveQuote({
              ...q,
              creatorId: creator.id,
              foundAt: audit.createdAt,
              origin: originForPlatform(raw.platform ?? creator.platform),
              auditId: audit.id,
            });
          }
          result.auditQuotes.push({ handle: creator.handle, saved: resolved.length, dropped });
        }
      } catch (error) {
        log.warn(`@${creator.handle}: audit quotes not traced (${(error as Error).message})`);
      }
    }

    // (2) hand-seeded quotes
    const seeded = creator.raw as { quote?: string; sourcedAt?: string; sourcedBy?: string; quoteSource?: string } | null;
    if (seeded?.quote && !creator.quotes.some((q) => q.origin === 'LEGACY_SEED' && q.text === seeded.quote)) {
      const follower = seeded.quoteSource?.match(/follower comment by (@[\w.]+)/i)?.[1] ?? null;
      await prisma.quote.create({
        data: {
          creatorId: creator.id,
          text: seeded.quote,
          sourceUrl: null,
          authorType: follower ? 'FOLLOWER_COMMENT' : null,
          authorHandle: follower,
          foundAt: seeded.sourcedAt ? new Date(seeded.sourcedAt) : null,
          origin: 'LEGACY_SEED',
          notes: `Hand-sourced by ${seeded.sourcedBy ?? 'Gerald'}${seeded.sourcedAt ? ` ${seeded.sourcedAt}` : ''}; no post link was recorded.${seeded.quoteSource ? ` Source note: ${seeded.quoteSource}` : ''}`,
        },
      });
      result.legacyQuotes.push(creator.handle);
    }

    // (3) seeded text in the bio
    if (creator.bio && placeholderIn(creator.bio)) {
      const analysis = creator.bio.replace(/\s*Recent audience comment\s*:[\s\S]*$/i, '').trim();
      const note = analysis
        ? `Vetting note (moved out of the bio field 2026-10-13 — it was written during seeding, not the creator's bio): ${analysis}`
        : null;
      await prisma.creator.update({
        where: { id: creator.id },
        data: {
          bio: null,
          contactNotes: note ? [creator.contactNotes, note].filter(Boolean).join('\n') : creator.contactNotes,
        },
      });
      result.biosCleaned.push({ handle: creator.handle, removed: creator.bio });
    }
  }
  return result;
}
