import { prisma } from '../../lib/db.js';
import { createLogger, type Logger } from '../../lib/logger.js';
import { ensureCreatorDir, toRelative, writeArtifact, writeJsonArtifact } from '../../lib/paths.js';
import { collect, resolveTarget, type CollectOptions, type CollectedAudit } from './collect.js';
import { runExtraction, runSynthesis } from './passes.js';
import { renderAuditMarkdown } from './render.js';
import type { Audit, AuditSourceSummary } from './schema.js';
import type { completeJSON } from '../../lib/llm.js';

/**
 * The audit module: collect evidence, extract signals, synthesise the read,
 * write audit.json and audit.md under outputs/<handle>/audit/.
 */

export interface AuditOptions extends Omit<CollectOptions, 'log'> {
  chunkSize?: number;
  dryRun?: boolean;
  log?: Logger;
  completeJsonFn?: typeof completeJSON;
  /** Skip the model passes and only report what collection found. */
  collectOnly?: boolean;
}

export interface AuditResult {
  handle: string;
  audit?: Audit;
  summary: AuditSourceSummary;
  collected: CollectedAudit;
  paths: { json?: string; markdown?: string };
  models: { extraction: string; synthesis: string };
  extractionFailures: string[];
}

export async function auditCreator(options: AuditOptions): Promise<AuditResult> {
  const log = options.log ?? createLogger('audit');

  const collected = await collect({ ...options, log });
  const handle = collected.profile.handle;

  if (options.collectOnly) {
    return {
      handle,
      summary: collected.summary,
      collected,
      paths: {},
      models: { extraction: '(skipped)', synthesis: '(skipped)' },
      extractionFailures: [],
    };
  }

  const passOptions = {
    log,
    ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
    ...(options.completeJsonFn ? { completeJsonFn: options.completeJsonFn } : {}),
  };

  const extraction = await runExtraction(collected, passOptions);
  const { audit, model: synthesisModel } = await runSynthesis(collected, extraction, passOptions);

  const paths: AuditResult['paths'] = {};

  if (!options.dryRun) {
    await ensureCreatorDir(handle);

    const jsonPath = await writeJsonArtifact(handle, 'audit', 'audit.json', {
      handle,
      generatedAt: new Date().toISOString(),
      source: collected.summary,
      models: { extraction: extraction.model, synthesis: synthesisModel },
      audit,
    });

    const markdownPath = await writeArtifact(
      handle,
      'audit',
      'audit.md',
      renderAuditMarkdown(audit, collected.summary, {
        extractionModel: extraction.model,
        synthesisModel,
        generatedAt: new Date().toISOString(),
      }),
    );

    paths.json = toRelative(jsonPath);
    paths.markdown = toRelative(markdownPath);

    // Persist against the Creator when we already know them. An audit of a
    // creator the finder has never seen still writes its artifacts.
    const creator = await prisma.creator.findUnique({ where: { handle } });
    if (creator) {
      await prisma.audit.create({
        data: {
          creatorId: creator.id,
          summary: audit.niche,
          audienceProfile: audit.audiencePersona as object,
          painPoints: audit.top10Pains as unknown as object,
          productAngles: audit.productOpportunities as unknown as object,
          toneNotes: JSON.stringify(audit.voiceGuide),
          sampleSize: collected.summary.postsAnalysed,
          evidence: {
            comments: collected.summary.commentsAnalysed,
            palette: collected.palette,
            gaps: collected.summary.gaps,
          } as object,
          raw: audit as unknown as object,
          artifactPath: paths.markdown,
          model: synthesisModel,
        },
      });

      // The audit sees things discovery cannot: whether the creator replies to
      // their audience, and whether they sell in their own comments. Both
      // correct fields the finder could only guess at from a bio.
      const sellsInComments = collected.selfPromoSignals.length > 0;

      await prisma.creator.update({
        where: { id: creator.id },
        data: {
          status: 'AUDITED',
          brandProfile: { voiceGuide: audit.voiceGuide, visualStyle: audit.visualStyle } as object,
          brandAt: new Date(),
          outputDir: `outputs/${handle}`,
          ...(sellsInComments
            ? {
                hasDigitalProduct: true,
                productEvidence: {
                  source: 'audit: creator promotes in their own comments',
                  signals: collected.selfPromoSignals,
                } as object,
              }
            : {}),
          monetization: {
            repliesToComments: collected.repliesToComments,
            sellsInOwnComments: sellsInComments,
          } as object,
        },
      });

      if (sellsInComments) {
        log.warn(
          `${handle} sells in their own comments — hasDigitalProduct corrected to true. Re-run the scorer.`,
        );
      }
      log.info(`creator ${handle} -> AUDITED`);
    } else {
      log.warn(`${handle} is not in the database — artifacts written, no Audit row created.`);
    }
  }

  return {
    handle,
    audit,
    summary: collected.summary,
    collected,
    paths,
    models: { extraction: extraction.model, synthesis: synthesisModel },
    extractionFailures: extraction.failures,
  };
}

export { collect, resolveTarget };
