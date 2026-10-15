import { runCli, type CliSpec } from '../../lib/cli.js';
import { queueData, startDmQueue } from './index.js';

export const spec: CliSpec = {
  name: 'dm-queue',
  summary: 'Serve the DM queue page (phone + laptop): approved, unsent DMs with Copy & open / Sent / Skip. Never sends anything itself.',
  examples: ['npm run dm-queue', 'npm run dm-queue -- --list'],
  flags: {
    list: { type: 'boolean', description: 'Print the queue instead of serving the page.' },
    host: { type: 'string', description: 'Interface to bind (0.0.0.0 = reachable from your phone on the same network).', default: '0.0.0.0' },
  },
};

await runCli(spec, async (ctx) => {
  if (ctx.flags.list) {
    const q = await queueData();
    console.log(ctx.json ? JSON.stringify(q, null, 2) : [
      `Ready to send: ${q.ready.length}`,
      ...q.ready.map((m) => `- @${m.handle} · ${m.channel} seq ${m.sequence} · ${m.open}`),
      `Drafts to approve: ${q.drafts.length}`,
      ...q.drafts.map((m) => `- @${m.handle} · ${m.channel} seq ${m.sequence} variant ${m.variant} · ${m.id}`),
    ].join('\n'));
    return;
  }
  await startDmQueue(String(ctx.flags.host ?? '0.0.0.0'));
  await new Promise(() => {}); // serve until Ctrl-C
});
