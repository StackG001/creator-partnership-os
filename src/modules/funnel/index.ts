import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { createLogger } from '../../lib/logger.js';
import { normalizeHandle, toRelative, writeArtifact } from '../../lib/paths.js';

const log = createLogger('funnel');

export interface FunnelCopy {
  salesPage: {
    headline: string;
    subhead: string;
    problem: string;
    sections: Array<{ heading: string; body: string }>;
    bullets: string[];
    faq: Array<{ q: string; a: string }>;
    guarantee: string;
    cta: string;
  };
  orderBump: { title: string; pitch: string; priceCents: number };
  upsell: { title: string; pitch: string; priceCents: number };
}

// --- evidence loading ------------------------------------------------------------

const AuditEvidenceSchema = z.object({
  niche: z.string(),
  audiencePersona: z.object({ who: z.string(), situation: z.string(), triedAlready: z.string() }),
  top10Pains: z.array(z.object({ pain: z.string(), quote: z.string(), source: z.string(), postRef: z.string() })),
  voiceGuide: z.object({
    toneAdjectives: z.array(z.string()),
    sentenceLength: z.string(),
    signaturePhrases: z.array(z.string()),
    neverUsesWords: z.array(z.string()),
    emojiUsage: z.string(),
    opensWith: z.string(),
    closesWith: z.string(),
  }),
  visualStyle: z.object({
    dominantColors: z.array(z.object({ hex: z.string(), name: z.string() })),
    fontFeel: z.string(),
    layoutHabits: z.string(),
  }),
  productOpportunities: z.array(
    z.object({ title: z.string(), promise: z.string(), whoItsFor: z.string(), priceBand: z.string(), recommended: z.boolean() }),
  ),
  hookLines: z.array(z.string()),
  partnershipPitchAngle: z.string(),
});
type AuditEvidence = z.infer<typeof AuditEvidenceSchema>;

async function loadAuditEvidence(creatorId: string): Promise<AuditEvidence> {
  const audit = await prisma.audit.findFirst({ where: { creatorId }, orderBy: { createdAt: 'desc' } });
  if (!audit) throw new Error('No audit found for this creator — run `npm run audit` first.');
  const parsed = AuditEvidenceSchema.safeParse(audit.raw);
  if (!parsed.success) {
    throw new Error(`Audit data doesn't match the expected shape — re-run the audit. (${parsed.error.issues[0]?.message})`);
  }
  return parsed.data;
}

interface OutlineLite {
  title: string;
  subtitle: string;
  promise: string;
  audience: string;
  transformationMap: { from: string; to: string; bridges: string[] };
  chapters: Array<{ title: string; goal: string }>;
}

async function loadProduct(creatorId: string, productId?: string) {
  const product = productId
    ? await prisma.product.findUnique({ where: { id: productId } })
    : await prisma.product.findFirst({ where: { creatorId }, orderBy: { createdAt: 'desc' } });

  if (!product) {
    throw new Error('No product found for this creator — run `npm run product` first.');
  }
  if (!product.outline) {
    throw new Error(`Product "${product.title}" has no outline yet — its build didn't reach the outline stage.`);
  }

  return { product, outline: product.outline as unknown as OutlineLite };
}

// --- copy generation ---------------------------------------------------------------

const FunnelSchema = z.object({
  salesPage: z.object({
    headline: z.string(),
    subhead: z.string(),
    problem: z.string().describe('names the specific pain, in the audience\'s own words where possible'),
    sections: z.array(z.object({ heading: z.string(), body: z.string() })).min(3).max(6),
    bullets: z.array(z.string()).min(5).max(10),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).min(3).max(7),
    guarantee: z.string(),
    cta: z.string(),
  }),
  orderBump: z.object({ title: z.string(), pitch: z.string() }),
  upsell: z.object({ title: z.string(), pitch: z.string() }),
});

async function generateCopy(
  evidence: AuditEvidence,
  outline: OutlineLite,
  bumpIdea: string,
  upsellIdea: string,
): Promise<z.infer<typeof FunnelSchema>> {
  const system = [
    "You write direct-response sales copy in the creator's own voice — not generic marketing-speak, not hype.",
    'Voice guide (follow exactly):',
    `- Tone: ${evidence.voiceGuide.toneAdjectives.join(', ')}`,
    `- Sentence rhythm: ${evidence.voiceGuide.sentenceLength}`,
    `- Signature phrases to use naturally: ${evidence.voiceGuide.signaturePhrases.join(', ') || '—'}`,
    `- Never use: ${evidence.voiceGuide.neverUsesWords.join(', ') || '—'}, and no generic hype words (game-changer, unlock, level up, secret).`,
    'The sales page must sell the transformation (from -> to), not just list chapters. Use the audience\'s real stated pains as proof you understand them. FAQ should pre-empt real objections drawn from what they say they already tried.',
    'The guarantee should be simple and match this creator\'s tone — not a corporate legal guarantee.',
    `Order bump idea to write a pitch for: ${bumpIdea}`,
    `Upsell idea to write a pitch for: ${upsellIdea}`,
  ].join('\n');

  const prompt = [
    `Product: ${outline.title} — ${outline.subtitle}`,
    `Promise: ${outline.promise}`,
    `Audience: ${outline.audience}`,
    '',
    `Transformation — from: ${outline.transformationMap.from}`,
    `Transformation — to: ${outline.transformationMap.to}`,
    `Bridges: ${outline.transformationMap.bridges.join(' | ')}`,
    '',
    'Chapters (what the buyer actually gets):',
    ...outline.chapters.map((c, i) => `${i + 1}. ${c.title} — ${c.goal}`),
    '',
    'Top audience pains (use their language):',
    ...evidence.top10Pains.slice(0, 8).map((p) => `- ${p.pain} — "${p.quote}"`),
    '',
    `Already tried (source of FAQ objections): ${evidence.audiencePersona.triedAlready}`,
    '',
    `Partnership pitch angle: ${evidence.partnershipPitchAngle}`,
  ].join('\n');

  const { data } = await completeJSON({
    system,
    prompt,
    schema: FunnelSchema,
    schemaName: 'funnel_copy',
    tier: 'heavy',
    label: 'funnel:copy',
    maxTokens: 4096,
  });
  return data;
}

// --- rendering -----------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function renderSalesPageHtml(copy: FunnelCopy, evidence: AuditEvidence, title: string): string {
  const colors = evidence.visualStyle.dominantColors;
  const accent = colors.find((c) => /^#[0-9a-fA-F]{6}$/.test(c.hex))?.hex ?? '#8B5A2B';
  const casual = /handwritten|script|playful|casual|friendly/i.test(evidence.visualStyle.fontFeel);
  const headingFont = casual ? "'Segoe UI', 'Trebuchet MS', sans-serif" : "'Helvetica Neue', Arial, sans-serif";

  const sp = copy.salesPage;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)} — Sales Page Preview</title>
<style>
  body { font-family: Georgia, serif; max-width: 720px; margin: 0 auto; padding: 40px 20px; line-height: 1.6; color: #1a1a1a; }
  h1, h2 { font-family: ${headingFont}; }
  h1 { font-size: 30pt; color: ${accent}; }
  .subhead { font-size: 14pt; color: #555; margin-bottom: 24px; }
  .problem { font-size: 13pt; background: #f7f3ec; border-left: 4px solid ${accent}; padding: 14px 18px; margin: 20px 0; }
  h2 { color: ${accent}; margin-top: 32px; }
  .bullets { list-style: none; padding: 0; }
  .bullets li { padding: 8px 0 8px 28px; position: relative; }
  .bullets li::before { content: "✓"; position: absolute; left: 0; color: ${accent}; font-weight: bold; }
  .faq dt { font-weight: bold; margin-top: 14px; }
  .faq dd { margin: 4px 0 0; color: #444; }
  .guarantee { background: #f7f3ec; padding: 16px; border-radius: 6px; margin: 24px 0; }
  .cta { display: inline-block; background: ${accent}; color: white; padding: 14px 28px; font-size: 14pt; border-radius: 6px; text-decoration: none; margin-top: 20px; }
  .addon { border: 1px solid #ddd; border-radius: 6px; padding: 16px; margin-top: 20px; }
  .addon .price { color: ${accent}; font-weight: bold; }
</style></head>
<body>
  <h1>${escapeHtml(sp.headline)}</h1>
  <div class="subhead">${escapeHtml(sp.subhead)}</div>
  <div class="problem">${escapeHtml(sp.problem)}</div>
  ${sp.sections.map((s) => `<h2>${escapeHtml(s.heading)}</h2><p>${escapeHtml(s.body)}</p>`).join('\n')}
  <h2>What's inside</h2>
  <ul class="bullets">${sp.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>
  <h2>Questions</h2>
  <dl class="faq">${sp.faq.map((f) => `<dt>${escapeHtml(f.q)}</dt><dd>${escapeHtml(f.a)}</dd>`).join('')}</dl>
  <div class="guarantee">${escapeHtml(sp.guarantee)}</div>
  <a class="cta" href="#checkout">${escapeHtml(sp.cta)}</a>

  <div class="addon">
    <strong>${escapeHtml(copy.orderBump.title)}</strong> <span class="price">+ ${money(copy.orderBump.priceCents)}</span>
    <p>${escapeHtml(copy.orderBump.pitch)}</p>
  </div>
  <div class="addon">
    <strong>${escapeHtml(copy.upsell.title)}</strong> <span class="price">${money(copy.upsell.priceCents)}</span>
    <p>${escapeHtml(copy.upsell.pitch)}</p>
  </div>
</body></html>`;
}

// --- orchestration ---------------------------------------------------------------

export interface FunnelPricing {
  priceCents: number;
  bumpPriceCents: number;
  upsellPriceCents: number;
}

export async function buildFunnel(
  handleOrUrl: string,
  pricing: FunnelPricing,
  productId?: string,
): Promise<FunnelCopy> {
  const handle = normalizeHandle(handleOrUrl);
  const creator = await prisma.creator.findUnique({ where: { handle } });
  if (!creator) throw new Error(`No creator found for handle "${handle}" — run the audit first.`);

  const evidence = await loadAuditEvidence(creator.id);
  const { product, outline } = await loadProduct(creator.id, productId);

  const otherOpportunities = evidence.productOpportunities.filter((o) => !o.recommended);
  const bumpIdea = 'a printable one-page quick-reference version of the core timing table(s) from the guide';
  const upsellIdea = otherOpportunities[0]
    ? `${otherOpportunities[0].title} — ${otherOpportunities[0].promise}`
    : 'a 1:1 troubleshooting session to fix their specific kitchen/schedule';

  log.info(`writing sales page + order bump + upsell for "${outline.title}"`);
  const generated = await generateCopy(evidence, outline, bumpIdea, upsellIdea);

  const copy: FunnelCopy = {
    salesPage: generated.salesPage,
    orderBump: { ...generated.orderBump, priceCents: pricing.bumpPriceCents },
    upsell: { ...generated.upsell, priceCents: pricing.upsellPriceCents },
  };

  const html = renderSalesPageHtml(copy, evidence, outline.title);
  const salesPagePath = await writeArtifact(handle, 'funnel', 'sales-page.html', html);

  await prisma.product.update({
    where: { id: product.id },
    data: {
      funnel: JSON.parse(JSON.stringify(copy)),
      funnelPath: toRelative(salesPagePath),
      priceCents: pricing.priceCents,
      bumpPriceCents: pricing.bumpPriceCents,
      upsellPriceCents: pricing.upsellPriceCents,
    },
  });

  log.info(`sales page: ${toRelative(salesPagePath)}`);
  return copy;
}
