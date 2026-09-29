import { runCli, type CliSpec } from '../../lib/cli.js';
import { OUTREACH_CHANNELS, OUTREACH_SENDER, type OutreachChannel } from '../../lib/constants.js';
import {
  approveOutreachMessage,
  draftOutreach,
  listFollowUpsDue,
  logReply,
  sendOutreachMessage,
  type ReplyOutcome,
} from './index.js';

export const spec: CliSpec = {
  name: 'outreach',
  summary: "Write personalised first-touch and follow-up messages per creator, then approve and send them.",
  examples: [
    'npm run outreach -- --handle jamesclearcoffee --channel email',
    'npm run outreach -- --handle jamesclearcoffee --channel ig_dm --variants 3',
    'npm run outreach -- --handle jamesclearcoffee --sequence 2',
    'npm run outreach -- --approve cmu5abc123',
    'npm run outreach -- --send cmu5abc123 --dry-run',
    'npm run outreach -- --send cmu5abc123',
    'npm run outreach -- --send cmu5abc123 --test-to me@example.com',
    'npm run outreach -- --due',
    'npm run outreach -- --replied grantbakes --status interested',
    'npm run outreach -- --replied grantbakes --status declined',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to write to (drafting mode).' },
    channel: { type: 'string', description: 'email | ig_dm | yt_about | x_dm | manual.', default: 'email' },
    sequence: { type: 'string', description: '1 = first touch, 2+ = follow-up.', default: '1' },
    variants: { type: 'string', description: 'How many variants to draft.', default: '2' },
    approve: { type: 'string', description: 'Mark a DRAFT OutreachMessage id as APPROVED.' },
    send: { type: 'string', description: 'Send an APPROVED OutreachMessage id via Resend (EMAIL only).' },
    'test-to': {
      type: 'string',
      description: 'With --send: deliver to this address instead of the real recipient. Subject gets a [TEST] prefix; the message is NOT marked SENT.',
    },
    due: {
      type: 'boolean',
      description: 'List creators due a follow-up (FOLLOW_UP.businessDays after their last send, no reply logged, excludes DECLINED/AGREED and anyone whose closing note (seq FOLLOW_UP.finalSequence) is already sent).',
    },
    replied: {
      type: 'string',
      description: 'Log a reply from this creator handle. Requires --status.',
    },
    status: {
      type: 'string',
      description: 'With --replied: interested | declined | agreed. "interested" maps to the schema\'s REPLIED status.',
    },
  },
};

function parseChannel(raw: string): OutreachChannel {
  const normalized = raw.trim().toUpperCase().replace(/-/g, '_');
  if ((OUTREACH_CHANNELS as readonly string[]).includes(normalized)) {
    return normalized as OutreachChannel;
  }
  throw new Error(
    `Unknown channel "${raw}" — expected one of: ${OUTREACH_CHANNELS.map((c) => c.toLowerCase()).join(', ')}`,
  );
}

const REPLY_OUTCOMES: readonly ReplyOutcome[] = ['interested', 'declined', 'agreed'];

function parseReplyOutcome(raw: string): ReplyOutcome {
  const normalized = raw.trim().toLowerCase();
  if ((REPLY_OUTCOMES as readonly string[]).includes(normalized)) return normalized as ReplyOutcome;
  throw new Error(`Unknown --status "${raw}" — expected one of: ${REPLY_OUTCOMES.join(', ')}`);
}

await runCli(spec, async (ctx) => {
  if (ctx.flags.due) {
    if (ctx.dryRun) throw new Error('--due only reads the database — --dry-run has nothing to skip.');
    const due = await listFollowUpsDue();
    if (ctx.json) {
      console.log(JSON.stringify(due, null, 2));
      return;
    }
    if (!due.length) {
      ctx.log.info('No creators are waiting on a follow-up.');
      return;
    }
    for (const d of due) {
      const sent = d.lastSentAt.toISOString().slice(0, 10);
      const dueDate = d.dueAt.toISOString().slice(0, 10);
      const label = d.dueNow ? 'DUE NOW' : `due ${dueDate}`;
      ctx.log.info(
        `@${d.handle} · ${d.channel} · seq ${d.lastSequence} sent ${sent} · next seq ${d.nextSequence} · ${label}`,
      );
    }
    return;
  }

  if (ctx.flags.replied) {
    if (ctx.dryRun) throw new Error('--replied is a local status change — --dry-run has nothing to skip.');
    if (!ctx.flags.status) throw new Error('--replied requires --status <interested|declined|agreed>.');
    const outcome = parseReplyOutcome(String(ctx.flags.status));
    const result = await logReply(String(ctx.flags.replied), outcome);
    if (ctx.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    ctx.log.info(
      `@${result.handle} · message ${result.messageId} marked replied (${outcome}) · Creator.status -> ${result.creatorStatus}`,
    );
    return;
  }

  if (ctx.flags.approve) {
    if (ctx.dryRun) throw new Error('--approve is a local status change — --dry-run has nothing to skip.');
    const result = await approveOutreachMessage(String(ctx.flags.approve));
    if (ctx.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    ctx.log.info(`@${result.handle} · ${result.channel} · ${result.id} is now APPROVED.`);
    if (result.channel === 'EMAIL') {
      ctx.log.info(`Send it: npm run outreach -- --send ${result.id}`);
    } else {
      ctx.log.info(`${result.channel} has no automatic sender — send it by hand.`);
    }
    return;
  }

  if (ctx.flags.send) {
    const testTo = ctx.flags['test-to'] ? String(ctx.flags['test-to']) : undefined;
    const result = await sendOutreachMessage(String(ctx.flags.send), { dryRun: ctx.dryRun, testTo });
    if (ctx.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.dryRun) {
      ctx.log.info('Dry run complete — nothing was sent. Re-run without --dry-run to go live.');
    } else if (result.test) {
      ctx.log.info(`TEST sent to ${result.to} · Resend id ${result.externalId} · message left as APPROVED, not SENT`);
    } else {
      ctx.log.info(`sent to ${result.to} · Resend id ${result.externalId}`);
    }
    return;
  }

  if (ctx.dryRun) {
    throw new Error(
      'drafting outreach calls the Anthropic API to write copy — --dry-run is not supported. (Did you mean --send --dry-run?)',
    );
  }

  if (!ctx.flags.handle) {
    throw new Error('Pass --handle to draft, --approve <id> to approve a draft, or --send <id> to send an approved email.');
  }

  const channel = parseChannel(String(ctx.flags.channel ?? 'email'));
  const result = await draftOutreach(
    String(ctx.flags.handle),
    channel,
    Number(ctx.flags.sequence ?? 1),
    Number(ctx.flags.variants ?? 2),
  );

  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  for (const draft of result.drafts) {
    ctx.log.info(`--- variant ${draft.variant} (${draft.channel}, sequence ${draft.sequence}) ---`);
    if (draft.channel === 'EMAIL') {
      ctx.log.info(`From: ${OUTREACH_SENDER.name} <${OUTREACH_SENDER.email}>`);
      ctx.log.info(`To: ${draft.to ?? '(no business email found — fill in before sending)'}`);
      ctx.log.info(`Subject: ${draft.subject ?? '(none)'}`);
    }
    console.log(draft.body);
    console.log('');
  }
  ctx.log.info(`${result.drafts.length} draft(s) saved as DRAFT — review and approve before sending.`);
});
