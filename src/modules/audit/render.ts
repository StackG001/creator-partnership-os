import type { Audit, AuditSourceSummary } from './schema.js';

/**
 * audit.md — the human-readable face of audit.json.
 *
 * Written to be read before an outreach message is drafted, so quotes and their
 * sources sit next to every claim and the "what we could not see" section is
 * near the top rather than buried.
 */

function quoteBlock(quote: string): string {
  return quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function sourceLink(source: { type: string; reference: string; label?: string }): string {
  if (source.type === 'bio') return '_bio_';
  if (!source.reference) return `_${source.type}_`;
  const label = source.label?.trim() || source.reference;
  return `[${label.slice(0, 70)}](${source.reference})`;
}

export function renderAuditMarkdown(
  audit: Audit,
  summary: AuditSourceSummary,
  meta: { extractionModel: string; synthesisModel: string; generatedAt?: string },
): string {
  const recommended = audit.productOpportunities.find((o) => o.recommended);
  const lines: string[] = [];

  lines.push(`# Audit — @${summary.handle}`);
  lines.push('');
  lines.push(
    `_${summary.platform} · ${summary.postsAnalysed} posts · ${summary.commentsAnalysed} comments · ` +
      `${summary.imagesSampled} images · generated ${meta.generatedAt ?? summary.collectedAt}_`,
  );
  lines.push('');

  // --- the one thing to read first ------------------------------------------
  lines.push('## Lead with this');
  lines.push('');
  lines.push(audit.partnershipPitchAngle);
  lines.push('');

  if (recommended) {
    lines.push(`**Recommended product:** ${recommended.title} — ${recommended.promise} (${recommended.priceBand}, scored ${recommended.score}/10)`);
    lines.push('');
  }

  if (summary.gaps.length) {
    lines.push('> [!NOTE]');
    lines.push('> **What this audit could not see**');
    for (const gap of summary.gaps) lines.push(`> - ${gap}`);
    lines.push('');
  }

  // --- 1. niche + persona ----------------------------------------------------
  lines.push('## 1. Niche and audience');
  lines.push('');
  lines.push(`**Niche.** ${audit.niche}`);
  lines.push('');
  lines.push(`**Who they are.** ${audit.audiencePersona.who}`);
  lines.push('');
  lines.push(`**Their situation.** ${audit.audiencePersona.situation}`);
  lines.push('');
  lines.push('**What they have already tried**');
  lines.push('');
  for (const tried of audit.audiencePersona.whatTheyveTried) lines.push(`- ${tried}`);
  lines.push('');

  // --- 2. pains --------------------------------------------------------------
  lines.push('## 2. Top 10 pains');
  lines.push('');
  lines.push('Every pain below is quoted from a real comment or caption.');
  lines.push('');
  audit.top10Pains.forEach((pain, index) => {
    lines.push(`### ${index + 1}. ${pain.pain}`);
    lines.push('');
    lines.push(`\`${pain.severity} severity\` · \`${pain.frequency}\` · ${sourceLink(pain.source)}`);
    lines.push('');
    lines.push(quoteBlock(pain.quote));
    lines.push('');
  });

  // --- 3. voice --------------------------------------------------------------
  const voice = audit.voiceGuide;
  lines.push('## 3. Voice guide');
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| Tone | ${voice.toneAdjectives.join(', ')} |`);
  lines.push(`| Sentence length | ${voice.sentenceLength} |`);
  lines.push(`| Emoji | ${voice.emojiUsage} |`);
  lines.push(`| Opens with | ${voice.howTheyOpen} |`);
  lines.push(`| Closes with | ${voice.howTheyClose} |`);
  lines.push('');
  lines.push('**Signature phrases**');
  lines.push('');
  for (const phrase of voice.signaturePhrases) lines.push(`- "${phrase}"`);
  lines.push('');
  if (voice.neverUses.length) {
    lines.push('**Never uses** — avoid these entirely when writing as them');
    lines.push('');
    for (const word of voice.neverUses) lines.push(`- ${word}`);
    lines.push('');
  }

  // --- 4. visual -------------------------------------------------------------
  lines.push('## 4. Visual style');
  lines.push('');
  if (audit.visualStyle.dominantColors.length) {
    lines.push('| Colour | Share | Role |');
    lines.push('| --- | ---: | --- |');
    for (const color of audit.visualStyle.dominantColors) {
      lines.push(`| \`${color.hex}\` | ${(color.share * 100).toFixed(1)}% | ${color.role} |`);
    }
    lines.push('');
    lines.push('_Hex values measured from real post images, not estimated._');
  } else {
    lines.push('_No images could be sampled, so no measured palette. Do not guess one._');
  }
  lines.push('');
  lines.push(`**Type.** ${audit.visualStyle.fontFeel}`);
  lines.push('');
  lines.push(`**Layout habits.** ${audit.visualStyle.layoutHabits}`);
  lines.push('');

  // --- 5. products -----------------------------------------------------------
  lines.push('## 5. Product opportunities');
  lines.push('');
  const ranked = [...audit.productOpportunities].sort((a, b) => b.score - a.score);
  for (const opportunity of ranked) {
    lines.push(`### ${opportunity.recommended ? '★ ' : ''}${opportunity.title}`);
    lines.push('');
    lines.push(`\`${opportunity.score}/10\` · \`${opportunity.priceBand}\`${opportunity.recommended ? ' · **recommended**' : ''}`);
    lines.push('');
    lines.push(`**Promise.** ${opportunity.promise}`);
    lines.push('');
    lines.push(`**For.** ${opportunity.whoItsFor}`);
    lines.push('');
    lines.push(`**Why it fits.** ${opportunity.whyItFits}`);
    lines.push('');
    lines.push(`**The pocket.** ${opportunity.pocket.specificPerson} — already trying to fix: ${opportunity.pocket.problemTheyAreAlreadyFixing}`);
    lines.push('');
  }

  // --- 6. hooks --------------------------------------------------------------
  lines.push('## 6. Hook lines');
  lines.push('');
  lines.push("In the creator's voice — usable as-is in a post, a sales page or outreach.");
  lines.push('');
  audit.hookLines.forEach((hook, index) => lines.push(`${index + 1}. ${hook}`));
  lines.push('');

  // --- provenance ------------------------------------------------------------
  lines.push('---');
  lines.push('');
  lines.push(
    `Extraction: \`${meta.extractionModel}\` · Synthesis: \`${meta.synthesisModel}\` · ` +
      `Collected ${summary.collectedAt}`,
  );
  lines.push('');

  return lines.join('\n');
}
