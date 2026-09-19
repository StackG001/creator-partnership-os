import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { getEnv } from '../../lib/env.js';
import { normalizeHandle, toRelative, writeArtifact } from '../../lib/paths.js';
import { createLogger } from '../../lib/logger.js';
import { OUTREACH_SENDER, type OutreachChannel } from '../../lib/constants.js';

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
// used for outreach, across every channel and every sequence step. HOOK →
// VALUE LINE → ZERO EFFORT LINE → PROOF OF WORK → SINGLE ASK, in that order,
// every time. DMs collapse to HOOK + ASK only; the offer comes out on reply.

const DM_CHANNELS: ReadonlySet<OutreachChannel> = new Set(['IG_DM', 'X_DM']);

const CHANNEL_NOTE: Record<OutreachChannel, string> = {
  EMAIL: 'Email. Has a subject line.',
  IG_DM: 'Instagram DM. No subject.',
  YT_ABOUT: 'YouTube "About" page business-inquiry message. No subject.',
  X_DM: 'X (Twitter) DM. No subject.',
  MANUAL: 'Generic first-touch message. No subject.',
};

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

  const system = [
    'You write outreach for Gerald at iClipmedia — Gerald finds micro-creators with engaged niche audiences and no digital product, and builds them one for a revenue share.',
    'Every message follows the iClipmedia outreach framework below, in this exact order, every time. This is the only style used — no exceptions.',
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
}

/**
 * Sends one APPROVED email via Resend and marks it SENT. Only EMAIL messages
 * can be sent this way — DM/manual channels have no send API here and go out
 * by hand. dryRun builds and logs the exact payload without calling Resend or
 * writing to the database.
 */
export async function sendOutreachMessage(
  messageId: string,
  options: { dryRun?: boolean } = {},
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

  const payload = {
    from: `${OUTREACH_SENDER.name} <${OUTREACH_SENDER.email}>`,
    to: [message.to],
    subject: message.subject ?? '(no subject)',
    text: message.body,
  };

  if (options.dryRun) {
    log.info('DRY RUN — no Resend API call made, no database write. Payload that would be sent:');
    console.log(JSON.stringify(payload, null, 2));
    return {
      id: message.id,
      handle: message.creator.handle,
      to: message.to,
      externalId: '(dry-run — nothing sent)',
      dryRun: true,
    };
  }

  const env = getEnv();
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY must be set to send outreach emails.');

  log.info(`sending to ${message.to} via Resend`);
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

  await prisma.outreachMessage.update({
    where: { id: messageId },
    data: { status: 'SENT', sentAt: new Date(), externalId: data.id },
  });

  log.info(`sent: ${data.id}`);

  return { id: message.id, handle: message.creator.handle, to: message.to, externalId: data.id, dryRun: false };
}
