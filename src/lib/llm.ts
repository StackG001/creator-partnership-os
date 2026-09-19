import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getEnv } from './env.js';
import { createLogger } from './logger.js';

/**
 * The one place the system talks to a model.
 *
 *   completeText  — prose in, prose out.
 *   completeJSON  — prose in, schema-validated object out.
 *
 * completeJSON forces a tool call whose input schema is derived from the zod
 * schema you pass, then parses the tool input back through zod. If validation
 * fails the model is shown its own error and asked again, up to LLM_MAX_RETRIES.
 * Callers therefore never handle raw model text or hand-written JSON.parse.
 */

const log = createLogger('llm');

/** Which model to use. Tiers resolve through .env so we can re-point globally. */
export type ModelTier = 'fast' | 'default' | 'heavy';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResult<T> {
  data: T;
  model: string;
  usage: LlmUsage;
  /** How many model calls it took, including retries after invalid JSON. */
  attempts: number;
  stopReason: string | null;
}

export interface ImageInput {
  /** Base64-encoded image bytes, no data: prefix. */
  data: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

interface BaseOptions {
  /** System prompt: role, constraints, output rules. */
  system: string;
  /** User prompt: the actual task and its inputs. */
  prompt: string;
  /** Images to attach before the prompt text, for vision reads (e.g. visual style). */
  images?: ImageInput[];
  /** Pick a tier, or pass `model` to name one explicitly. */
  tier?: ModelTier;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Shows up in logs and trace filenames, e.g. "audit:pain-points". */
  label?: string;
  /** Prior turns, for multi-step flows that keep context. */
  messages?: Anthropic.MessageParam[];
}

/** Builds the user message content: plain string, or image blocks + text when images are attached. */
function userContent(options: BaseOptions): Anthropic.MessageParam['content'] {
  if (!options.images?.length) return options.prompt;
  return [
    ...options.images.map(
      (image): Anthropic.ImageBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      }),
    ),
    { type: 'text', text: options.prompt },
  ];
}

export interface CompleteJsonOptions<T> extends BaseOptions {
  schema: z.ZodType<T>;
  /** Tool name shown to the model. Defaults to "respond". */
  schemaName?: string;
  /** What the structured response is for. Helps the model fill it correctly. */
  schemaDescription?: string;
  retries?: number;
}

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  if (client) return client;
  const env = getEnv();
  client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    // Network-level retries (429s, 5xx, overloaded) are the SDK's job.
    maxRetries: 3,
  });
  return client;
}

/** Test seam: drop the memoised client (e.g. after changing env). */
export function resetLlmClient(): void {
  client = undefined;
}

export function resolveModel(opts: { model?: string; tier?: ModelTier } = {}): string {
  if (opts.model) return opts.model;
  const env = getEnv();
  switch (opts.tier ?? 'default') {
    case 'fast':
      return env.ANTHROPIC_MODEL_FAST;
    case 'heavy':
      return env.ANTHROPIC_MODEL_HEAVY;
    default:
      return env.ANTHROPIC_MODEL;
  }
}

function readUsage(message: Anthropic.Message): LlmUsage {
  return {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Anthropic wants a JSON Schema object at the top level. Non-object zod schemas
 * (arrays, unions, primitives) get wrapped in { result: ... } and unwrapped
 * again after validation.
 */
function toToolSchema(schema: z.ZodType<unknown>): {
  jsonSchema: Record<string, unknown>;
  wrapped: boolean;
} {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as Record<
    string,
    unknown
  >;
  delete raw.$schema;

  if (raw.type === 'object') return { jsonSchema: raw, wrapped: false };

  return {
    jsonSchema: {
      type: 'object',
      properties: { result: raw },
      required: ['result'],
      additionalProperties: false,
    },
    wrapped: true,
  };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

async function trace(label: string, payload: unknown): Promise<void> {
  const env = getEnv();
  if (!env.LLM_TRACE) return;
  try {
    const dir = path.resolve(process.cwd(), env.OUTPUTS_DIR, '_llm');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = label.replace(/[^a-z0-9._-]/gi, '_');
    await fs.writeFile(
      path.join(dir, `${stamp}-${safe}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8',
    );
  } catch (error) {
    log.warn(`could not write trace for ${label}`, String(error));
  }
}

/** Streaming under the hood: long product-writing calls would otherwise time out. */
async function send(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  return anthropic().messages.stream(params).finalMessage();
}

/** Plain text completion. Use completeJSON whenever the output has a shape. */
export async function completeText(options: BaseOptions): Promise<LlmResult<string>> {
  const env = getEnv();
  const model = resolveModel(options);
  const label = options.label ?? 'text';

  const messages: Anthropic.MessageParam[] = [
    ...(options.messages ?? []),
    { role: 'user', content: userContent(options) },
  ];

  const started = Date.now();
  const message = await send({
    model,
    max_tokens: options.maxTokens ?? env.LLM_MAX_TOKENS,
    temperature: options.temperature ?? 1,
    system: options.system,
    messages,
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const usage = readUsage(message);
  log.debug(
    `${label} · ${model} · ${usage.inputTokens}in/${usage.outputTokens}out · ${Date.now() - started}ms`,
  );
  await trace(label, { model, system: options.system, prompt: options.prompt, text, usage });

  return { data: text, model, usage, attempts: 1, stopReason: message.stop_reason };
}

/**
 * Schema-validated completion.
 *
 *   const { data } = await completeJSON({
 *     system: 'You audit creator audiences.',
 *     prompt: `Analyse: ${JSON.stringify(posts)}`,
 *     schema: z.object({ painPoints: z.array(z.string()).min(3) }),
 *     tier: 'heavy',
 *   });
 *
 * `data` is typed and validated — if it comes back, it matched the schema.
 */
export async function completeJSON<T>(
  options: CompleteJsonOptions<T>,
): Promise<LlmResult<T>> {
  const env = getEnv();
  const model = resolveModel(options);
  const label = options.label ?? options.schemaName ?? 'json';
  const maxRetries = options.retries ?? env.LLM_MAX_RETRIES;
  const toolName = options.schemaName ?? 'respond';
  const { jsonSchema, wrapped } = toToolSchema(options.schema as z.ZodType<unknown>);

  const tool: Anthropic.Tool = {
    name: toolName,
    description:
      options.schemaDescription ??
      'Return the answer as structured data matching the schema exactly.',
    input_schema: jsonSchema as Anthropic.Tool.InputSchema,
  };

  const messages: Anthropic.MessageParam[] = [
    ...(options.messages ?? []),
    { role: 'user', content: userContent(options) },
  ];

  let usage = EMPTY_USAGE;
  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const started = Date.now();
    const message = await send({
      model,
      max_tokens: options.maxTokens ?? env.LLM_MAX_TOKENS,
      temperature: options.temperature ?? 1,
      system: options.system,
      messages,
      tools: [tool],
      tool_choice: { type: 'tool', name: toolName },
    });

    usage = addUsage(usage, readUsage(message));

    // If the model emits more than one tool_use in a turn, the last one is the
    // one it "settled on" — validate against that, not whichever came first.
    let toolUse: Anthropic.ToolUseBlock | undefined;
    for (const block of message.content) {
      if (block.type === 'tool_use') toolUse = block;
    }

    if (!toolUse) {
      lastError = `The model returned no ${toolName} tool call (stop_reason: ${message.stop_reason}).`;
      if (message.stop_reason === 'max_tokens') {
        throw new Error(
          `[llm:${label}] hit max_tokens (${options.maxTokens ?? env.LLM_MAX_TOKENS}) before completing the response. Raise maxTokens or split the task.`,
        );
      }
    } else {
      const candidate = wrapped
        ? (toolUse.input as { result?: unknown }).result
        : toolUse.input;
      const parsed = options.schema.safeParse(candidate);

      if (parsed.success) {
        log.debug(
          `${label} · ${model} · attempt ${attempt} · ${usage.inputTokens}in/${usage.outputTokens}out · ${Date.now() - started}ms`,
        );
        await trace(label, {
          model,
          system: options.system,
          prompt: options.prompt,
          data: parsed.data,
          usage,
          attempts: attempt,
        });
        return {
          data: parsed.data,
          model,
          usage,
          attempts: attempt,
          stopReason: message.stop_reason,
        };
      }

      lastError = formatZodError(parsed.error);
      // Every tool_use block in this turn needs a matching tool_result — the API
      // rejects the next request otherwise. The model can emit more than one
      // (e.g. a stray duplicate call) even with tool_choice forcing a single tool.
      const toolUseBlocks = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      messages.push(
        { role: 'assistant', content: message.content },
        {
          role: 'user',
          content: toolUseBlocks.map((block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: true,
            content:
              block.id === toolUse.id
                ? `Your response did not match the schema:\n${lastError}\n\nCall ${toolName} again with corrected data. Do not explain, just call the tool.`
                : 'Ignored — superseded by another tool call in the same turn.',
          })),
        },
      );
    }

    log.warn(`${label}: attempt ${attempt}/${maxRetries + 1} invalid — ${lastError}`);
  }

  await trace(`${label}-failed`, {
    model,
    system: options.system,
    prompt: options.prompt,
    lastError,
    usage,
  });

  throw new Error(
    `[llm:${label}] no schema-valid response after ${maxRetries + 1} attempts. Last error:\n${lastError}`,
  );
}

/** Cheap connectivity probe. Used by `npm run doctor`. */
export async function ping(model?: string): Promise<{ model: string; ok: boolean }> {
  const target = model ?? resolveModel({ tier: 'fast' });
  const message = await anthropic().messages.create({
    model: target,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  });
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .toLowerCase();
  return { model: target, ok: text.includes('ok') };
}
