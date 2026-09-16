import { runCli, type CliSpec } from '../../lib/cli.js';
import { auditCreator } from './index.js';

export const spec: CliSpec = {
  name: 'audit',
  summary: "Research-backed audit of a creator's audience, pains and product angles.",
  examples: [
    'npm run audit -- --handle grantbakes',
    'npm run audit -- --handle grantbakes --posts 40 --refresh',
    'npm run audit -- --handle grantbakes --dry-run',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to audit.', required: true },
    posts: { type: 'string', description: 'How many recent posts/videos to analyse.', default: '30' },
    refresh: { type: 'boolean', description: 'Re-fetch source content instead of using cached artifacts.' },
  },
};

await runCli(spec, async ({ flags, dryRun, json }) => {
  const result = await auditCreator(String(flags.handle), {
    postCount: Number(flags.posts),
    refresh: flags.refresh === true,
    dryRun,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (dryRun) {
    console.log('\nDry run: sample fetched and cached, model not called, nothing written.');
    return;
  }

  console.log(`\n${result.handle} — opportunity ${result.opportunityScore}/100`);
  console.log('\nProduct angles:');
  for (const [i, angle] of result.productAngles.entries()) {
    console.log(`  ${i + 1}. ${angle.title}  (${Math.round(angle.confidence * 100)}% confidence)`);
    console.log(`     ${angle.promise}`);
  }
  console.log(`\nWritten to ${result.artifactPath}`);
});
