import fs from 'node:fs/promises';
import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { createLogger } from '../../lib/logger.js';
import { artifactPath, toRelative, writeArtifact, writeJsonArtifact } from '../../lib/paths.js';
import { getRecentVideos, getTopComments, resolveChannel, type Comment, type Video } from '../../lib/youtube.js';

/**
 * The evidence pack every later module cites: what this creator talks about,
 * who listens, what those people are stuck on, and what would sell to them.
 *
 * Everything the model says has to be traceable to something a human could go
 * and read — a video, a comment — which is why the schema demands a quote for
 * each pain point and why the fetched sample is cached to disk next to the
 * finished audit. An audit whose evidence cannot be checked is worse than none,
 * because everything downstream quotes it as fact.
 */

const log = createLogger('audit');

/** How much of the sample carries comment evidence. Each video costs 1 unit. */
const COMMENT_VIDEOS = 12;
const COMMENTS_PER_VIDEO = 12;

const pillar = z.object({
  pillar: z.string().describe('The recurring subject, in the creator’s own framing.'),
  share: z.number().min(0).max(1).describe('Roughly what fraction of the sampled uploads this covers.'),
  examplePostUrls: z.array(z.string()).describe('URLs of sampled videos that show this pillar.'),
});

const painPoint = z.object({
  pain: z.string().describe('The problem the audience has, stated the way they would state it.'),
  evidence: z.string().describe('A short verbatim quote from the supplied comments. Never paraphrase here.'),
  frequency: z.enum(['rare', 'occasional', 'common', 'dominant']),
  severity: z.enum(['mild', 'moderate', 'acute']),
});

const productAngle = z.object({
  title: z.string().describe('The product title, in the creator’s voice.'),
  promise: z.string().describe('The point-A-to-point-B transformation, concretely.'),
  whyThisCreator: z.string().describe('Why this creator specifically can sell this, citing their content.'),
  confidence: z.number().min(0).max(1),
});

export const auditSchema = z.object({
  summary: z.string().describe('Three or four sentences: who this is, who watches, and the opportunity.'),
  contentPillars: z.array(pillar).min(2).max(6),
  audienceProfile: z.object({
    demographics: z.string().describe('Who they appear to be, hedged honestly where the evidence is thin.'),
    sophistication: z.enum(['beginner', 'mixed', 'intermediate', 'advanced']),
    jobsToBeDone: z.array(z.string()).min(1).describe('What the audience is trying to accomplish.'),
  }),
  painPoints: z.array(painPoint).min(3).max(10).describe('Ranked, most pressing first.'),
  monetizationGaps: z.array(
    z.object({
      gap: z.string(),
      why: z.string(),
      existingAlternatives: z.string().describe('What the audience does today instead, free or paid.'),
    }),
  ).min(1).max(5),
  productAngles: z.array(productAngle).min(3).max(5).describe('Ranked, strongest first.'),
  toneNotes: z.string().describe('How the creator speaks: register, pacing, habits, things they never say.'),
  risks: z.string().describe('What would make this partnership fail. Be concrete and unflattering.'),
  opportunityScore: z.number().min(0).max(100).describe('Verdict on product-fit for this creator.'),
  confidence: z.number().min(0).max(1).describe('How well the supplied evidence supported this read.'),
});

export type AuditData = z.infer<typeof auditSchema>;

export interface AuditResult {
  handle: string;
  auditId: string;
  opportunityScore: number;
  productAngles: Array<{ title: string; promise: string; confidence: number }>;
  artifactPath: string;
}

interface Sample {
  videos: Video[];
  comments: Comment[];
  fetchedAt: string;
}

const sampleSchema = z.object({
  videos: z.array(z.custom<Video>()),
  comments: z.array(z.custom<Comment>()),
  fetchedAt: z.string(),
});

/**
 * Fetch the content the audit reads, or reuse what a previous run already
 * fetched. Caching is not just about quota: re-running an audit against the
 * same sample is how you tell a prompt change from a data change.
 */
async function loadSample(handle: string, channelInput: string, posts: number, refresh: boolean): Promise<Sample> {
  const cachePath = artifactPath(handle, 'audit', 'source.json');

  if (!refresh) {
    try {
      const cached: unknown = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      const parsed = sampleSchema.safeParse(cached);
      if (parsed.success && parsed.data.videos.length > 0) {
        log.info(`reusing cached sample from ${parsed.data.fetchedAt.slice(0, 19)} (--refresh to re-fetch)`);
        return parsed.data;
      }
    } catch {
      // No usable cache: fall through and fetch.
    }
  }

  const channel = await resolveChannel(channelInput);
  if (!channel) throw new Error(`YouTube no longer resolves "${channelInput}" — the channel may have been removed.`);

  const videos = await getRecentVideos(channel, posts);
  log.info(`fetched ${videos.length} videos`);

  const byViews = [...videos].sort((a, b) => b.views - a.views).slice(0, COMMENT_VIDEOS);
  const comments: Comment[] = [];
  for (const video of byViews) {
    comments.push(...(await getTopComments(video.id, COMMENTS_PER_VIDEO)));
  }
  log.info(`fetched ${comments.length} comments across ${byViews.length} videos`);

  const sample: Sample = { videos, comments, fetchedAt: new Date().toISOString() };
  await writeJsonArtifact(handle, 'audit', 'source.json', sample);
  return sample;
}

const SYSTEM = `You audit a creator's audience to find what they would pay for.

You will be given a channel's recent uploads and the top comments on them. Everything you conclude must be supported by that material. Rules:

- Quote comments verbatim as evidence for pain points. Never invent or paraphrase a quote.
- If the evidence is thin, say so and lower your confidence. A hedged, honest audit is useful; a confident, invented one is actively harmful, because every later step quotes this as fact.
- Pain points are what the AUDIENCE struggles with, not what the creator covers well.
- A product angle must be something the audience is already trying and failing to do, that this specific creator is credible teaching.
- Write risks as a sceptic would. Flattery here costs real money later.`;

function buildPrompt(displayName: string, handle: string, sample: Sample, niche?: string | null): string {
  const videos = sample.videos
    .map(
      (v) =>
        `- "${v.title}" — ${v.views.toLocaleString()} views, ${v.likes.toLocaleString()} likes, ${v.comments.toLocaleString()} comments (${v.publishedAt.slice(0, 10)})\n  ${v.url}\n  ${v.description.slice(0, 300).replace(/\s+/g, ' ')}`,
    )
    .join('\n');

  const byVideo = new Map<string, Comment[]>();
  for (const c of sample.comments) {
    byVideo.set(c.videoId, [...(byVideo.get(c.videoId) ?? []), c]);
  }
  const titleOf = new Map(sample.videos.map((v) => [v.id, v.title]));
  const comments = [...byVideo.entries()]
    .map(([videoId, list]) =>
      [
        `On "${titleOf.get(videoId) ?? videoId}":`,
        ...list.map((c) => `  [${c.likes} likes] ${c.text.slice(0, 400).replace(/\s+/g, ' ')}`),
      ].join('\n'),
    )
    .join('\n\n');

  return [
    `Creator: ${displayName} (@${handle})`,
    niche ? `Niche: ${niche}` : '',
    '',
    `RECENT UPLOADS (${sample.videos.length}):`,
    videos,
    '',
    `TOP COMMENTS (${sample.comments.length}):`,
    comments || '(no comments were available — say so and lower your confidence)',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The human-readable artifact. Rendered from validated data, never by a model. */
export function renderAuditMarkdown(
  meta: { displayName: string; handle: string; url?: string | null; followers?: number | null; generatedAt: string; model: string; sampleSize: number; commentCount: number },
  audit: AuditData,
): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  // null = omitted line; '' = a deliberate blank that separates paragraphs.
  const lines: Array<string | null> = [
    `# Audit — ${meta.displayName}`,
    '',
    `**Handle:** @${meta.handle}  `,
    meta.url ? `**Channel:** ${meta.url}  ` : null,
    meta.followers ? `**Subscribers:** ${meta.followers.toLocaleString()}  ` : null,
    `**Opportunity score:** ${audit.opportunityScore}/100  `,
    `**Confidence:** ${pct(audit.confidence)}  `,
    `**Evidence:** ${meta.sampleSize} videos, ${meta.commentCount} comments  `,
    `**Generated:** ${meta.generatedAt.slice(0, 19).replace('T', ' ')} UTC by ${meta.model}`,
    '',
    '## Summary',
    '',
    audit.summary,
    '',
    '## Content pillars',
    '',
    ...audit.contentPillars.flatMap((p) => [
      `### ${p.pillar} — ${pct(p.share)} of output`,
      '',
      ...p.examplePostUrls.map((u) => `- ${u}`),
      '',
    ]),
    '## Audience',
    '',
    `**Who they are:** ${audit.audienceProfile.demographics}`,
    '',
    `**Sophistication:** ${audit.audienceProfile.sophistication}`,
    '',
    '**Jobs to be done:**',
    '',
    ...audit.audienceProfile.jobsToBeDone.map((j) => `- ${j}`),
    '',
    '## Pain points',
    '',
    '| Pain | Frequency | Severity |',
    '| --- | --- | --- |',
    ...audit.painPoints.map((p) => `| ${p.pain.replace(/\|/g, '\\|')} | ${p.frequency} | ${p.severity} |`),
    '',
    '### Evidence',
    '',
    ...audit.painPoints.flatMap((p) => [`**${p.pain}**`, '', `> ${p.evidence.replace(/\n/g, ' ')}`, '']),
    '## Monetisation gaps',
    '',
    ...audit.monetizationGaps.flatMap((g) => [
      `### ${g.gap}`,
      '',
      g.why,
      '',
      `*Today they use:* ${g.existingAlternatives}`,
      '',
    ]),
    '## Product angles',
    '',
    ...audit.productAngles.flatMap((a, i) => [
      `### ${i + 1}. ${a.title}`,
      '',
      `**Promise:** ${a.promise}`,
      '',
      `**Why this creator:** ${a.whyThisCreator}`,
      '',
      `**Confidence:** ${pct(a.confidence)}`,
      '',
    ]),
    '## Voice',
    '',
    audit.toneNotes,
    '',
    '## Risks',
    '',
    audit.risks,
    '',
    '---',
    '',
    `*Generated by the audit module from ${meta.sampleSize} videos and ${meta.commentCount} comments. Every quote above is verbatim from the cached sample in \`audit/source.json\`.*`,
  ];
  return (
    lines
      .filter((line): line is string => line !== null)
      .join('\n')
      // Collapse any run of blank lines the conditionals left behind, so the
      // document has exactly one blank line between blocks.
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

export interface AuditOptions {
  postCount?: number;
  refresh?: boolean;
  dryRun?: boolean;
}

export async function auditCreator(handle: string, options: AuditOptions = {}): Promise<AuditResult> {
  const { postCount = 30, refresh = false, dryRun = false } = options;

  const creator = await prisma.creator.findUnique({ where: { handle } });
  if (!creator) throw new Error(`No creator "${handle}". Run the finder first.`);

  const channelInput = creator.profileUrl ?? handle;
  const sample = await loadSample(handle, channelInput, postCount, refresh);

  if (sample.videos.length === 0) {
    throw new Error(`No uploads found for "${handle}" — there is nothing to audit.`);
  }

  if (dryRun) {
    log.info(
      `dry run: ${sample.videos.length} videos and ${sample.comments.length} comments ready; model not called, nothing written`,
    );
    return {
      handle,
      auditId: '(dry-run)',
      opportunityScore: 0,
      productAngles: [],
      artifactPath: toRelative(artifactPath(handle, 'audit', 'audit.md')),
    };
  }

  const result = await completeJSON({
    schema: auditSchema,
    schemaName: 'creator_audit',
    schemaDescription: 'The full evidence-backed audit of this creator and their audience.',
    system: SYSTEM,
    prompt: buildPrompt(creator.displayName ?? handle, handle, sample, creator.niche),
    tier: 'heavy',
    label: 'audit:full',
  });

  const generatedAt = new Date().toISOString();
  const markdown = renderAuditMarkdown(
    {
      displayName: creator.displayName ?? handle,
      handle,
      url: creator.profileUrl,
      followers: creator.followers,
      generatedAt,
      model: result.model,
      sampleSize: sample.videos.length,
      commentCount: sample.comments.length,
    },
    result.data,
  );

  const mdPath = await writeArtifact(handle, 'audit', 'audit.md', markdown);
  await writeJsonArtifact(handle, 'audit', 'audit.json', result.data);

  const audit = await prisma.audit.create({
    data: {
      creatorId: creator.id,
      summary: result.data.summary,
      contentPillars: result.data.contentPillars as object,
      audienceProfile: result.data.audienceProfile as object,
      painPoints: result.data.painPoints as object,
      monetizationGaps: result.data.monetizationGaps as object,
      productAngles: result.data.productAngles as object,
      toneNotes: result.data.toneNotes,
      risks: result.data.risks,
      opportunityScore: Math.round(result.data.opportunityScore),
      confidence: result.data.confidence,
      sampleSize: sample.videos.length,
      evidence: {
        videoUrls: sample.videos.map((v) => v.url),
        commentCount: sample.comments.length,
        fetchedAt: sample.fetchedAt,
      } as object,
      raw: result.data as object,
      artifactPath: toRelative(mdPath),
      model: result.model,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      // costCents stays null: this repo holds no price table, and a guessed
      // cost in a money column is worse than an absent one.
    },
  });

  // A disqualified creator keeps that status; auditing does not requalify them.
  if (creator.status === 'DISCOVERED' || creator.status === 'SCORED') {
    await prisma.creator.update({ where: { handle }, data: { status: 'AUDITED' } });
  }

  log.info(`${handle}: opportunity ${result.data.opportunityScore}/100 → ${toRelative(mdPath)}`);

  return {
    handle,
    auditId: audit.id,
    opportunityScore: Math.round(result.data.opportunityScore),
    productAngles: result.data.productAngles.map((a) => ({
      title: a.title,
      promise: a.promise,
      confidence: a.confidence,
    })),
    artifactPath: toRelative(mdPath),
  };
}
