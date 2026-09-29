import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { getEnv } from '../../lib/env.js';
import { normalizeHandle, toRelative, writeArtifact } from '../../lib/paths.js';
import { createLogger } from '../../lib/logger.js';
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

// --- drafting -------------------------------------------------------------------

const DraftSchema = z.object({
  subject: z.string().nullable().describe('Email subject line. Null for non-email channels.'),
  body: z.string(),
  hooksUsed: z
    .array(z.string())
    .min(1)
    .max(4)
    .describe('Which specific pains/hooks/pitch-angle pieces from the evidence this variant leans on.'),
});

function draftsSchemaFor(count: number) {
  return z.object({ variants: z.array(DraftSchema).length(count) });
}

// The iClipmedia outreach framework (Iman Gadzhi method) — the only style
// used for the first two touches, across every channel. HOOK → VALUE LINE →
// ZERO EFFORT LINE → PROOF OF WORK → SINGLE ASK, in that order, every time.
// DMs collapse to HOOK + ASK only; the offer comes out on reply.
//
// From sequence 3 onward it's a different, deliberately un-pitchy shape: a
// short closing note (see buildClosingNoteSystem) — no re-pitch, no new hook,
// just a light acknowledgement and an open door.

const DM_CHANNELS: ReadonlySet<OutreachChannel> = new Set(['IG_DM', 'X_DM']);

const CHANNEL_NOTE: Record<OutreachChannel, string> = {
  EMAIL: 'Email. Has a subject line.',
  IG_DM: 'Instagram DM. No subject.',
  YT_ABOUT: 'YouTube "About" page business-inquiry message. No subject.',
  X_DM: 'X (Twitter) DM. No subject.',
  MANUAL: 'Generic first-touch message. No subject.',
};

function buildFrameworkSystem(input: {
  firstName: string;
  isDm: boolean;
  channel: OutreachChannel;
  sequence: number;
  variants: number;
}): string {
  const { firstName, isDm, channel, sequence, variants } = input;
  return [
    'You write outreach for Gerald at iClipmedia — Gerald finds micro-creators with engaged niche audiences and no digital product, and builds them one for a revenue share.',
    'Every message follows the iClipmedia outreach framework below, in this exact order, every time. This is the only style used for the first two touches — no exceptions there.',
    '1. HOOK — one specific thing you noticed in their content: a real comment quote, a caption line, a view count, a specific video topic. Never generic, never "I love your content". Reference something real with a detail that proves you actually watched.',
    '2. VALUE LINE — one sentence: what you build, what they get, what they do. Format: "I build [thing] for [type of creator] — I handle everything, you promote it to your audience, keep 50% of every sale."',
    '3. ZERO EFFORT LINE — explicitly remove the work objection: "No filming, no writing, no design work from you."',
    '4. PROOF OF WORK — one line showing you already started: "Already drafted a concept based on your [specific content]."',
    '5. SINGLE ASK — one yes/no question, nothing else: "Want me to send it over?" or "Worth a quick reply?"',
    isDm
      ? 'This is a DM: cut everything that is not the HOOK and the SINGLE ASK — no value line, no zero-effort line, no proof of work. Only reveal the offer if they reply. The hook must read like a genuine fan message, not a pitch.'
      : 'Keep all five parts, in order, as distinct beats — do not merge them into one run-on paragraph.',
    `Word limit: ${isDm ? '60 words max (DM)' : '120 words max'}. Go under, never over.`,
    'Never use: "hope this finds you well", "I came across your profile", "I\'d love to", "amazing content", or any other filler phrase.',
    `Open by addressing the creator by their real first name or handle, "${firstName}" — never a placeholder like "[Name]" or "there".`,
    'Every quoted line must be copied verbatim from the evidence given below — never invent a quote.',
    'Never explain the business model beyond the VALUE LINE — just enough to make them curious, not a pitch deck.',
    'The ask is always a single yes/no question.',
    `End every message with exactly this two-line sign-off, nothing else after it:\nGerald\n${OUTREACH_SENDER.name} | ${OUTREACH_SENDER.company} | ${OUTREACH_SENDER.email}`,
    sequence === 1
      ? 'This is the FIRST touch.'
      : `This is FOLLOW-UP #${sequence}. Assume no reply yet. Keep the same structure, but the HOOK and PROOF OF WORK must use a different, unused piece of evidence than a first touch would.`,
    `Channel: ${CHANNEL_NOTE[channel]}`,
    `Write ${variants} genuinely distinct variants — a different HOOK each — not paraphrases of each other.`,
  ].join('\n');
}

/** Sequence 3+: a short closing note, not the pitch framework. No re-pitch, no new hook. */
function buildClosingNoteSystem(input: {
  firstName: string;
  isDm: boolean;
  channel: OutreachChannel;
  variants: number;
}): string {
  const { firstName, isDm, channel, variants } = input;
  return [
    'You write short closing notes for Gerald at iClipmedia, sent after two earlier outreach touches to this creator went unanswered.',
    'This is NOT the five-beat pitch framework. Do not re-explain the offer, do not introduce a new hook or piece of evidence, do not re-pitch in any form.',
    'One or two short sentences. The first sentence MUST explicitly acknowledge this is a repeat touch — e.g. "I know this is a couple of notes now" or "this is the last one from me on this for a while" — light and self-aware, not guilty or naggy. Never use the stock phrases "just following up," "wanted to circle back," or "checking in."',
    'Leave the door open with zero pressure — make it easy for them to reply whenever, or never, with no fake urgency and no re-ask of the original question.',
    `Open with their real first name or handle, "${firstName}" — never a placeholder.`,
    'Under 40 words total for the note itself — this does not include the sign-off.',
    isDm
      ? 'This is a DM: keep it casual, no formal sign-off block.'
      : `End with exactly this two-line sign-off, nothing after it:\nGerald\n${OUTREACH_SENDER.name} | ${OUTREACH_SENDER.company} | ${OUTREACH_SENDER.email}`,
    `Channel: ${CHANNEL_NOTE[channel]}`,
    `Write ${variants} genuinely distinct variants — different phrasing, same restrained intent.`,
  ].join('\n');
}

async function draftVariants(
  displayName: string,
  evidence: AuditEvidence,
  channel: OutreachChannel,
  sequence: number,
  variants: number,
): Promise<Array<{ subject: string | null; body: string; hooksUsed: string[] }>> {
  const recommended = evidence.productOpportunities.find((p) => p.recommended) ?? evidence.productOpportunities[0];
  const firstName = displayName.trim().split(/\s+/)[0] || displayName;
  const isDm = DM_CHANNELS.has(channel);

  const system =
    sequence >= 3
      ? buildClosingNoteSystem({ firstName, isDm, channel, variants })
      : buildFrameworkSystem({ firstName, isDm, channel, sequence, variants });

  const prompt = [
    `Niche: ${evidence.niche}`,
    `Audience: ${evidence.audiencePersona.who} — ${evidence.audiencePersona.situation}`,
    '',
    `Partnership pitch angle: ${evidence.partnershipPitchAngle}`,
    '',
    'Top pain points (quoted from real comments/captions):',
    ...evidence.top10Pains
      .slice(0, 6)
      .map((p) => `- ${p.pain} — "${p.quote}" (${p.source} on ${p.postRef})`),
    '',
    `Recommended product angle: ${recommended?.title} — ${recommended?.promise} (for ${recommended?.whoItsFor})`,
    '',
    `Their own voice signature phrases (for recognising what resonates, NOT for writing in their voice): ${evidence.voiceGuide.signaturePhrases.join(', ') || '—'}`,
    '',
    `Ready-made hook lines from the audit, in case one fits naturally: ${evidence.hookLines.slice(0, 5).join(' | ')}`,
  ].join('\n');

  const { data } = await completeJSON({
    system,
    prompt,
    schema: draftsSchemaFor(variants),
    schemaName: 'outreach_drafts',
    tier: 'default',
    label: `outreach:${channel.toLowerCase()}:seq${sequence}`,
    maxTokens: 4096,
  });

  return data.variants;
}

// --- orchestration ---------------------------------------------------------------

function variantLabel(i: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + i);
}

export async function draftOutreach(
  handleOrUrl: string,
  channel: OutreachChannel,
  sequence = 1,
  variants = 2,
): Promise<OutreachResult> {
  const handle = normalizeHandle(handleOrUrl);

  const creator = await prisma.creator.findUnique({ where: { handle } });
  if (!creator) {
    throw new Error(`No creator found for handle "${handle}" — run the audit first.`);
  }

  const evidence = await loadAuditEvidence(creator.id);

  let to: string | null = null;
  if (channel === 'EMAIL') {
    to = creator.businessEmail ?? evidence.socialLinks?.businessEmail ?? creator.contactEmail ?? null;
    if (!to) {
      log.warn(
        `no business email on file for @${handle} — drafting anyway; fill in a recipient before approving.`,
      );
    } else {
      log.info(`pre-filled To: ${to}`);
    }
  }

  log.info(`drafting ${variants} ${channel.toLowerCase()} variant(s), sequence ${sequence}`);
  const drafted = await draftVariants(
    creator.displayName ?? handle,
    evidence,
    channel,
    sequence,
    variants,
  );

  const drafts: OutreachDraft[] = [];

  for (const [i, d] of drafted.entries()) {
    const variant = variantLabel(i);
    const isEmail = channel === 'EMAIL';

    const lines: string[] = [];
    lines.push(`# Outreach draft — ${channel} · sequence ${sequence} · variant ${variant}`);
    lines.push('');
    if (isEmail) {
      lines.push(`**From:** ${OUTREACH_SENDER.name} <${OUTREACH_SENDER.email}>`);
      lines.push(`**To:** ${to ?? '_(no business email found — fill in before sending)_'}`);
      lines.push(`**Subject:** ${d.subject ?? '(none)'}`);
      lines.push('');
    }
    lines.push(d.body);
    lines.push('');
    lines.push(`_Hooks used: ${d.hooksUsed.join(', ')}_`);
    lines.push('');
    lines.push('Status: DRAFT — review and approve before sending. Nothing is sent automatically.');

    const filename = `${sequence}-${channel.toLowerCase()}-${variant.toLowerCase()}.md`;
    const artifactPath = await writeArtifact(handle, 'outreach', filename, lines.join('\n'));

    const message = await prisma.outreachMessage.create({
      data: {
        creatorId: creator.id,
        channel,
        sequence,
        variant,
        to: isEmail ? to : null,
        subject: isEmail ? (d.subject ?? undefined) : undefined,
        body: d.body,
        hooks: d.hooksUsed,
        status: 'DRAFT',
        artifactPath: toRelative(artifactPath),
        model: 'default tier (see llm trace)',
      },
    });

    drafts.push({
      channel,
      sequence,
      variant,
      to: isEmail ? to : null,
      ...(isEmail ? { subject: d.subject ?? undefined } : {}),
      body: d.body,
      hooks: d.hooksUsed,
    });

    void message;
  }

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

  const updated = await prisma.outreachMessage.update({
    where: { id: messageId },
    data: { status: 'APPROVED' },
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
      status: { notIn: ['DECLINED', 'AGREED'] },
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
