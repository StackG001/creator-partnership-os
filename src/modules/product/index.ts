import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { createLogger } from '../../lib/logger.js';
import { PRODUCT_SPEC } from '../../lib/constants.js';
import {
  creatorDir,
  ensureCreatorDir,
  normalizeHandle,
  toRelative,
  writeArtifact,
  writeJsonArtifact,
} from '../../lib/paths.js';
import { webSearch, type SearchResult } from '../../lib/sources/webSearch.js';
import { getEnv } from '../../lib/env.js';

const log = createLogger('product');

export type ProductStage = 'research' | 'outline' | 'write' | 'render' | 'all';

export interface ProductBuildResult {
  productId: string;
  title: string;
  pageCount: number;
  wordCount: number;
  htmlPath: string;
  pdfPath: string;
  sources: number;
}

// --- audit evidence (read back out of Audit.raw) --------------------------------

const AuditEvidenceSchema = z.object({
  niche: z.string(),
  audiencePersona: z.object({ who: z.string(), situation: z.string(), triedAlready: z.string() }),
  top10Pains: z.array(
    z.object({ pain: z.string(), quote: z.string(), source: z.string(), postRef: z.string() }),
  ),
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
    z.object({
      title: z.string(),
      promise: z.string(),
      whoItsFor: z.string(),
      whyItFits: z.string(),
      score: z.number(),
      priceBand: z.string(),
      recommended: z.boolean(),
    }),
  ),
  hookLines: z.array(z.string()),
  partnershipPitchAngle: z.string(),
});
type AuditEvidence = z.infer<typeof AuditEvidenceSchema>;
type ProductOpportunity = AuditEvidence['productOpportunities'][number];

async function loadAuditEvidence(creatorId: string): Promise<AuditEvidence> {
  const audit = await prisma.audit.findFirst({ where: { creatorId }, orderBy: { createdAt: 'desc' } });
  if (!audit) {
    throw new Error('No audit found for this creator — run `npm run audit -- --handle <handle>` first.');
  }
  const parsed = AuditEvidenceSchema.safeParse(audit.raw);
  if (!parsed.success) {
    throw new Error(
      `Audit data doesn't match the expected shape — re-run the audit. (${parsed.error.issues[0]?.message})`,
    );
  }
  return parsed.data;
}

function pickOpportunity(evidence: AuditEvidence, angle?: number): ProductOpportunity {
  if (angle && evidence.productOpportunities[angle - 1]) return evidence.productOpportunities[angle - 1]!;
  return (
    evidence.productOpportunities.find((o) => o.recommended) ?? evidence.productOpportunities[0]!
  );
}

function priceBandToCents(band: string): number {
  const numbers = [...band.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (!numbers.length) return 3900;
  const mid = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  return Math.round(mid) * 100;
}

// --- stage 1: research ------------------------------------------------------------

export interface Source {
  id: number;
  query: string;
  title: string;
  url: string;
  snippet: string;
}

const ClaimSchema = z.object({
  claim: z.string().describe('one concrete, usable fact — a number, a range, a technique, a rule of thumb'),
  sourceIds: z.array(z.number()).min(1),
});
const ClaimsSchema = z.object({ claims: z.array(ClaimSchema) });
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Hand-authored, not LLM-brainstormed: these map directly onto the content the
 * product must cover (timing tables, temperature adjustment, fridge-to-loaf,
 * make-ahead/freeze points) plus the pains from the audit, so the query list
 * doesn't need a research pass of its own to be well-targeted.
 */
function researchQueries(opportunity: ProductOpportunity, evidence: AuditEvidence): string[] {
  return [
    'sourdough starter feeding schedule maintenance working full time',
    'sourdough starter phases rise fall float test explained',
    'sourdough fridge cold retard timing temperature guide',
    'cold retard sourdough temperature chart 38 40 degrees fahrenheit',
    'sourdough same day bake fast schedule no overnight',
    'sourdough overnight bulk ferment room temperature schedule',
    'unfed sourdough starter straight from fridge to dough discard',
    "sourdough baker's percentage hydration ratio guide",
    'sourdough bulk fermentation temperature time relationship rule of thumb',
    'sourdough proofing temperature chart room temperature vs cold',
    'freeze sourdough dough before baking shaped par proofed',
    'freeze baked sourdough bread reheat crust',
    'make ahead sourdough shape freeze bake later weekend',
    'sourdough enriched dough bulk ferment timing brioche sandwich bread',
    'sourdough troubleshooting dense crumb no oven spring causes',
    'sourdough troubleshooting gummy crumb underbaked fix',
    'sourdough scoring ear technique blade angle',
    'sourdough baking schedule busy full time job nine to five',
    'sourdough weeknight baking schedule after work',
    'sourdough cold kitchen winter proofing temperature tips',
    'sourdough dutch oven vs proofing box steam comparison',
    'sourdough pizza dough make ahead fridge schedule',
    `sourdough ${opportunity.whoItsFor}`,
    `sourdough troubleshooting ${evidence.top10Pains[0]?.pain ?? ''}`,
  ].map((q) => q.trim()).filter(Boolean);
}

function dedupeSources(results: Array<{ query: string; result: SearchResult }>): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  let id = 1;
  for (const { query, result } of results) {
    const key = result.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key) || !result.snippet) continue;
    seen.add(key);
    sources.push({ id: id++, query, title: result.title, url: result.url, snippet: result.snippet });
  }
  return sources;
}

async function runResearch(
  opportunity: ProductOpportunity,
  evidence: AuditEvidence,
): Promise<{ sources: Source[]; claims: Claim[] }> {
  const queries = researchQueries(opportunity, evidence);
  log.info(`research: ${queries.length} search queries`);

  const raw: Array<{ query: string; result: SearchResult }> = [];
  for (const query of queries) {
    try {
      const results = await webSearch(query, 10);
      raw.push(...results.map((result) => ({ query, result })));
    } catch (error) {
      log.warn(`search failed for "${query}"`, String(error));
    }
  }

  const sources = dedupeSources(raw);
  log.info(`research: ${sources.length} unique sources from ${raw.length} raw results`);

  const CHUNK = 25;
  const chunks: Source[][] = [];
  for (let i = 0; i < sources.length; i += CHUNK) chunks.push(sources.slice(i, i + CHUNK));

  const claimBatches = await Promise.all(
    chunks.map(async (chunk, i) => {
      const { data } = await completeJSON({
        system: [
          'Extract concrete, usable facts from these search-result snippets for a baking guide about scheduling sourdough around a full-time job.',
          'Only extract facts that are actually stated in the snippet text — numbers, ranges, techniques, rules of thumb. Do not infer beyond what is written.',
          'Every claim must cite the sourceIds (the numeric id) of every snippet that supports it. Skip snippets with nothing concrete to extract.',
        ].join('\n'),
        prompt: chunk
          .map((s) => `[${s.id}] ${s.title}\n${s.snippet}`)
          .join('\n\n'),
        schema: ClaimsSchema,
        schemaName: 'extract_claims',
        tier: 'fast',
        label: `product:research-claims:${i}`,
        maxTokens: 2048,
      });
      return data.claims;
    }),
  );

  const claims = claimBatches.flat();
  log.info(`research: ${claims.length} claims extracted`);

  return { sources, claims };
}

// --- stage 2: outline / transformation map -----------------------------------------

const ChapterPlanSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  goal: z.string().describe('what the reader can do after this chapter that they could not before'),
  sections: z.array(z.object({ heading: z.string(), keyPoints: z.array(z.string()).min(2).max(4) })).min(2).max(4),
  includesTable: z.boolean().describe('true if this chapter should include a timing/temperature/schedule table'),
  includesFreezePoint: z.boolean().describe('true if this chapter should include a make-ahead/freeze callout'),
  targetWords: z.number().min(600).max(2200),
});

const FrontMatterSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  promise: z.string(),
  audience: z.string(),
  transformationMap: z.object({
    from: z.string().describe('where the reader is now — specific, drawn from the audience persona'),
    to: z.string().describe('where the reader ends up after using this'),
    bridges: z.array(z.string()).min(3).max(6).describe('the key shifts that get them from "from" to "to", one per major chapter cluster'),
  }),
});

const ChaptersOnlySchema = z.object({
  chapters: z.array(ChapterPlanSchema).min(7).max(9),
});

const OutlineSchema = FrontMatterSchema.extend({ chapters: ChaptersOnlySchema.shape.chapters });
export type Outline = z.infer<typeof OutlineSchema>;

/**
 * Two calls, not one: a combined schema (front matter + chapters) proved too
 * much for the model to fill reliably in a single structured turn — it kept
 * emitting a placeholder/garbage value for `chapters` instead of the array.
 * Splitting the "small, easy" fields from the "large, hard" array fixes it.
 */
async function runOutline(
  opportunity: ProductOpportunity,
  evidence: AuditEvidence,
  claims: Claim[],
  targetWords: number,
  titleOverride?: string,
): Promise<Outline> {
  const baseSystem = [
    'You are outlining a research-backed digital product (a 35-50 page guide, rendered as a branded PDF) for Creator Partnership OS.',
    'The product must read as ONE coherent transformation, not a loose pile of tips: map exactly where the reader is stuck now, where they end up, and the bridges between.',
    'Ground every chapter in the audience\'s actual stated pains and situation — do not write a generic sourdough book.',
  ].join('\n');

  const context = [
    titleOverride ? `Required title: "${titleOverride}"` : `Working title: "${opportunity.title}"`,
    `Promise: ${opportunity.promise}`,
    `Who it's for: ${opportunity.whoItsFor}`,
    `Why it fits this audience: ${opportunity.whyItFits}`,
    '',
    `Audience: ${evidence.audiencePersona.who}`,
    `Situation: ${evidence.audiencePersona.situation}`,
    `Already tried: ${evidence.audiencePersona.triedAlready}`,
    '',
    'Top audience pains to address (from real comments):',
    ...evidence.top10Pains.slice(0, 10).map((p) => `- ${p.pain}`),
    '',
    `Partnership pitch angle (the core insight): ${evidence.partnershipPitchAngle}`,
  ].join('\n');

  const { data: frontMatter } = await completeJSON({
    system: baseSystem,
    prompt: context,
    schema: FrontMatterSchema,
    schemaName: 'product_front_matter',
    tier: 'heavy',
    label: 'product:outline-front-matter',
    maxTokens: 2048,
  });
  if (titleOverride) frontMatter.title = titleOverride;

  const chaptersPrompt = [
    context,
    '',
    `Title: ${frontMatter.title}`,
    `Subtitle: ${frontMatter.subtitle}`,
    `Transformation — from: ${frontMatter.transformationMap.from}`,
    `Transformation — to: ${frontMatter.transformationMap.to}`,
    `Bridges: ${frontMatter.transformationMap.bridges.join(' | ')}`,
    '',
    `Research claims available to draw on (${claims.length} total, sample):`,
    ...claims.slice(0, 40).map((c) => `- ${c.claim}`),
    '',
    `Plan 7-9 chapters whose targetWords sum to roughly ${targetWords} words (a ${Math.round(targetWords / PRODUCT_SPEC.wordsPerPage)}-page PDF).`,
    'Across the chapters (not all in one place) you MUST cover: timing tables, temperature adjustment guidance, fridge-to-loaf schedules, and make-ahead/freeze points — mark the chapters that carry each with includesTable / includesFreezePoint.',
  ].join('\n');

  const { data: chaptersData } = await completeJSON({
    system: [
      baseSystem,
      'This call has ONE job: produce the `chapters` array. Nothing else.',
    ].join('\n'),
    prompt: chaptersPrompt,
    schema: ChaptersOnlySchema,
    schemaName: 'product_chapters',
    tier: 'heavy',
    label: 'product:outline-chapters',
    maxTokens: 8192,
  });

  return { ...frontMatter, chapters: chaptersData.chapters };
}

// --- stage 3: write chapters ---------------------------------------------------------

const BlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), level: z.union([z.literal(2), z.literal(3)]), text: z.string() }),
  z.object({ type: z.literal('paragraph'), text: z.string() }),
  z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()).min(2) }),
  z.object({
    type: z.literal('table'),
    caption: z.string().optional(),
    headers: z.array(z.string()).min(2),
    rows: z.array(z.array(z.string())).min(1),
  }),
  z.object({
    type: z.literal('callout'),
    label: z.string().describe('e.g. "Make ahead", "Freeze point", "Cold kitchen fix"'),
    text: z.string(),
  }),
]);
export type ContentBlock = z.infer<typeof BlockSchema>;

const ChapterSchema = z.object({ title: z.string(), blocks: z.array(BlockSchema).min(4) });
export type Chapter = z.infer<typeof ChapterSchema>;

function wordCount(blocks: ContentBlock[]): number {
  let words = 0;
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') words += b.text.split(/\s+/).filter(Boolean).length;
    else if (b.type === 'list') words += b.items.join(' ').split(/\s+/).filter(Boolean).length;
    else if (b.type === 'callout') words += b.text.split(/\s+/).filter(Boolean).length;
    else if (b.type === 'table') words += b.rows.flat().join(' ').split(/\s+/).filter(Boolean).length;
  }
  return words;
}

async function writeChapter(
  chapterPlan: Outline['chapters'][number],
  evidence: AuditEvidence,
  claims: Claim[],
  chapterIndex: number,
  totalChapters: number,
): Promise<Chapter> {
  const relevantClaims = claims.filter((c) =>
    chapterPlan.sections.some((s) =>
      s.keyPoints.some((kp) => c.claim.toLowerCase().split(/\s+/).some((w) => w.length > 4 && kp.toLowerCase().includes(w))),
    ),
  );
  const claimPool = (relevantClaims.length >= 5 ? relevantClaims : claims).slice(0, 25);

  const system = [
    "You write one chapter of a digital guide in the creator's own voice — not your voice, theirs.",
    'Voice guide (follow exactly):',
    `- Tone: ${evidence.voiceGuide.toneAdjectives.join(', ')}`,
    `- Sentence rhythm: ${evidence.voiceGuide.sentenceLength}`,
    `- Signature phrases to use naturally where they fit: ${evidence.voiceGuide.signaturePhrases.join(', ') || '—'}`,
    `- Never use these words: ${evidence.voiceGuide.neverUsesWords.join(', ') || '—'}`,
    `- Emoji: ${evidence.voiceGuide.emojiUsage}`,
    `- This chapter is ${chapterIndex + 1} of ${totalChapters} — write in second person ("you"), as if the reader bought this because they trust this creator.`,
    'Use ONLY the content blocks in the schema. Weave research claims in naturally (no academic citation style — just state the fact as something you know). Never invent a specific number that is not in the provided claims; when you need a number not in the claims, give a reasoned range and say it depends on their kitchen.',
    chapterPlan.includesTable
      ? 'This chapter MUST include at least one `table` block — a real timing/temperature/schedule table with specific values from the claims provided.'
      : '',
    chapterPlan.includesFreezePoint
      ? 'This chapter MUST include at least one `callout` block labeled about make-ahead or freezing.'
      : '',
    `Target length: roughly ${chapterPlan.targetWords} words across all blocks.`,
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = [
    `Chapter title: ${chapterPlan.title}`,
    `Chapter goal: ${chapterPlan.goal}`,
    'Sections to cover:',
    ...chapterPlan.sections.map((s) => `- ${s.heading}: ${s.keyPoints.join('; ')}`),
    '',
    `Audience: ${evidence.audiencePersona.who} — ${evidence.audiencePersona.situation}`,
    '',
    'Research claims available for this chapter (use the specific numbers/ranges where relevant):',
    ...claimPool.map((c) => `- ${c.claim}`),
  ].join('\n');

  const { data } = await completeJSON({
    system,
    prompt,
    schema: ChapterSchema,
    schemaName: 'write_chapter',
    tier: 'heavy',
    label: `product:chapter:${chapterPlan.slug}`,
    maxTokens: 8192,
  });

  return data;
}

// --- stage 4: render -------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function blockToHtml(block: ContentBlock): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${escapeHtml(block.text)}</p>`;
    case 'list':
      return `<${block.ordered ? 'ol' : 'ul'}>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`;
    case 'table':
      return [
        '<table>',
        block.caption ? `<caption>${escapeHtml(block.caption)}</caption>` : '',
        `<thead><tr>${block.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`,
        `<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`,
        '</table>',
      ]
        .filter(Boolean)
        .join('');
    case 'callout':
      return `<div class="callout"><span class="callout-label">${escapeHtml(block.label)}</span><p>${escapeHtml(block.text)}</p></div>`;
  }
}

/** Serif for a warm/handwritten/casual feel, sans-serif for bold/clean/modern — both are web-safe, no external font loading. */
function pickFontStack(fontFeel: string): { heading: string; body: string } {
  const casual = /handwritten|script|playful|casual|friendly/i.test(fontFeel);
  return casual
    ? { heading: "'Segoe UI', 'Trebuchet MS', sans-serif", body: "Georgia, 'Times New Roman', serif" }
    : { heading: "'Helvetica Neue', Arial, sans-serif", body: "Georgia, 'Times New Roman', serif" };
}

function buildHtml(input: {
  outline: Outline;
  chapters: Chapter[];
  evidence: AuditEvidence;
  displayName: string;
  furtherReading: Source[];
}): string {
  const { outline, chapters, evidence, displayName, furtherReading } = input;
  const colors = evidence.visualStyle.dominantColors;
  const accent = colors[colors.length - 1]?.hex && /^#[0-9a-fA-F]{6}$/.test(colors.at(-1)!.hex) ? colors.at(-1)!.hex : '#8B5A2B';
  const dark = colors.find((c) => /black|dark/i.test(c.name))?.hex ?? '#1a1a1a';
  const light = colors.find((c) => /white|cream|tan|light/i.test(c.name))?.hex ?? '#F7F3EC';
  const fonts = pickFontStack(evidence.visualStyle.fontFeel);

  const toc = chapters
    .map((c, i) => `<li><a href="#chapter-${i + 1}">${i + 1}. ${escapeHtml(c.title)}</a></li>`)
    .join('');

  const chaptersHtml = chapters
    .map(
      (c, i) =>
        `<section class="chapter" id="chapter-${i + 1}"><h1>${i + 1}. ${escapeHtml(c.title)}</h1>${c.blocks.map(blockToHtml).join('\n')}</section>`,
    )
    .join('\n');

  const readingHtml = furtherReading
    .map((s) => `<li>${escapeHtml(s.title)} — <span class="url">${escapeHtml(s.url)}</span></li>`)
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(outline.title)}</title>
<style>
  @page { size: A4; margin: 22mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: ${fonts.body}; color: ${dark}; line-height: 1.55; font-size: 12pt; }
  h1, h2, h3 { font-family: ${fonts.heading}; color: ${dark}; }
  h1 { font-size: 22pt; border-bottom: 3px solid ${accent}; padding-bottom: 6px; margin-top: 0; }
  h2 { font-size: 16pt; color: ${accent}; margin-top: 28px; }
  h3 { font-size: 13pt; margin-top: 18px; }
  p { margin: 10px 0; }
  .cover { page-break-after: always; text-align: center; padding-top: 30%; }
  .cover h1 { border: none; font-size: 30pt; }
  .cover .subtitle { font-size: 15pt; color: ${accent}; margin-top: 10px; }
  .cover .for { margin-top: 60px; font-size: 11pt; color: #666; }
  .toc { page-break-after: always; }
  .toc ol { line-height: 2; }
  .toc a { color: ${dark}; text-decoration: none; }
  .chapter { page-break-before: always; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 10.5pt; }
  caption { text-align: left; font-weight: bold; margin-bottom: 4px; }
  th { background: ${accent}; color: ${light}; text-align: left; padding: 6px 8px; }
  td { border-bottom: 1px solid #ddd; padding: 6px 8px; }
  tr:nth-child(even) td { background: ${light}; }
  .callout { background: ${light}; border-left: 4px solid ${accent}; padding: 10px 14px; margin: 14px 0; border-radius: 4px; }
  .callout-label { font-weight: bold; color: ${accent}; text-transform: uppercase; font-size: 9.5pt; letter-spacing: 0.5px; display: block; margin-bottom: 4px; }
  ul, ol { margin: 10px 0; padding-left: 22px; }
  li { margin: 4px 0; }
  .reading { page-break-before: always; font-size: 10pt; }
  .reading li { margin-bottom: 6px; }
  .reading .url { color: #666; font-size: 9pt; word-break: break-all; }
</style>
</head>
<body>
  <div class="cover">
    <h1>${escapeHtml(outline.title)}</h1>
    <div class="subtitle">${escapeHtml(outline.subtitle)}</div>
    <div class="for">By ${escapeHtml(displayName)}</div>
  </div>
  <div class="toc">
    <h1>Contents</h1>
    <ol>${toc}</ol>
  </div>
  ${chaptersHtml}
  <section class="reading">
    <h1>Further Reading &amp; Sources</h1>
    <p>This guide draws on ${furtherReading.length}+ baking resources, forums and technique guides. A selection for further reading:</p>
    <ul>${readingHtml}</ul>
  </section>
</body>
</html>`;
}

/** Leaf `/Type /Page` objects (excludes `/Type /Pages` tree nodes) — a reliable count for Chromium/Skia-produced PDFs without an external PDF library. */
function countPdfPages(pdf: Buffer): number | null {
  const matches = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches?.length || null;
}

/** Returns the real page count on success, or null if the render failed (HTML is still available either way). */
async function renderPdf(html: string, outPath: string, timeoutMs = 30_000): Promise<number | null> {
  try {
    const { chromium } = await import('playwright');
    const env = getEnv();
    const browser = await chromium.launch({
      ...(env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      await fs.writeFile(outPath, pdf);
      return countPdfPages(pdf);
    } finally {
      await browser.close();
    }
  } catch (error) {
    log.warn(`PDF render failed — HTML is still available. (${String(error).split('\n')[0]})`);
    return null;
  }
}

// --- orchestration -----------------------------------------------------------------

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function getOrCreateProduct(
  creatorId: string,
  title: string,
  opportunity: ProductOpportunity,
): Promise<string> {
  const existing = await prisma.product.findFirst({ where: { creatorId, title } });
  if (existing) return existing.id;
  const created = await prisma.product.create({
    data: {
      creatorId,
      title,
      promise: opportunity.promise,
      audience: opportunity.whoItsFor,
      priceCents: priceBandToCents(opportunity.priceBand),
      status: 'RESEARCHING',
    },
  });
  return created.id;
}

export interface ProductBuildOptions {
  angle?: number;
  pages?: number;
  stage?: ProductStage;
  resume?: boolean;
  refresh?: boolean;
  title?: string;
}

export async function buildProduct(
  handleOrUrl: string,
  options: ProductBuildOptions = {},
): Promise<ProductBuildResult> {
  const handle = normalizeHandle(handleOrUrl);
  const stage = options.stage ?? 'all';
  const pages = Math.min(PRODUCT_SPEC.maxPages, Math.max(PRODUCT_SPEC.minPages, options.pages ?? 40));
  const targetWords = pages * PRODUCT_SPEC.wordsPerPage;

  const creator = await prisma.creator.findUnique({ where: { handle } });
  if (!creator) throw new Error(`No creator found for handle "${handle}" — run the audit first.`);

  const evidence = await loadAuditEvidence(creator.id);
  const opportunity = pickOpportunity(evidence, options.angle);
  const title = options.title ?? opportunity.title;

  const dir = await ensureCreatorDir(handle);
  const productDir = path.join(dir, 'product');
  const researchDir = path.join(dir, 'research');
  const chaptersDir = path.join(productDir, 'chapters');
  await fs.mkdir(chaptersDir, { recursive: true });

  const sourcesPath = path.join(researchDir, 'sources.json');
  const claimsPath = path.join(researchDir, 'claims.json');
  const outlinePath = path.join(productDir, 'outline.json');

  const productId = await getOrCreateProduct(creator.id, title, opportunity);

  // --- stage 1: research ---
  const forceResearch = options.refresh && (stage === 'research' || stage === 'all');
  let sources = forceResearch ? null : await readJsonIfExists<Source[]>(sourcesPath);
  let claims = forceResearch ? null : await readJsonIfExists<Claim[]>(claimsPath);

  if (sources && claims) {
    log.info(`research: using cached ${sources.length} sources (pass refresh to re-fetch)`);
  } else {
    log.info('research: fetching (this is the expensive stage — ~20 search queries)');
    const result = await runResearch(opportunity, evidence);
    sources = result.sources;
    claims = result.claims;
    await fs.writeFile(sourcesPath, JSON.stringify(sources, null, 2), 'utf8');
    await fs.writeFile(claimsPath, JSON.stringify(claims, null, 2), 'utf8');
  }

  await prisma.product.update({
    where: { id: productId },
    data: { researchPath: toRelative(sourcesPath), research: JSON.parse(JSON.stringify(claims)) },
  });

  if (stage === 'research') {
    return { productId, title, pageCount: 0, wordCount: 0, htmlPath: '', pdfPath: '', sources: sources.length };
  }

  // --- stage 2: outline ---
  const forceOutline = options.refresh && (stage === 'outline' || stage === 'all');
  let outline = forceOutline ? null : await readJsonIfExists<Outline>(outlinePath);

  if (outline) {
    log.info(`outline: using cached outline (${outline.chapters.length} chapters)`);
  } else {
    log.info('outline: building transformation map + chapter plan');
    outline = await runOutline(opportunity, evidence, claims, targetWords, options.title ?? opportunity.title);
    await fs.writeFile(outlinePath, JSON.stringify(outline, null, 2), 'utf8');
  }

  await prisma.product.update({
    where: { id: productId },
    data: {
      title: outline.title,
      subtitle: outline.subtitle,
      promise: outline.promise,
      audience: outline.audience,
      outline: JSON.parse(JSON.stringify(outline)),
      status: 'OUTLINED',
    },
  });

  if (stage === 'outline') {
    return { productId, title: outline.title, pageCount: 0, wordCount: 0, htmlPath: '', pdfPath: '', sources: sources.length };
  }

  // --- stage 3: write chapters ---
  const forceWrite = options.refresh && (stage === 'write' || stage === 'all');
  const chapters: Chapter[] = [];

  for (const [i, plan] of outline.chapters.entries()) {
    const chapterPath = path.join(chaptersDir, `${plan.slug}.json`);
    let chapter = forceWrite ? null : await readJsonIfExists<Chapter>(chapterPath);
    if (chapter) {
      log.info(`write: chapter ${i + 1}/${outline.chapters.length} "${plan.title}" — cached`);
    } else {
      log.info(`write: chapter ${i + 1}/${outline.chapters.length} "${plan.title}"`);
      chapter = await writeChapter(plan, evidence, claims, i, outline.chapters.length);
      await fs.writeFile(chapterPath, JSON.stringify(chapter, null, 2), 'utf8');
    }
    chapters.push(chapter);
  }

  const totalWords = chapters.reduce((sum, c) => sum + wordCount(c.blocks), 0);
  const chaptersBySlug = Object.fromEntries(outline.chapters.map((p, i) => [p.slug, chapters[i]]));

  await prisma.product.update({
    where: { id: productId },
    data: {
      chapters: JSON.parse(JSON.stringify(chaptersBySlug)),
      wordCount: totalWords,
      status: 'WRITING',
    },
  });

  if (stage === 'write') {
    return { productId, title: outline.title, pageCount: Math.round(totalWords / PRODUCT_SPEC.wordsPerPage), wordCount: totalWords, htmlPath: '', pdfPath: '', sources: sources.length };
  }

  // --- stage 4: render ---
  log.info('render: assembling HTML');
  const furtherReading = pickFurtherReading(sources);
  const html = buildHtml({ outline, chapters, evidence, displayName: creator.displayName ?? handle, furtherReading });
  const htmlPath = await writeArtifact(handle, 'product', 'product.html', html);

  const pdfPath = path.join(productDir, 'product.pdf');
  log.info('render: attempting PDF via Playwright');
  const pdfPageCount = await renderPdf(html, pdfPath);
  const pdfOk = pdfPageCount !== null;

  const pageCount = pdfPageCount ?? Math.round(totalWords / PRODUCT_SPEC.wordsPerPage);
  const brandTheme = {
    dominantColors: evidence.visualStyle.dominantColors,
    fontFeel: evidence.visualStyle.fontFeel,
    layoutHabits: evidence.visualStyle.layoutHabits,
  };

  await prisma.product.update({
    where: { id: productId },
    data: {
      htmlPath: toRelative(htmlPath),
      pdfPath: pdfOk ? toRelative(pdfPath) : null,
      pageCount,
      brandTheme: JSON.parse(JSON.stringify(brandTheme)),
      status: 'RENDERED',
      model: 'multi-pass (research=fast, outline/write=heavy)',
    },
  });

  log.info(
    pdfOk
      ? `done: ${pageCount} actual PDF pages (~${totalWords} words), PDF rendered`
      : `done: ~${pageCount} pages estimated from word count (~${totalWords} words), PDF render failed — HTML only (see warning above)`,
  );

  return {
    productId,
    title: outline.title,
    pageCount,
    wordCount: totalWords,
    htmlPath: toRelative(htmlPath),
    pdfPath: pdfOk ? toRelative(pdfPath) : '',
    sources: sources.length,
  };
}

/** A curated subset for the printed bibliography — the full research pool stays in research/sources.json. */
function pickFurtherReading(sources: Source[], limit = 25): Source[] {
  const byHost = new Map<string, Source>();
  for (const s of sources) {
    try {
      const host = new URL(s.url).hostname.replace(/^www\./, '');
      if (!byHost.has(host)) byHost.set(host, s);
    } catch {
      /* skip */
    }
  }
  return [...byHost.values()].slice(0, limit);
}
