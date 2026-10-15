import type { Creator, Quote } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { createLogger } from './logger.js';
import { QUOTE_AUTHORS, QUOTE_ORIGINS, type QuoteAuthor, type QuoteOrigin } from './constants.js';

/**
 * Quote sourcing rules (see CLAUDE.md, "Quote sourcing"). Every quote saved
 * for a creator stores its post URL, who wrote it (the creator's own caption
 * or a named follower's comment) and the date it was found. Quotes are word
 * for word; a trimmed quote is stored as trimmed and never presented as the
 * full comment. A quote missing any of that can't be used in a draft — the
 * drafting, approve and send steps refuse and flag the creator for review.
 */

const log = createLogger('quotes');

export class QuoteSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteSourceError';
  }
}

// --- text matching ------------------------------------------------------------------

/** Only typography and whitespace are normalised — never words or punctuation. */
export function normalizeQuoteText(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const ELLIPSIS = /\s*(?:…|\.\.\.)\s*/;

/**
 * True when `quote` appears word for word in `source`. An ellipsis in the
 * quote marks a cut: each piece must appear, in order.
 */
export function isVerbatimIn(quote: string, source: string): boolean {
  const haystack = normalizeQuoteText(source);
  let from = 0;
  const pieces = normalizeQuoteText(quote).split(ELLIPSIS).filter(Boolean);
  if (!pieces.length) return false;
  for (const piece of pieces) {
    const at = haystack.indexOf(piece, from);
    if (at === -1) return false;
    from = at + piece.length;
  }
  return true;
}

// --- placeholder text in real fields ----------------------------------------------------

const PLACEHOLDER_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /recent audience comment\s*:/i, label: 'seeded "Recent audience comment:" text' },
  { pattern: /\[(?:name|first name|todo|tbd|placeholder|insert[^\]]*)\]/i, label: 'bracketed placeholder' },
  { pattern: /\b(?:TODO|TBD)\b|lorem ipsum|\bplaceholder\b/i, label: 'placeholder marker' },
  { pattern: /^\s*(?:…|\.\.\.)\s*$/, label: 'bare ellipsis' },
];

/** Creator fields that must only ever hold the creator's real data. */
export const REAL_FIELDS = ['displayName', 'bio', 'niche', 'subNiche', 'contactEmail', 'businessEmail'] as const;

export function placeholderIn(value: string | null | undefined): string | null {
  if (!value) return null;
  return PLACEHOLDER_PATTERNS.find(({ pattern }) => pattern.test(value))?.label ?? null;
}

/** Throws if any real field is about to be written with placeholder text. */
export function assertNoPlaceholders(fields: Partial<Record<(typeof REAL_FIELDS)[number], string | null | undefined>>): void {
  for (const [field, value] of Object.entries(fields)) {
    const hit = placeholderIn(value);
    if (hit) throw new QuoteSourceError(`Refusing to write ${hit} into the creator's ${field} field: "${String(value).slice(0, 80)}"`);
  }
}

// --- what makes a quote usable ---------------------------------------------------------

export function quoteProblems(q: Pick<Quote, 'sourceUrl' | 'authorType' | 'authorHandle' | 'foundAt'>): string[] {
  const problems: string[] = [];
  if (!q.sourceUrl) problems.push('no source URL');
  if (!q.authorType) problems.push("author unknown (creator's caption or a follower's comment?)");
  else if (q.authorType === 'FOLLOWER_COMMENT' && !q.authorHandle) problems.push('follower comment with no named follower');
  if (!q.foundAt) problems.push('no date found');
  return problems;
}

export function describeAuthor(q: Pick<Quote, 'authorType' | 'authorHandle'>): string {
  if (q.authorType === 'CREATOR_CAPTION') return "the creator's own caption";
  if (q.authorType === 'FOLLOWER_COMMENT') return `a follower's comment${q.authorHandle ? ` (${q.authorHandle})` : ''}`;
  return 'unknown author';
}

// --- quotes inside a draft ---------------------------------------------------------------

// Straight, curly and «guillemet» quotes all count — a draft can't dodge the check by switching marks.
// Paired marks (“…”, «…», „…“) are read first and may contain straight quotes — a comment that itself
// says "how to" is quoted as “You need to put together a "how to" guide…”. Straight "…" pairs are
// then read from what's left, so the inner marks are never mistaken for the end of the quote.
const PAIRED_SPAN = /\u201C([^\u201C\u201D]{4,}?)\u201D|\u00AB([^\u00AB\u00BB]{4,}?)\u00BB|\u201E([^\u201E\u201C\u201D]{4,}?)[\u201C\u201D]/g;
const STRAIGHT_SPAN = /"([^"\u201C\u201D\u00AB\u00BB]{4,}?)"/g;

/** Quoted spans of 2+ words in a message — what counts as quoting someone (a lone word like 'yes' does not). */
export function quotedSpansIn(text: string): string[] {
  const spans: string[] = [];
  const rest = text.replace(PAIRED_SPAN, (_m, a, b, c) => {
    spans.push(a ?? b ?? c ?? '');
    return ' ';
  });
  for (const [, span] of rest.matchAll(STRAIGHT_SPAN)) spans.push(span ?? '');
  return spans.filter((span) => span.trim().split(/\s+/).length >= 2);
}

/**
 * Problems with how a draft quotes people: every quoted span (3+ words) must
 * be word for word from one of the creator's usable (sourced) quotes, and
 * anything shorter than the full comment/caption must show the cut with "…".
 */
export function misusedQuotesIn(text: string, usable: Quote[]): string[] {
  const issues: string[] = [];
  for (const span of quotedSpansIn(text)) {
    const match = usable.find((q) => isVerbatimIn(span, q.text));
    if (!match) {
      issues.push(
        `"${span}" is not word for word from any sourced quote — copy one of the quotes given exactly, or don't put it in quotation marks`,
      );
      continue;
    }
    // Every cut must be marked where it happens: a quote that starts after the
    // comment's start opens with "…", one that stops before its end closes with "…"
    // (cuts in the middle are marked by construction — that's where it was split).
    const full = normalizeQuoteText(match.fullText ?? match.text);
    const quoted = normalizeQuoteText(span);
    const pieces = quoted.split(ELLIPSIS).filter(Boolean);
    const kind = match.authorType === 'FOLLOWER_COMMENT' ? 'comment' : 'caption';
    if (pieces.length && !full.startsWith(pieces[0]!) && !/^(?:…|\.\.\.)/.test(quoted)) {
      issues.push(`"${span}" starts partway through the original ${kind} — open the quote with "…" to mark the cut`);
    }
    if (pieces.length && !full.endsWith(pieces[pieces.length - 1]!) && !/(?:…|\.\.\.)$/.test(quoted)) {
      issues.push(`"${span}" stops before the end of the original ${kind} — close the quote with "…" to mark the cut, so it isn't presented as the full text`);
    }
  }
  return issues;
}

// --- saving ------------------------------------------------------------------------------

const SaveQuoteSchema = z
  .object({
    creatorId: z.string(),
    text: z.string().trim().min(1, 'quote text is empty'),
    sourceUrl: z
      .string({ error: 'No source URL — ask Gerald for the post link before saving this quote.' })
      .url('source URL is not a valid URL — ask Gerald for the post link.'),
    authorType: z.enum(QUOTE_AUTHORS),
    authorHandle: z.string().trim().min(1).nullish(),
    /** A follower comment whose author wasn't recorded: saved, but stays blocked until the handle is added. */
    handleUnknown: z.boolean().optional(),
    foundAt: z.date(),
    origin: z.enum(QUOTE_ORIGINS),
    fullText: z.string().nullish(),
    isTrimmed: z.boolean().optional(),
    pain: z.string().nullish(),
    auditId: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .superRefine((q, ctx) => {
    if (q.authorType === 'FOLLOWER_COMMENT' && !q.authorHandle && !q.handleUnknown) {
      ctx.addIssue({ code: 'custom', message: "a follower's comment needs the follower's handle/name (--author @handle)" });
    }
    if (q.fullText && !isVerbatimIn(q.text, q.fullText)) {
      ctx.addIssue({ code: 'custom', message: 'quote is not word for word from the full text given' });
    }
    if (placeholderIn(q.text)) ctx.addIssue({ code: 'custom', message: 'quote text is a placeholder' });
  });

export type SaveQuoteInput = z.input<typeof SaveQuoteSchema>;

/**
 * The only way a quote gets saved. Refuses anything without a source URL,
 * author and date. `isTrimmed` is worked out from `fullText` when given; a
 * caller that knows the quote was cut but doesn't have the full text passes
 * isTrimmed: true.
 */
export async function saveQuote(input: SaveQuoteInput): Promise<Quote> {
  const parsed = SaveQuoteSchema.safeParse(input);
  if (!parsed.success) {
    throw new QuoteSourceError(`Quote not saved: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const q = parsed.data;
  const isTrimmed =
    q.isTrimmed ?? (q.fullText ? normalizeQuoteText(q.text) !== normalizeQuoteText(q.fullText) : false);
  return prisma.quote.create({
    data: {
      creatorId: q.creatorId,
      text: q.text,
      isTrimmed,
      fullText: q.fullText ?? null,
      sourceUrl: q.sourceUrl,
      authorType: q.authorType,
      authorHandle: q.authorType === 'FOLLOWER_COMMENT' ? (q.authorHandle ?? null) : null,
      foundAt: q.foundAt,
      origin: q.origin,
      pain: q.pain ?? null,
      auditId: q.auditId ?? null,
      notes: q.notes ?? null,
    },
  });
}

// --- quotes from an audit ----------------------------------------------------------------

interface RawPost {
  ref: string;
  url: string;
  caption: string;
}
interface RawComment {
  postRef: string;
  text: string;
  author: string;
}
interface AuditPain {
  pain: string;
  quote: string;
  source: string;
  postRef: string;
}

/**
 * Resolve each audit pain quote to the post it really came from, by matching
 * the text against the fetched captions/comments (the model's own source
 * label and post ref are only a hint). Quotes that aren't word for word in
 * any of them are dropped, never saved.
 */
export function resolveAuditQuotes(
  pains: AuditPain[],
  raw: { posts: RawPost[]; comments: RawComment[] },
  /** The creator's own handle/display name — their replies in the comments are their words, not the audience's. */
  creatorNames: string[] = [],
): { resolved: Array<Omit<SaveQuoteInput, 'creatorId' | 'foundAt' | 'origin'>>; dropped: Array<{ quote: string; reason: string }> } {
  const resolved: Array<Omit<SaveQuoteInput, 'creatorId' | 'foundAt' | 'origin'>> = [];
  const dropped: Array<{ quote: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const p of pains) {
    const key = normalizeQuoteText(p.quote);
    if (seen.has(key)) continue;
    seen.add(key);

    // Prefer the post/kind the model named, then anywhere in the fetch.
    const hinted = raw.posts.find((x) => x.ref === p.postRef);
    const commentMatch = (c: RawComment) => isVerbatimIn(p.quote, c.text);
    const comment =
      raw.comments.find((c) => c.postRef === p.postRef && commentMatch(c)) ?? raw.comments.find(commentMatch);
    const captionPost =
      (hinted && isVerbatimIn(p.quote, hinted.caption) ? hinted : undefined) ??
      raw.posts.find((x) => isVerbatimIn(p.quote, x.caption));

    const useComment = comment && (p.source === 'comment' || !captionPost);
    if (useComment) {
      const post = raw.posts.find((x) => x.ref === comment.postRef);
      if (!post?.url) {
        dropped.push({ quote: p.quote, reason: 'comment found but its post URL is unknown' });
        continue;
      }
      const byCreator = isCreatorName(comment.author, creatorNames);
      resolved.push({
        text: p.quote,
        fullText: comment.text,
        sourceUrl: post.url,
        authorType: byCreator ? 'CREATOR_CAPTION' : 'FOLLOWER_COMMENT',
        authorHandle: byCreator ? null : comment.author || null,
        pain: p.pain,
        ...(byCreator ? { notes: `the creator's own reply in the comments (@${comment.author}), not an audience comment` } : {}),
      });
    } else if (captionPost?.url) {
      resolved.push({
        text: p.quote,
        fullText: captionPost.caption,
        sourceUrl: captionPost.url,
        authorType: 'CREATOR_CAPTION',
        pain: p.pain,
      });
    } else {
      dropped.push({ quote: p.quote, reason: 'not word for word in any fetched caption or comment' });
    }
  }
  return { resolved, dropped };
}

function squashName(t: string): string {
  return t.normalize('NFKC').toLowerCase().replace(/^@/, '').replace(/[^\p{L}\p{N}]/gu, '');
}

/** Whether a comment author is the creator themself (handle or display name, ignoring case/punctuation). */
export function isCreatorName(author: string | null | undefined, creatorNames: string[]): boolean {
  if (!author) return false;
  const a = squashName(author);
  return Boolean(a) && creatorNames.some((n) => n && squashName(n) === a);
}

// --- review status --------------------------------------------------------------------------

export interface CreatorQuoteStatus {
  usable: Quote[];
  blocked: Array<{ quote: Quote; problems: string[] }>;
  placeholders: Array<{ field: string; label: string }>;
}

export async function quoteStatus(creator: Creator): Promise<CreatorQuoteStatus> {
  const quotes = await prisma.quote.findMany({ where: { creatorId: creator.id }, orderBy: { createdAt: 'asc' } });
  const usable: Quote[] = [];
  const blocked: CreatorQuoteStatus['blocked'] = [];
  for (const q of quotes) {
    const problems = quoteProblems(q);
    if (problems.length) blocked.push({ quote: q, problems });
    else usable.push(q);
  }
  const placeholders = REAL_FIELDS.flatMap((field) => {
    const label = placeholderIn(creator[field]);
    return label ? [{ field, label }] : [];
  });
  return { usable, blocked, placeholders };
}

function reviewReason(status: CreatorQuoteStatus): string | null {
  const parts: string[] = [];
  if (status.blocked.length) {
    parts.push(
      `${status.blocked.length} quote(s) unusable: ${[...new Set(status.blocked.flatMap((b) => b.problems))].join(', ')}`,
    );
  }
  if (status.placeholders.length) {
    parts.push(`placeholder text in ${status.placeholders.map((p) => p.field).join(', ')}`);
  }
  return parts.length ? `${parts.join('; ')} — fix or drop with \`npm run quotes\`` : null;
}

/** Set or clear the creator's review flag from their current quotes/fields. Returns the status. */
export async function refreshReviewFlag(creator: Creator): Promise<CreatorQuoteStatus> {
  const status = await quoteStatus(creator);
  const reason = reviewReason(status);
  if (reason !== creator.reviewFlag) {
    await prisma.creator.update({
      where: { id: creator.id },
      data: { reviewFlag: reason, reviewFlaggedAt: reason ? new Date() : null },
    });
    if (reason) log.warn(`@${creator.handle} flagged for review: ${reason}`);
    else log.info(`@${creator.handle} review flag cleared`);
  }
  return status;
}

/**
 * Gate for drafting, approving and sending. Refuses — and flags the creator
 * for review — instead of letting anything be written around a bad quote.
 */
export async function assertClearForOutreach(
  creator: Creator,
  step: string,
  options: { quoteFree?: boolean } = {},
): Promise<CreatorQuoteStatus> {
  const status = await refreshReviewFlag(creator);
  // A message that quotes nobody (a seq-3 closing note) can't misuse a quote, so
  // only placeholder text in real fields blocks it. The flag itself stays set.
  const reason = reviewReason(options.quoteFree ? { ...status, blocked: [] } : status);
  if (reason) {
    throw new QuoteSourceError(
      `@${creator.handle} is flagged for review, so ${step} is refused: ${reason}.`,
    );
  }
  return status;
}

export function originForPlatform(platform: string): QuoteOrigin {
  return platform === 'INSTAGRAM' ? 'APIFY_AUDIT' : 'YOUTUBE_AUDIT';
}

export type { QuoteAuthor };
