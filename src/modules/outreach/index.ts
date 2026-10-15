import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { getEnv } from '../../lib/env.js';
import { normalizeHandle, toRelative, writeArtifact } from '../../lib/paths.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertClearForOutreach,
  describeAuthor,
  isVerbatimIn,
  misusedQuotesIn,
  quoteStatus,
  quotedSpansIn,
  QuoteSourceError,
} from '../../lib/quotes.js';
import fs from 'node:fs/promises';
import { isSensitiveNiche, productLineFlags, SENSITIVE_PRODUCT_RULE } from '../../lib/productLine.js';
import type { Prisma, Quote } from '@prisma/client';
import {
  FOLLOW_UP,
  OUTREACH_SENDER,
  type CreatorStatus,
  type OutreachChannel,
  type OutreachStatus,
} from '../../lib/constants.js';

const log = createLogger('outreach');

export interface OutreachDraft {
  channel: OutreachChannel;
  sequence: number;
  variant: string;
  to: string | null;
  subject?: string;
  body: string;
  hooks: string[];
}

export interface OutreachResult {
  handle: string;
  drafts: OutreachDraft[];
}

// --- audit shape we read back out of Audit.raw --------------------------------
// (mirrors src/modules/audit/index.ts's AuditReport — kept minimal/loose here
// since this module only reads fields it needs, not the full contract.)

interface AuditEvidence {
  niche: string;
  audiencePersona: { who: string; situation: string; triedAlready: string };
  top10Pains: Array<{ pain: string; quote: string; source: string; postRef: string }>;
  voiceGuide: {
    toneAdjectives: string[];
    signaturePhrases: string[];
    opensWith: string;
    closesWith: string;
  };
  productOpportunities: Array<{
    title: string;
    promise: string;
    whoItsFor: string;
    score: number;
    priceBand: string;
    recommended: boolean;
  }>;
  hookLines: string[];
  partnershipPitchAngle: string;
  socialLinks?: { businessEmail: string | null };
}

const AuditEvidenceSchema = z.object({
  niche: z.string(),
  audiencePersona: z.object({ who: z.string(), situation: z.string(), triedAlready: z.string() }),
  top10Pains: z.array(
    z.object({ pain: z.string(), quote: z.string(), source: z.string(), postRef: z.string() }),
  ),
  voiceGuide: z.object({
    toneAdjectives: z.array(z.string()),
    signaturePhrases: z.array(z.string()),
    opensWith: z.string(),
    closesWith: z.string(),
  }),
  productOpportunities: z.array(
    z.object({
      title: z.string(),
      promise: z.string(),
      whoItsFor: z.string(),
      score: z.number(),
      priceBand: z.string(),
      recommended: z.boolean(),
    }),
  ),
  hookLines: z.array(z.string()),
  partnershipPitchAngle: z.string(),
  socialLinks: z.object({ businessEmail: z.string().nullable() }).optional(),
});

async function loadAuditEvidence(creatorId: string): Promise<AuditEvidence> {
  const audit = await prisma.audit.findFirst({
    where: { creatorId },
    orderBy: { createdAt: 'desc' },
  });
  if (!audit) {
    throw new Error(
      `No audit found for this creator — run \`npm run audit -- --handle <handle>\` first.`,
    );
  }
  const parsed = AuditEvidenceSchema.safeParse(audit.raw);
  if (!parsed.success) {
    throw new Error(
      `Audit for this creator exists but its stored data doesn't match the expected shape — re-run the audit. (${parsed.error.issues[0]?.message})`,
    );
  }
  return parsed.data;
}

// --- do not contact ---------------------------------------------------------------

/** Retired or doNotContact creators get nothing from this system — no draft, approval, send or DM. */
export function contactBlock(creator: { handle: string; status: string; doNotContact: boolean; retiredReason?: string | null }): string | null {
  if (creator.doNotContact) return `@${creator.handle} is do-not-contact (${creator.retiredReason ?? 'retired'}) — never contact again`;
  if (creator.status === 'RETIRED') return `@${creator.handle} is retired (${creator.retiredReason ?? 'no reason'})`;
  return null;
}

function assertContactable(creator: Parameters<typeof contactBlock>[0], step: string): void {
  const block = contactBlock(creator);
  if (block) throw new Error(`${step} refused: ${block}.`);
}

// --- drafting -------------------------------------------------------------------

// Phrases that claim work already exists. Nothing is built before a creator
// says yes, so a draft containing any of these fails validation and
// completeJSON sends it back to the model to rewrite.
const BANNED_CLAIMS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\balready\s+(drafted|sketched|started|built|made|put together|written|mocked|outlined|designed|created|working on)\b/i, label: '"already drafted/sketched/started…"' },
  { pattern: /\b(I've|I have|I)\s+(drafted|sketched|put together|mocked up|outlined|built|made|written)\b/i, label: '"I\'ve drafted/sketched/put together…"' },
  { pattern: /\bsend\s+(it|this|that|the \w+)\s+over\b/i, label: '"send it over"' },
  { pattern: /\bready to (send|share|go)\b/i, label: '"ready to send"' },
  { pattern: /(?<!\b(?:I'll|I will|I'd|I can|and I'll)\s)\bsend (you )?the ([\w-]+ )?(outline|concept|draft|guide|mockup)\b/i, label: '"send the outline/concept" (as if it exists)' },
];

// Honesty: no fake deadlines, invented scarcity, invented social proof or
// guilt-tripping — in any message. ("Your audience keeps asking and someone
// else may answer it" is an honest cost of waiting and is allowed.)
const DISHONEST: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(offer|spot|spots|slot|slots|deal|place|places|window)\b[^.?!]{0,25}\b(expires?|expiring|ends|ending|closes|closing|left|remaining)\b/i, label: 'a deadline or scarcity claim' },
  { pattern: /\blimited (spots|slots|places|time|availability|number)\b|\b(last|final) chance\b|\bdeadline\b|\bonly (until|till|this week|today|for the next)\b|\bbefore (it'?s|its) gone\b|\b(first come|act now|hurry)\b/i, label: 'a fake deadline or urgency' },
  { pattern: /\bother creators\b[^.?!]{0,40}\b(said yes|signed|joined|on board|already|agreed|working with)\b|\b(\d+|several|many|a few|a couple of|dozens of) (other )?creators (have )?(already )?(signed|joined|said yes|agreed|on board)\b/i, label: '"other creators already said yes" (not on record)' },
  { pattern: /\byou (never|didn'?t|haven'?t) (replied|responded|answered|got back)\b|\bignor(ed|ing) (me|my)\b|\bi'?m (disappointed|hurt|sad)\b|\bafter all (the|my) (effort|work|time)\b|\bleaving money on the table\b|\byou'?ll regret\b/i, label: 'guilt-tripping' },
];

export function dishonestyIn(text: string): string[] {
  return DISHONEST.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
const COUNTS = ['one', 'two', 'three', 'four', 'five'];

/** A message that counts the notes must count them right: seq 3 is the third, never "the second" or "two notes". */
export function noteCountProblems(text: string, sequence: number): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(/\b(first|second|third|fourth|fifth)\s+(note|message|email|time|touch|follow-?up)\b/gi)) {
    const n = ORDINALS.indexOf(m[1]!.toLowerCase()) + 1;
    // "follow-up" ordinals count follow-ups, not messages
    const isFollowUp = /follow/i.test(m[2]!);
    if (n !== (isFollowUp ? sequence - 1 : sequence)) problems.push(`says "${m[0]}" but this is message ${sequence}`);
  }
  for (const m of text.matchAll(/\b(one|two|three|four|five|[1-5])\s+(notes|messages|emails)\b/gi)) {
    const raw = m[1]!.toLowerCase();
    const n = /\d/.test(raw) ? Number(raw) : COUNTS.indexOf(raw) + 1;
    if (n !== sequence && n !== sequence - 1) problems.push(`says "${m[0]}" but this is message ${sequence}`);
  }
  return problems;
}

/** Audit-internal post labels ("P7", "[P35]") — meaningless to the creator. */
const INTERNAL_REF = /\[?\bP\d{1,3}\b\]?/;

function bannedClaimsIn(text: string): string[] {
  return BANNED_CLAIMS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

const DraftSchema = z.object({
  subject: z.string().nullable().describe('Email subject line. Null for non-email channels.'),
  body: z.string().superRefine((body, ctx) => {
    const hits = bannedClaimsIn(body);
    if (hits.length) {
      ctx.addIssue({
        code: 'custom',
        message: `claims work already exists (${hits.join(', ')}). Nothing has been made yet — rewrite it as a future-tense offer, e.g. "I can put together an outline this week — want me to?"`,
      });
    }
    const dishonest = dishonestyIn(body);
    if (dishonest.length) {
      ctx.addIssue({
        code: 'custom',
        message: `contains ${dishonest.join(', ')}. Every message stays honest: no fake deadlines, no invented scarcity, no "other creators already said yes", no guilt — remove it.`,
      });
    }
    const ref = body.match(INTERNAL_REF);
    if (ref) {
      ctx.addIssue({
        code: 'custom',
        message: `contains the internal post label "${ref[0]}", which means nothing to the creator. Describe the post or comment instead (e.g. "a comment on one of your videos").`,
      });
    }
  }),
  hooksUsed: z
    .array(z.string())
    .min(1)
    .max(4)
    .describe('Which specific pains/hooks/pitch-angle pieces from the evidence this variant leans on.'),
});

function draftsSchemaFor(count: number, quotes: Quote[], sequence: number) {
  // Quote rules need the creator's own sourced quotes, so they're checked per call.
  const draft = DraftSchema.superRefine((d, ctx) => {
    for (const message of misusedQuotesIn(d.body, quotes)) {
      ctx.addIssue({ code: 'custom', path: ['body'], message });
    }
    for (const message of noteCountProblems(d.body, sequence)) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: `${message} — count the notes correctly or don't count them` });
    }
  });
  return z.object({ variants: z.array(draft).length(count) });
}

// The outreach sequence. Every message has one job:
//
//   Seq 1 — state the goal plainly: their audience is already asking for a
//           product (a sourced comment + the BRIDGE line), we build the whole
//           thing, they only make content to promote it and keep 50% of every
//           sale. One yes/no question.
//   Seq 2 — add something NEW: a second sourced audience quote and/or a
//           concrete product idea (title + 3-4 things it would cover), plus a
//           short answer to the most likely objection.
//   Seq 3 — the close: the honest cost of waiting, the easiest possible ask
//           ("reply 'yes' and I'll send the outline"), clearly the last message.
//
// Every message stays honest (see DISHONEST) and never claims anything has
// already been made (BANNED_CLAIMS). DMs follow the same sequence, shorter.

const DM_CHANNELS: ReadonlySet<OutreachChannel> = new Set(['IG_DM', 'X_DM']);

/**
 * How to open the message. The first word of a display name is only a first
 * name when the display name is a person's name — "Princeton Microgreens"
 * must not become "Princeton,". The model decides which it is; it is told
 * never to guess a personal name from commenters, since a wrong name is worse
 * than the channel name.
 */
/**
 * The name part of a display name: everything before the first emoji or
 * separator, so "Chef Agathe 🌱 Quick, Easy, Nutritious Recipes" → "Chef Agathe"
 * and "Karina | Indoor Planting Diary" → "Karina". Fancy unicode letters are
 * folded to plain ones.
 */
export function nameFromDisplayName(displayName: string): string {
  const plain = unspace(displayName.normalize('NFKC'));
  const cut = plain.split(/[|•·:–—,(]|\s-\s|\p{Extended_Pictographic}/u)[0] ?? plain;
  return cut.replace(/\s+/g, ' ').trim() || plain.trim();
}

function addressInstruction(rawDisplayName: string, handle: string): string {
  const displayName = nameFromDisplayName(rawDisplayName);
  return [
    `The creator's display name is "${displayName}" (handle @${handle}).`,
    "If that display name contains a real person's first name, open with that first name (e.g. \"Hi Agathe,\").",
    'If there is no real first name in it (a brand, a channel name, a handle, initials), open with exactly "Hi there," — never a channel name, never one word of a brand name as if it were a name.',
    'Never guess a personal name from comments or quotes, and never build one from the handle/username (e.g. "makayyyy__" is not a name). If unsure, "Hi there,". Never a placeholder like "[Name]".',
  ].join(' ');
}

const SIGN_OFF = `Gerald\n${OUTREACH_SENDER.name} | ${OUTREACH_SENDER.company} | ${OUTREACH_SENDER.email}`;

/**
 * Non-DM messages always end with SIGN_OFF, added here rather than trusted to
 * the model (it drops it). Any sign-off the model wrote anyway — trailing
 * "Gerald" / "— Gerald, iClipmedia" / "… | iClipmedia | …" lines — is stripped
 * first so it never appears twice.
 */
function withSignOff(body: string): string {
  const lines = body.trimEnd().split('\n');
  while (lines.length) {
    const last = lines[lines.length - 1]!.trim();
    if (last === '' || /^[—–-]?\s*Gerald\b/i.test(last) || /\|\s*iClipmedia\s*\|/i.test(last)) lines.pop();
    else break;
  }
  return `${lines.join('\n').trimEnd()}\n\n${SIGN_OFF}`;
}

const CHANNEL_NOTE: Record<OutreachChannel, string> = {
  EMAIL: 'Email. Has a subject line.',
  IG_DM: 'Instagram DM. No subject.',
  YT_ABOUT: 'YouTube "About" page business-inquiry message. No subject.',
  X_DM: 'X (Twitter) DM. No subject.',
  MANUAL: 'Generic first-touch message. No subject.',
};


const SHARED_RULES = [
  'Never claim anything already exists — no "already drafted", "already sketched", "I put together", "ready to send", "want me to send it over". Nothing is made until they say yes; every outline, guide or product is an offer in the future tense.',
  'Stay honest: no fake deadlines, no invented scarcity ("limited spots"), no "other creators already said yes", no guilt-tripping. Never imply a reply is owed.',
  'Never use: "hope this finds you well", "I came across your profile", "I\'d love to", "amazing content", "just following up", "circling back", "checking in", or any other filler phrase.',
  'Every quoted line must be copied verbatim from the quotes given below, inside plain double quotes ("…") — or curly quotes “…” when the quote itself contains double quotes — never invent, merge or tidy a quote, never use «». Show any cut with "…".',
  'Refer to a quote by what it is ("a comment on your sourdough discard video") — never by a label or reference code.',
];

const WE_BUILD = 'we build the whole thing — research, writing, design, sales page and setup';
const THEY_DO = 'they only make content to promote it, and keep 50% of every sale';

function signOffRule(isDm: boolean): string {
  return isDm
    ? `End with exactly this two-line sign-off, nothing after it:\n${SIGN_OFF}`
    : 'Do not write a sign-off or your name at the end — the sign-off is appended automatically after the ask.';
}

interface SystemInput {
  /** Health/medical/mental-health/finance niche: product ideas stay lifestyle/experience guides. */
  sensitive?: boolean;
  address: string;
  isDm: boolean;
  channel: OutreachChannel;
  sequence: number;
  variants: number;
}

/** Seq 1: the goal, stated plainly. */
function buildFirstTouchSystem({ sensitive, address, isDm, channel, variants }: SystemInput): string {
  return [
    ...(sensitive ? [SENSITIVE_PRODUCT_RULE + ' Describe the product that way in this message.'] : []),
    'You write first-touch outreach for Gerald at iClipmedia. Gerald finds creators whose audience is already asking for something they could sell, builds the product for them, and splits the revenue.',
    'This first message states that goal plainly, in this order:',
    '1. HOOK — quote one sourced audience comment word for word and say where it was ("on your video about…"). Pick the comment that most clearly shows demand: a question, a "please make/teach", a struggle the product would solve. A follower\'s comment beats a caption; a comment in the creator\'s main language beats one in another. Never pick a comment that disagrees with the creator.',
    '   BRIDGE — the very next sentence says it speaks for their whole audience, not one person: e.g. "bet you get some version of that every time you post" or "that\'s basically your whole audience in one line." So the opportunity is already there.',
    `2. WHAT WE DO — one or two sentences: ${WE_BUILD}. Name the kind of product in a few words (a guide, a starter kit…).`,
    `3. THEIR PART — ${THEY_DO}. Make clear they never have to worry about the technical side.`,
    '4. ASK — end with exactly one yes/no question ("Want me to put together an outline?" or "Worth a quick reply?"). Nothing after it except the sign-off.',
    isDm
      ? 'This is a DM: same four beats, compressed — it must still read like a person, not a pitch deck.'
      : 'Keep the beats as short, distinct paragraphs — not one run-on block.',
    `Word limit: ${isDm ? 75 : 120} words max. Go under, never over.`,
    ...SHARED_RULES,
    address,
    signOffRule(isDm),
    `Channel: ${CHANNEL_NOTE[channel]}${channel === 'EMAIL' ? ' Subject: short, specific to their audience, no hype.' : ''}`,
    `Write ${variants} genuinely distinct variants — a different HOOK quote each where possible — not paraphrases of each other.`,
  ].join('\n');
}

/** Seq 2: something new, plus the objection answered. */
function buildSecondTouchSystem({ sensitive, address, isDm, channel, variants }: SystemInput): string {
  return [
    ...(sensitive ? [SENSITIVE_PRODUCT_RULE + ' Describe the product that way in this message.'] : []),
    'You write the second message for Gerald at iClipmedia. The first message (shown below) quoted one audience comment and offered to build them a product for a 50% revenue share. No reply yet.',
    'This message must ADD something new — never repeat the first message\'s quote, hook or wording:',
    '1. NEW EVIDENCE — a SECOND sourced audience quote (a different one from the first message, word for word) and/or a concrete product idea specific to their content: a working title plus the 3-4 things it would cover, drawn from what their audience is asking. Phrase it as what it WOULD cover — nothing has been made.',
    '2. OBJECTION — answer the single most likely objection in one or two sentences, without naming it as an objection. "I don\'t have time" → they don\'t build anything; we do all of it and they just post about it. "My audience won\'t pay" → point to the comments asking for exactly this. Pick whichever fits this creator best.',
    `3. Keep the offer clear in one short line: ${WE_BUILD}; ${THEY_DO}.`,
    '4. ASK — end with exactly one yes/no question.',
    'Do not apologise for writing again, and do not say "following up". You may say it is a second note; if you count, count right (this is the second message).',
    'Open exactly the way the first message opened (same name, same form).',
    `Word limit: ${isDm ? 75 : 130} words max.`,
    ...SHARED_RULES,
    address,
    signOffRule(isDm),
    `Channel: ${CHANNEL_NOTE[channel]}${channel === 'EMAIL' ? ' Subject: new, not "Re:" and not the first subject.' : ''}`,
    `Write ${variants} genuinely distinct variants (e.g. one leading with the second quote, one with the product idea).`,
  ].join('\n');
}

/** Seq 3: the close. No new evidence, no quotes. */
function buildCloseSystem({ address, isDm, channel, sequence, variants }: SystemInput): string {
  return [
    `You write the final message for Gerald at iClipmedia — message number ${sequence}, after ${sequence - 1} unanswered ones offering to build this creator a product from what their audience keeps asking for, for a 50% revenue share.`,
    'In this order:',
    '1. COST OF WAITING, honestly — name the product idea in a few plain words (from the earlier messages) so "this" is never vague: their audience keeps asking THEM for it, and if they don\'t answer it someone else may. One sentence, plain, no drama, no invented numbers or competitors.',
    '2. EASIEST ASK — make replying effortless: "Reply \'yes\' and I\'ll send the outline." (future tense — nothing has been made yet).',
    '3. LAST MESSAGE — the body itself says plainly that this is your last message about it (not just the subject line), and that no reply is completely fine.',
    `If you count the messages at all, count correctly — this is the ${ORDINALS[sequence - 1] ?? `#${sequence}`} message, never "the second" or "two notes". "A few notes" is fine.`,
    'Do not re-pitch the whole offer, do not quote anyone and put nothing in quotation marks except the word \'yes\'.',
    'Open exactly the way the earlier messages opened (same name, same form) — be consistent.',
    `Under ${isDm ? 45 : 60} words, not counting the sign-off.`,
    ...SHARED_RULES.slice(0, 3),
    address,
    isDm ? 'This is a DM: casual, no formal sign-off block.' : 'Do not write a sign-off or your name — it is appended automatically.',
    `Channel: ${CHANNEL_NOTE[channel]}${channel === 'EMAIL' ? ' Subject: short and low-key.' : ''}`,
    `Write ${variants} genuinely distinct variants — different phrasing, same honest intent.`,
  ].join('\n');
}

async function draftVariants(
  displayName: string,
  handle: string,
  evidence: AuditEvidence | null,
  quotes: Quote[],
  channel: OutreachChannel,
  sequence: number,
  variants: number,
  earlier: string[] = [],
  sensitive = false,
): Promise<Array<{ subject: string | null; body: string; hooksUsed: string[] }>> {
  const address = addressInstruction(displayName, handle);
  const isDm = DM_CHANNELS.has(channel);
  const input = { address, isDm, channel, sequence, variants, sensitive };

  const system =
    sequence >= FOLLOW_UP.finalSequence
      ? buildCloseSystem(input)
      : sequence === 2
        ? buildSecondTouchSystem(input)
        : buildFirstTouchSystem(input);

  // The close re-pitches nothing and quotes no one, so it gets no evidence
  // and no quotes — the schema then rejects any quotation it tries to add.
  const prompt = !evidence
    ? [
        `Write the final message${channel === 'EMAIL' ? ' and a short, low-key subject line' : ''}. Do not quote anyone.`,
        ...(earlier.length
          ? ['', 'The earlier messages, for context only — match how they addressed the creator and name the same product idea; copy no quotes from them:', ...earlier.map((b) => `---\n${b}\n---`)]
          : []),
      ].join('\n')
    : [
        buildPitchPrompt(evidence, quotes, sequence),
        ...(earlier.length
          ? ['', 'What was already sent to them (do not repeat its quote, hook or wording):', ...earlier.map((b) => `---\n${b}\n---`)]
          : []),
      ].join('\n');

  const { data } = await completeJSON({
    system,
    prompt,
    schema: draftsSchemaFor(variants, quotes, sequence),
    schemaName: 'outreach_drafts',
    tier: 'default',
    label: `outreach:${channel.toLowerCase()}:seq${sequence}`,
    maxTokens: 4096,
  });

  return data.variants;
}

const DEMAND = /\?|\b(how (do|can|to)|can you|could you|please|where('s| is| can)|need|want|wish|help|struggl\w*|can'?t|cannot|afford|teach|recipe|tutorial|tips?|advice|confused|stuck|budget)\b/i;

/** Audience comments that ask for something come first; the creator's own words last. */
function rankByDemand(quotes: Quote[]): Quote[] {
  const score = (q: Quote) => (q.authorType === 'FOLLOWER_COMMENT' ? 2 : 0) + (DEMAND.test(q.text) ? 2 : 0) + (DEMAND.test(q.pain ?? '') ? 1 : 0);
  return [...quotes].sort((a, b) => score(b) - score(a));
}

/**
 * A quote ready to paste: "…" wherever the stored text is an excerpt of the
 * full comment, and curly marks when the comment itself contains straight
 * double quotes (so the checker reads it as one quote).
 */
export function presentQuote(q: Pick<Quote, 'text' | 'fullText' | 'isTrimmed'>): string {
  const text = q.text.trim();
  const norm = (t: string) => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const full = q.fullText ? norm(q.fullText) : null;
  const cutBefore = full ? !full.startsWith(norm(text)) : false;
  const cutAfter = full ? !full.endsWith(norm(text)) : q.isTrimmed;
  const body = `${cutBefore ? '…' : ''}${text}${cutAfter ? '…' : ''}`;
  return text.includes('"') ? `“${body}”` : `"${body}"`;
}

function buildPitchPrompt(evidence: AuditEvidence, quotes: Quote[], sequence = 1): string {
  const recommended = evidence.productOpportunities.find((p) => p.recommended) ?? evidence.productOpportunities[0];
  return [
    ...(sequence === 2
      ? [
          'What their audience is asking about (for the product idea\'s 3-4 things it would cover):',
          ...evidence.top10Pains.slice(0, 8).map((p) => `- ${p.pain}`),
          '',
        ]
      : []),
    `Niche: ${evidence.niche}`,
    `Audience: ${evidence.audiencePersona.who} — ${evidence.audiencePersona.situation}`,
    '',
    `Partnership pitch angle: ${evidence.partnershipPitchAngle}`,
    '',
    'Quotes you may use — the only ones, strongest audience demand first. Each is shown EXACTLY as it must appear in the message — same quote marks, same "…" where the comment was cut. Copy one character for character (you may cut more, marking each cut with "…"), or don\'t quote it:',
    ...rankByDemand(quotes)
      .slice(0, 8)
      .map(
        (q) => `- ${q.pain ? `${q.pain} — ` : ''}${presentQuote(q)} (${describeAuthor(q)})`,
      ),
    '',
    `Recommended product angle: ${recommended?.title} — ${recommended?.promise} (for ${recommended?.whoItsFor})`,
    '',
    `Their own voice signature phrases (for recognising what resonates, NOT for writing in their voice): ${evidence.voiceGuide.signaturePhrases.join(', ') || '—'}`,
    '',
    `Ready-made hook lines from the audit, in case one fits naturally: ${evidence.hookLines.slice(0, 5).join(' | ')}`,
  ].join('\n');
}

// --- orchestration ---------------------------------------------------------------

function variantLabel(i: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + i);
}

export interface DraftOptions {
  /** Draft without saving anything: no OutreachMessage rows, no status change. Artifacts go to outreach/preview-*.md. */
  preview?: boolean;
  /** Bodies to treat as already sent (preview of seq 2 before seq 1 has gone out). */
  earlier?: string[];
}

export async function draftOutreach(
  handleOrUrl: string,
  channel: OutreachChannel,
  sequence = 1,
  variants = 2,
  options: DraftOptions = {},
): Promise<OutreachResult> {
  const handle = normalizeHandle(handleOrUrl);

  const creator = await prisma.creator.findUnique({ where: { handle } });
  if (!creator) {
    throw new Error(`No creator found for handle "${handle}" — run the audit first.`);
  }

  assertContactable(creator, 'drafting');

  // Refuses (and flags the creator) if any of their quotes lacks a source. A
  // closing note quotes no one and uses no audit evidence, so it only needs
  // the creator's real fields to be clean.
  const isClosing = sequence >= FOLLOW_UP.finalSequence;
  const { usable } = await assertClearForOutreach(creator, 'drafting', { quoteFree: isClosing });
  if (!isClosing && !usable.length) {
    throw new QuoteSourceError(
      `@${handle} has no sourced quotes to hook on — add one with \`npm run quotes -- --add --handle ${handle} --text "…" --url <post url> --author creator|@follower\` (or re-run the audit).`,
    );
  }

  const evidence = isClosing ? null : await loadAuditEvidence(creator.id);

  let to: string | null = null;
  if (channel === 'EMAIL') {
    to = creator.businessEmail ?? evidence?.socialLinks?.businessEmail ?? creator.contactEmail ?? null;
    if (!to) {
      log.warn(
        `no business email on file for @${handle} — drafting anyway; fill in a recipient before approving.`,
      );
    } else {
      log.info(`pre-filled To: ${to}`);
    }
  }

  // Seq 2 must add something new: it sees what was sent, and only gets the
  // quotes that earlier messages didn't already use (all of them if none are left).
  const sent = sequence > 1
    ? await prisma.outreachMessage.findMany({
        where: { creatorId: creator.id, sentAt: { not: null }, sequence: { lt: sequence } },
        orderBy: { sequence: 'asc' },
      })
    : [];
  const earlier = options.earlier ?? sent.map((m) => m.body);
  const unused = usable.filter((q) => !earlier.some((b) => quotedSpansIn(b).some((span) => isVerbatimIn(span, q.text))));
  const quotesForDraft = isClosing ? [] : sequence === 2 && unused.length ? unused : usable;

  log.info(`drafting ${variants} ${channel.toLowerCase()} variant(s), sequence ${sequence}`);
  const drafted = await draftVariants(
    creator.displayName ?? handle,
    handle,
    evidence,
    quotesForDraft,
    channel,
    sequence,
    variants,
    earlier,
    isSensitiveNiche(creator.niche),
  );

  const drafts: OutreachDraft[] = [];

  for (const [i, d] of drafted.entries()) {
    const variant = variantLabel(i);
    const isEmail = channel === 'EMAIL';
    const body = DM_CHANNELS.has(channel) ? d.body : withSignOff(d.body);

    const lines: string[] = [];
    lines.push(`# Outreach draft — ${channel} · sequence ${sequence} · variant ${variant}`);
    lines.push('');
    if (isEmail) {
      lines.push(`**From:** ${OUTREACH_SENDER.name} <${OUTREACH_SENDER.email}>`);
      lines.push(`**To:** ${to ?? '_(no business email found — fill in before sending)_'}`);
      lines.push(`**Subject:** ${d.subject ?? '(none)'}`);
      lines.push('');
    }
    lines.push(body);
    lines.push('');
    lines.push(`_Hooks used: ${d.hooksUsed.join(', ')}_`);
    lines.push('');
    lines.push(
      options.preview
        ? 'PREVIEW — not saved as a message, nothing can send it.'
        : 'Status: DRAFT. Emails are sent by the daily pipeline only if every send check passes (AUTO_SEND); anything else waits for a human.',
    );

    const filename = `${options.preview ? 'preview-' : ''}${sequence}-${channel.toLowerCase()}-${variant.toLowerCase()}.md`;
    const artifactPath = await writeArtifact(handle, 'outreach', filename, lines.join('\n'));

    drafts.push({
      channel,
      sequence,
      variant,
      to: isEmail ? to : null,
      ...(isEmail ? { subject: d.subject ?? undefined } : {}),
      body,
      hooks: d.hooksUsed,
    });
    if (options.preview) continue;

    const message = await prisma.outreachMessage.create({
      data: {
        creatorId: creator.id,
        channel,
        sequence,
        variant,
        to: isEmail ? to : null,
        subject: isEmail ? (d.subject ?? undefined) : undefined,
        body,
        hooks: d.hooksUsed,
        status: 'DRAFT',
        artifactPath: toRelative(artifactPath),
        model: 'default tier (see llm trace)',
      },
    });
    void message;
  }

  if (options.preview) return { handle, drafts };

  if (creator.status === 'AUDITED' || creator.status === 'DISCOVERED' || creator.status === 'SCORED') {
    await prisma.creator.update({ where: { id: creator.id }, data: { status: 'CONTACTED' } });
  }

  return { handle, drafts };
}

// --- approve + send ---------------------------------------------------------------
//
// Sending is deliberately a separate step from drafting, and drafting never
// reaches it on its own: a message must be explicitly APPROVED by a human
// before `sendOutreachMessage` will touch it. Nothing external happens
// implicitly — that's the whole point of the DRAFT status.

/** A seq-3+ closing note with nothing in quotation marks — quote problems can't touch it. */
function isQuoteFreeClosingNote(message: { sequence: number; body: string; subject: string | null }): boolean {
  return (
    message.sequence >= FOLLOW_UP.finalSequence &&
    !quotedSpansIn(message.body).length &&
    !quotedSpansIn(message.subject ?? '').length
  );
}

export interface ApproveResult {
  id: string;
  handle: string;
  channel: OutreachChannel;
  status: string;
}

export async function approveOutreachMessage(messageId: string): Promise<ApproveResult> {
  const message = await prisma.outreachMessage.findUnique({
    where: { id: messageId },
    include: { creator: true },
  });
  if (!message) throw new Error(`No outreach message found with id "${messageId}".`);
  if (message.status !== 'DRAFT') {
    throw new Error(
      `Message ${messageId} is ${message.status}, not DRAFT — only draft messages can be approved.`,
    );
  }
  assertContactable(message.creator, 'approving');
  await assertClearForOutreach(message.creator, 'approving', { quoteFree: isQuoteFreeClosingNote(message) });

  // Approving is Gerald's decision, so it also lifts any hold.
  const updated = await prisma.outreachMessage.update({
    where: { id: messageId },
    data: { status: 'APPROVED', heldFor: null },
  });

  return {
    id: updated.id,
    handle: message.creator.handle,
    channel: updated.channel as OutreachChannel,
    status: updated.status,
  };
}

export interface SendResult {
  id: string;
  handle: string;
  to: string;
  externalId: string;
  dryRun: boolean;
  test: boolean;
}

/**
 * Sends one APPROVED email via Resend and marks it SENT. Only EMAIL messages
 * can be sent this way — DM/manual channels have no send API here and go out
 * by hand. dryRun builds and logs the exact payload without calling Resend or
 * writing to the database. testTo redirects delivery to a different address
 * (subject prefixed "[TEST]") and never marks the message SENT — the real
 * recipient is untouched and the message stays sendable afterward.
 */
export async function sendOutreachMessage(
  messageId: string,
  options: { dryRun?: boolean; testTo?: string } = {},
): Promise<SendResult> {
  const message = await prisma.outreachMessage.findUnique({
    where: { id: messageId },
    include: { creator: true },
  });
  if (!message) throw new Error(`No outreach message found with id "${messageId}".`);

  if (message.channel !== 'EMAIL') {
    throw new Error(
      `Message ${messageId} is channel ${message.channel} — automatic sending only supports EMAIL. Send DMs by hand.`,
    );
  }
  if (message.status !== 'APPROVED') {
    throw new Error(
      `Message ${messageId} is ${message.status}, not APPROVED — approve it first: npm run outreach -- --approve ${messageId}`,
    );
  }
  if (!message.to) {
    throw new Error(`Message ${messageId} has no recipient — fill in a "to" address before sending.`);
  }
  assertContactable(message.creator, 'sending');
  await assertClearForOutreach(message.creator, 'sending', { quoteFree: isQuoteFreeClosingNote(message) });

  const isTest = Boolean(options.testTo);
  const recipient = options.testTo ?? message.to;

  const payload = {
    from: `${OUTREACH_SENDER.name} <${OUTREACH_SENDER.email}>`,
    to: [recipient],
    subject: `${isTest ? '[TEST] ' : ''}${message.subject ?? '(no subject)'}`,
    text: message.body,
  };

  if (options.dryRun) {
    log.info('DRY RUN — no Resend API call made, no database write. Payload that would be sent:');
    console.log(JSON.stringify(payload, null, 2));
    return {
      id: message.id,
      handle: message.creator.handle,
      to: recipient,
      externalId: '(dry-run — nothing sent)',
      dryRun: true,
      test: isTest,
    };
  }

  const env = getEnv();
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY must be set to send outreach emails.');

  log.info(`sending${isTest ? ' TEST' : ''} to ${recipient} via Resend`);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as { id: string };

  if (isTest) {
    log.info(`test sent: ${data.id} — message ${messageId} left as APPROVED, not marked SENT`);
    return { id: message.id, handle: message.creator.handle, to: recipient, externalId: data.id, dryRun: false, test: true };
  }

  await prisma.outreachMessage.update({
    where: { id: messageId },
    data: { status: 'SENT', sentAt: new Date(), externalId: data.id },
  });

  log.info(`sent: ${data.id}`);

  return { id: message.id, handle: message.creator.handle, to: recipient, externalId: data.id, dryRun: false, test: false };
}

// --- automatic sending -------------------------------------------------------------
//
// The daily pipeline may send an EMAIL draft on its own only when every check
// below passes. Anything that fails is held for Gerald (heldFor) — never sent,
// never rewritten around.

/** heldFor prefix for a hold only Gerald can lift (by approving the message). The auto-sender never sends or overwrites it. */
export const MANUAL_HOLD = 'MANUAL HOLD';

/** Drafts written before the current sequence design are never auto-sent. */
export const SEQUENCE_DESIGN_SINCE = new Date('2026-10-15T00:00:00');

const GREETING = /^\s*(?:hi|hey|hello|dear)\s+([^,\n—–!-]{1,60}?)\s*(?:team)?\s*[,\n—–!-]|^\s*([^,\n—–]{1,40}?)\s*[—–,]/i;

/** "V i c t o r i a  H e l l u m" → "Victoria Hellum" (letter-spaced display names). */
function unspace(text: string): string {
  return text.replace(/(?:\p{L} ){2,}\p{L}/gu, (m) => m.replace(/ /g, ''));
}

function words(text: string): string[] {
  return unspace(text.normalize('NFKC')).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * The name the message opens with must be the creator's real name (or channel
 * name), taken from their display name — never built from the handle.
 */
export function greetingProblems(body: string, displayName: string | null, handle: string): string[] {
  const m = GREETING.exec(body);
  // The bare "Name —" form only counts as a greeting when it's a name-length opener, not a sentence.
  const name = (m?.[1] ?? (m?.[2] && m[2].trim().split(/\s+/).length <= 3 ? m[2] : '') ?? '').trim();
  if (!name) return [];
  if (/^there$/i.test(name)) return [];
  const nameWords = words(name);
  if (!displayName) return [`opens with "${name}" but the creator has no display name on record to confirm it`];
  const display = words(displayName);
  if (!nameWords.every((w) => display.includes(w))) {
    return [`opens with "${name}", which isn't in their display name "${displayName}"`];
  }
  const squash = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // Only a single-token display name equal to the handle is "just the handle" — "Milo Meloy" vs @milomeloy is a real name.
  if (display.length === 1 && squash(displayName) === squash(handle)) {
    return [`opens with "${name}", but their display name is just the handle — no confirmed first name`];
  }
  return [];
}

type MessageWithCreator = Prisma.OutreachMessageGetPayload<{ include: { creator: true } }>;

/** Every reason this message may not be sent automatically. Empty = clear to send. */
export async function sendChecks(message: MessageWithCreator): Promise<string[]> {
  const problems: string[] = [];
  const { creator } = message;
  const block = contactBlock(creator);
  if (block) problems.push(block);
  if (message.heldFor?.startsWith(MANUAL_HOLD)) problems.push(message.heldFor);
  if (message.channel !== 'EMAIL') problems.push(`channel ${message.channel} — DMs go out by hand`);
  if (!message.to) problems.push('no recipient address');
  if (message.createdAt < SEQUENCE_DESIGN_SINCE) problems.push('drafted under the old sequence design — redraft it');
  if (['REPLIED', 'DECLINED', 'AGREED', 'LAUNCHED'].includes(creator.status)) problems.push(`creator is ${creator.status}`);

  // Quotes: every quoted span must be word for word from a quote with a source URL, author and date.
  const status = await quoteStatus(creator);
  const quoteFree = isQuoteFreeClosingNote(message);
  if (!quoteFree && status.blocked.length) {
    problems.push(`${status.blocked.length} of their quote(s) lack a source URL/author — fix with \`npm run quotes\``);
  }
  if (status.placeholders.length) problems.push(`placeholder text in ${status.placeholders.map((p) => p.field).join(', ')}`);
  // Subject and body separately — a quote mark in one must never pair with one in the other.
  problems.push(...misusedQuotesIn(message.subject ?? '', status.usable).map((p) => `subject: ${p}`));
  problems.push(...misusedQuotesIn(message.body, status.usable));

  // Name, count, sign-off, honesty, no claims of existing work.
  problems.push(...greetingProblems(message.body, creator.displayName, creator.handle));
  problems.push(...noteCountProblems(message.body, message.sequence));
  if (!message.body.trimEnd().endsWith(SIGN_OFF)) problems.push('sign-off missing');
  problems.push(...dishonestyIn(message.body).map((d) => `contains ${d}`));
  if (isSensitiveNiche(creator.niche)) {
    problems.push(...productLineFlags(message.body).map((f) => `sensitive niche — the pitch crosses into ${f}`));
  }
  problems.push(...bannedClaimsIn(message.body).map((c) => `claims work exists: ${c}`));

  // Sequence: exactly one more than what has actually been sent, and due.
  const sentBefore = await prisma.outreachMessage.findMany({
    where: { creatorId: creator.id, sentAt: { not: null } },
    orderBy: { sentAt: 'desc' },
  });
  const sentSequences = new Set(sentBefore.map((m) => m.sequence));
  if (message.sequence !== sentSequences.size + 1) {
    problems.push(`is message ${message.sequence}, but ${sentSequences.size} have been sent — wrong note count`);
  }
  const last = sentBefore[0];
  if (last?.repliedAt) problems.push('they replied — a human answers this one');
  if (last?.sentAt && addBusinessDays(last.sentAt, FOLLOW_UP.businessDays) > new Date()) {
    problems.push(`not due yet (last sent ${last.sentAt.toISOString().slice(0, 10)})`);
  }
  return problems;
}

export interface AutoSendOutcome {
  sent: Array<{ handle: string; id: string; sequence: number; to: string; resendId: string }>;
  held: Array<{ handle: string; id: string; sequence: number; reasons: string[] }>;
  capReached: boolean;
  sentTodayBefore: number;
}

/**
 * Sends due EMAIL drafts that pass every sendCheck, at most `max` emails today
 * in total (counting manual sends). One variant per creator per sequence — the
 * first that passes; its siblings become SUPERSEDED. dryRun reports what would
 * happen and writes nothing.
 */
export async function autoSendEmails(options: { max: number; dryRun?: boolean; logPath?: string }): Promise<AutoSendOutcome> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const sentTodayBefore = await prisma.outreachMessage.count({ where: { channel: 'EMAIL', sentAt: { gte: startOfDay } } });
  let room = Math.max(0, options.max - sentTodayBefore);

  const drafts = await prisma.outreachMessage.findMany({
    where: { channel: 'EMAIL', status: 'DRAFT' },
    include: { creator: true },
    orderBy: [{ createdAt: 'asc' }, { variant: 'asc' }],
  });
  const groups = new Map<string, MessageWithCreator[]>();
  for (const d of drafts) {
    const key = `${d.creatorId}:${d.sequence}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }

  const out: AutoSendOutcome = { sent: [], held: [], capReached: false, sentTodayBefore };
  for (const variants of groups.values()) {
    let chosen: MessageWithCreator | null = null;
    const reasonsByVariant: string[] = [];
    for (const v of variants) {
      const problems = await sendChecks(v);
      if (!problems.length) {
        chosen = v;
        break;
      }
      reasonsByVariant.push(`${v.variant ?? '?'}: ${problems.join('; ')}`);
    }
    const first = variants[0]!;
    if (!chosen) {
      const reasons = reasonsByVariant;
      out.held.push({ handle: first.creator.handle, id: first.id, sequence: first.sequence, reasons });
      if (!options.dryRun) {
        await prisma.outreachMessage.updateMany({
          where: { id: { in: variants.filter((v) => !v.heldFor?.startsWith(MANUAL_HOLD)).map((v) => v.id) } },
          data: { heldFor: reasons.join(' | ').slice(0, 2000) },
        });
      }
      continue;
    }
    if (room <= 0) {
      out.capReached = true;
      out.held.push({ handle: first.creator.handle, id: chosen.id, sequence: chosen.sequence, reasons: [`daily cap of ${options.max} emails reached — goes out tomorrow`] });
      continue;
    }
    if (options.dryRun) {
      out.sent.push({ handle: chosen.creator.handle, id: chosen.id, sequence: chosen.sequence, to: chosen.to!, resendId: '(dry run — not sent)' });
      room--;
      continue;
    }
    try {
      await approveOutreachMessage(chosen.id);
      const r = await sendOutreachMessage(chosen.id);
      room--;
      await prisma.outreachMessage.updateMany({
        where: { id: { in: variants.filter((v) => v.id !== chosen!.id).map((v) => v.id) }, status: 'DRAFT' },
        data: { status: 'SUPERSEDED' },
      });
      await prisma.outreachMessage.update({ where: { id: chosen.id }, data: { heldFor: null } });
      out.sent.push({ handle: r.handle, id: r.id, sequence: chosen.sequence, to: r.to, resendId: r.externalId });
      if (options.logPath) {
        await fs.appendFile(
          options.logPath,
          `${JSON.stringify({ at: new Date().toISOString(), handle: r.handle, messageId: r.id, sequence: chosen.sequence, to: r.to, resendId: r.externalId })}\n`,
          'utf8',
        );
      }
    } catch (error) {
      out.held.push({ handle: first.creator.handle, id: chosen.id, sequence: chosen.sequence, reasons: [`send failed: ${(error as Error).message}`] });
    }
  }
  return out;
}

// --- DMs (sent by hand from the DM queue page) ---------------------------------------

/** Approve one DM variant for the queue; its sibling variants become SUPERSEDED. */
export async function approveDmVariant(messageId: string): Promise<void> {
  const m = await prisma.outreachMessage.findUnique({ where: { id: messageId }, include: { creator: true } });
  if (!m) throw new Error(`No outreach message "${messageId}".`);
  if (m.channel === 'EMAIL') throw new Error('emails go through the auto-sender, not the DM queue');
  assertContactable(m.creator, 'approving');
  await approveOutreachMessage(messageId);
  await prisma.outreachMessage.updateMany({
    where: { creatorId: m.creatorId, sequence: m.sequence, channel: m.channel, status: 'DRAFT', id: { not: m.id } },
    data: { status: 'SUPERSEDED' },
  });
}

/** Gerald sent this DM by hand: mark it SENT now, so the follow-up clock starts. Returns when the next one is due. */
export async function markDmSent(messageId: string): Promise<{ sentAt: Date; nextDueAt: Date | null }> {
  const m = await prisma.outreachMessage.findUnique({ where: { id: messageId }, include: { creator: true } });
  if (!m) throw new Error(`No outreach message "${messageId}".`);
  if (m.channel === 'EMAIL') throw new Error('emails are sent through Resend, not marked by hand');
  assertContactable(m.creator, 'marking sent');
  if (m.status !== 'APPROVED') throw new Error(`message is ${m.status}, not APPROVED`);
  const sentAt = new Date();
  await prisma.outreachMessage.update({ where: { id: m.id }, data: { status: 'SENT', sentAt } });
  await prisma.creator.updateMany({ where: { id: m.creatorId, status: { in: ['AUDITED', 'SCORED', 'DISCOVERED'] } }, data: { status: 'CONTACTED' } });
  const nextDueAt = m.sequence >= FOLLOW_UP.finalSequence ? null : addBusinessDays(sentAt, FOLLOW_UP.businessDays);
  return { sentAt, nextDueAt };
}

// --- reply logging -----------------------------------------------------------------

export type ReplyOutcome = 'interested' | 'declined' | 'agreed';

// The schema's Creator enum has REPLIED/DECLINED/AGREED — "interested" here
// maps to REPLIED, since that's what the schema calls this state. There is
// no separate INTERESTED value; introducing one would just duplicate REPLIED.
const REPLY_OUTCOME_TO_CREATOR_STATUS: Record<ReplyOutcome, CreatorStatus> = {
  interested: 'REPLIED',
  declined: 'DECLINED',
  agreed: 'AGREED',
};

// OutreachMessage's own status enum has no AGREED value — that's a
// Creator-level business outcome, not a message-delivery state, so an
// "agreed" reply still marks the message itself REPLIED.
const REPLY_OUTCOME_TO_MESSAGE_STATUS: Record<ReplyOutcome, OutreachStatus> = {
  interested: 'REPLIED',
  declined: 'DECLINED',
  agreed: 'REPLIED',
};

export interface LogReplyResult {
  handle: string;
  messageId: string;
  repliedAt: Date;
  outcome: ReplyOutcome;
  creatorStatus: CreatorStatus;
}

/**
 * Records that a creator replied: sets repliedAt (and a matching status) on
 * their latest SENT message, and moves Creator.status to the outcome. This
 * is the only way repliedAt gets set — nothing else in the module writes it,
 * so a creator never silently drops off the --due report without a human
 * saying so.
 */
export async function logReply(handle: string, outcome: ReplyOutcome): Promise<LogReplyResult> {
  const normalized = normalizeHandle(handle);
  const creator = await prisma.creator.findUnique({ where: { handle: normalized } });
  if (!creator) throw new Error(`No creator found for handle "${normalized}".`);

  const last = await prisma.outreachMessage.findFirst({
    where: { creatorId: creator.id, status: 'SENT' },
    orderBy: { sentAt: 'desc' },
  });
  if (!last) {
    throw new Error(`No SENT outreach message found for @${normalized} — nothing to mark as replied.`);
  }

  const repliedAt = new Date();
  await prisma.outreachMessage.update({
    where: { id: last.id },
    data: { repliedAt, status: REPLY_OUTCOME_TO_MESSAGE_STATUS[outcome] },
  });

  const creatorStatus = REPLY_OUTCOME_TO_CREATOR_STATUS[outcome];
  await prisma.creator.update({ where: { id: creator.id }, data: { status: creatorStatus } });

  return { handle: normalized, messageId: last.id, repliedAt, outcome, creatorStatus };
}

// --- follow-up due report ---------------------------------------------------------

/** Advances `start` by `days` business days — Saturdays and Sundays don't count. */
function addBusinessDays(start: Date, days: number): Date {
  const result = new Date(start);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return result;
}

export interface FollowUpStatus {
  handle: string;
  channel: OutreachChannel;
  lastSequence: number;
  lastSentAt: Date;
  nextSequence: number;
  dueAt: Date;
  dueNow: boolean;
}

/**
 * One entry per creator with at least one SENT message and no logged reply —
 * their latest send plus when the next follow-up is due, per FOLLOW_UP.businessDays.
 * A creator who replied, declined, or already agreed is left off, as is one
 * whose last send was the closing note (FOLLOW_UP.finalSequence): no
 * automatic follow-up is owed to any of them.
 */
export async function listFollowUpsDue(): Promise<FollowUpStatus[]> {
  // Match on sentAt, not status: logReply moves a replied message from SENT
  // to REPLIED/DECLINED, so filtering on SENT would skip the reply and fall
  // back to an older unanswered send, reporting a creator who already replied.
  const creators = await prisma.creator.findMany({
    where: {
      messages: { some: { sentAt: { not: null } } },
      status: { notIn: ['DECLINED', 'AGREED', 'RETIRED'] },
      doNotContact: false,
    },
    include: {
      messages: {
        where: { sentAt: { not: null } },
        orderBy: { sentAt: 'desc' },
        take: 1,
      },
    },
  });

  const now = new Date();
  const results: FollowUpStatus[] = [];

  for (const creator of creators) {
    const last = creator.messages[0];
    if (!last?.sentAt || last.repliedAt) continue;
    if (last.sequence >= FOLLOW_UP.finalSequence) continue;

    const dueAt = addBusinessDays(last.sentAt, FOLLOW_UP.businessDays);
    results.push({
      handle: creator.handle,
      channel: last.channel as OutreachChannel,
      lastSequence: last.sequence,
      lastSentAt: last.sentAt,
      nextSequence: last.sequence + 1,
      dueAt,
      dueNow: dueAt <= now,
    });
  }

  return results.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}
