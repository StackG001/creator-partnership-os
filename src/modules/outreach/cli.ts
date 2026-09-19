import { runCli, type CliSpec } from '../../lib/cli.js';
import { OUTREACH_CHANNELS, OUTREACH_SENDER, type OutreachChannel } from '../../lib/constants.js';
import { approveOutreachMessage, draftOutreach, sendOutreachMessage } from './index.js';

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
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to write to (drafting mode).' },
    channel: { type: 'string', description: 'email | ig_dm | yt_about | x_dm | manual.', default: 'email' },
    sequence: { type: 'string', description: '1 = first touch, 2+ = follow-up.', default: '1' },
    variants: { type: 'string', description: 'How many variants to draft.', default: '2' },
    approve: { type: 'string', description: 'Mark a DRAFT OutreachMessage id as APPROVED.' },
    send: { type: 'string', description: 'Send an APPROVED OutreachMessage id via Resend (EMAIL only).' },
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

await runCli(spec, async (ctx) => {
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
    const result = await sendOutreachMessage(String(ctx.flags.send), { dryRun: ctx.dryRun });
    if (ctx.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.dryRun) {
      ctx.log.info('Dry run complete — nothing was sent. Re-run without --dry-run to go live.');
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
