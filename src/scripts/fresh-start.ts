import { runCli, type CliSpec } from '../lib/cli.js';
import { prisma } from '../lib/db.js';
import { FRESH_START } from '../lib/constants.js';

// One-off, run 2026-10-15: retire every creator found before the fresh start.
// No rows are deleted — they stay so the finder can dedupe against them.
//  - every creator → status RETIRED (reason FRESH_START.reason), review flags cleared
//    (the pending Claude-in-Chrome quote verification is dropped)
//  - anyone with a SENT message (incl. replied, e.g. a live conversation handled by
//    hand) → doNotContact: never contacted by this system again
//  - every DRAFT / APPROVED message for them → CANCELLED

export const spec: CliSpec = {
  name: 'fresh-start',
  summary: 'Retire every existing creator and cancel their pending messages (one-off). --dry-run counts only.',
  flags: {},
};

await runCli(spec, async (ctx) => {
  const creators = await prisma.creator.findMany({
    where: { status: { not: 'RETIRED' } },
    include: { messages: { select: { id: true, status: true, sentAt: true } } },
  });
  const contacted = creators.filter((c) => c.messages.some((m) => m.sentAt));
  const pending = creators.flatMap((c) => c.messages.filter((m) => m.status === 'DRAFT' || m.status === 'APPROVED'));
  const report = {
    creatorsToRetire: creators.length,
    doNotContact: contacted.length,
    mayBeRediscovered: creators.length - contacted.length,
    pendingToCancel: pending.length,
    pendingByStatus: { DRAFT: pending.filter((m) => m.status === 'DRAFT').length, APPROVED: pending.filter((m) => m.status === 'APPROVED').length },
    reviewFlagsToClear: creators.filter((c) => c.reviewFlag).length,
  };
  if (ctx.dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...report }, null, 2));
    return;
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.outreachMessage.updateMany({
      where: { id: { in: pending.map((m) => m.id) } },
      data: { status: 'CANCELLED', heldFor: `cancelled: creator retired (${FRESH_START.reason})` },
    }),
    prisma.creator.updateMany({
      where: { id: { in: contacted.map((c) => c.id) } },
      data: { doNotContact: true },
    }),
    prisma.creator.updateMany({
      where: { id: { in: creators.map((c) => c.id) } },
      data: { status: 'RETIRED', retiredAt: now, retiredReason: FRESH_START.reason, reviewFlag: null, reviewFlaggedAt: null },
    }),
  ]);
  console.log(JSON.stringify({ done: true, ...report }, null, 2));
});
