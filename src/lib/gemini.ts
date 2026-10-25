import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { getEnv } from './env.js';
import { createLogger } from './logger.js';

/**
 * Gemini fallback for src/lib/llm.ts — used only when Anthropic is unavailable
 * (no credits, key rejected, rate-limited, down) and GEMINI_API_KEY is set.
 *
 * It takes the exact Anthropic request llm.ts builds and returns an
 * Anthropic-shaped Message, so completeText/completeJSON (and their schema
 * retries) run unchanged. A forced tool call becomes Gemini's JSON mode
 * (responseJsonSchema) rather than Gemini function calling, which avoids
 * replaying thought signatures across the retry turns.
 *
 * Plain REST over fetch, streamed (SSE) so long product-writing calls get
 * response headers early instead of hitting fetch's header timeout.
 */

const log = createLogger('gemini');

const API = 'https://generativelanguage.googleapis.com/v1beta';

export type GeminiTier = 'fast' | 'default' | 'heavy';

export function geminiEnabled(): boolean {
  return Boolean(getEnv().GEMINI_API_KEY);
}

export function geminiModel(tier: GeminiTier): string {
  const env = getEnv();
  if (tier === 'fast') return env.GEMINI_MODEL_FAST;
  if (tier === 'heavy') return env.GEMINI_MODEL_HEAVY;
  return env.GEMINI_MODEL;
}

type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

interface StreamChunk {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

/** Anthropic content blocks → Gemini parts. Tool turns become plain text. */
function toParts(content: Anthropic.MessageParam['content']): Part[] {
  if (typeof content === 'string') return [{ text: content }];
  const parts: Part[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ text: block.text });
        break;
      case 'image':
        if (block.source.type === 'base64') {
          parts.push({
            inlineData: { mimeType: block.source.media_type, data: block.source.data },
          });
        }
        break;
      case 'tool_use':
        // Our own earlier answer, replayed so the model can see what it got wrong.
        parts.push({ text: JSON.stringify(block.input) });
        break;
      case 'tool_result': {
        const body =
          typeof block.content === 'string'
            ? block.content
            : (block.content ?? [])
                .map((c) => (c.type === 'text' ? c.text : ''))
                .join('\n');
        // Results for stray duplicate calls only matter to Anthropic's API.
        if (!body.startsWith('Ignored —')) parts.push({ text: body });
        break;
      }
      default:
        break;
    }
  }
  return parts.length ? parts : [{ text: '' }];
}

function toContents(messages: Anthropic.MessageParam[]): Content[] {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: toParts(message.content),
  }));
}

function systemText(system: Anthropic.MessageCreateParams['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((block) => block.text).join('\n');
}

function forcedTool(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.Tool | undefined {
  const choice = params.tool_choice;
  if (!choice || choice.type !== 'tool') return undefined;
  return params.tools?.find(
    (tool): tool is Anthropic.Tool => 'input_schema' in tool && tool.name === choice.name,
  );
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

async function streamOnce(model: string, body: unknown): Promise<StreamChunk[]> {
  const env = getEnv();
  const response = await fetch(
    `${API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY ?? '',
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new GeminiError(`Gemini ${model}: ${response.status} ${text.slice(0, 500)}`, response.status);
  }

  const chunks: StreamChunk[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const chunk = JSON.parse(line.slice(5).trim()) as StreamChunk;
      if (chunk.error) {
        throw new GeminiError(
          `Gemini ${model}: ${chunk.error.code ?? ''} ${chunk.error.message ?? chunk.error.status}`,
          chunk.error.code ?? 500,
        );
      }
      chunks.push(chunk);
    }
  }
  return chunks;
}

/** Network-level retries for 429/5xx, like the Anthropic SDK's maxRetries. */
async function stream(model: string, body: unknown): Promise<StreamChunk[]> {
  const attempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await streamOnce(model, body);
    } catch (error) {
      const status = error instanceof GeminiError ? error.status : 0;
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= attempts) throw error;
      const wait = 1000 * 2 ** (attempt - 1);
      log.warn(`${model}: ${String(error)} — retry ${attempt}/${attempts - 1} in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Connectivity probe for `npm run doctor`. Goes through JSON mode so it also
 * proves the model accepts responseJsonSchema — the path completeJSON uses.
 */
export async function geminiPing(tier: GeminiTier): Promise<{ model: string; ok: boolean }> {
  const message = await sendGemini(
    {
      model: 'probe',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Set reply to the single word: ok' }],
      tools: [
        {
          name: 'respond',
          input_schema: {
            type: 'object',
            properties: { reply: { type: 'string' } },
            required: ['reply'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'respond' },
    },
    tier,
  );
  const block = message.content.find((b) => b.type === 'tool_use');
  const reply = (block?.input as { reply?: unknown } | undefined)?.reply;
  return { model: message.model, ok: typeof reply === 'string' && /ok/i.test(reply) };
}

const STOP_REASON: Record<string, Anthropic.Message['stop_reason']> = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
};

/** Runs an Anthropic-shaped request on Gemini and returns an Anthropic-shaped Message. */
export async function sendGemini(
  params: Anthropic.MessageCreateParamsNonStreaming,
  tier: GeminiTier,
): Promise<Anthropic.Message> {
  const model = geminiModel(tier);
  const tool = forcedTool(params);
  const system = systemText(params.system);

  const body = {
    contents: toContents(params.messages),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      // Gemini counts its thinking against maxOutputTokens; leave room for it
      // so the visible answer still gets the budget the caller asked for.
      maxOutputTokens: params.max_tokens + 8192,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(tool
        ? { responseMimeType: 'application/json', responseJsonSchema: tool.input_schema }
        : {}),
    },
  };

  const chunks = await stream(model, body);

  const blocked = chunks.find((c) => c.promptFeedback?.blockReason)?.promptFeedback?.blockReason;
  if (blocked) throw new GeminiError(`Gemini ${model}: prompt blocked (${blocked})`, 400);

  let text = '';
  let finishReason = '';
  let usage: StreamChunk['usageMetadata'] = {};
  for (const chunk of chunks) {
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text && !part.thought) text += part.text;
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }

  let stopReason: Anthropic.Message['stop_reason'] = STOP_REASON[finishReason] ?? 'end_turn';
  const content: Anthropic.ContentBlock[] = [];

  if (tool && stopReason !== 'max_tokens') {
    try {
      content.push({
        type: 'tool_use',
        id: `toolu_gemini_${randomUUID().replace(/-/g, '')}`,
        name: tool.name,
        input: JSON.parse(text) as unknown,
      } as Anthropic.ToolUseBlock);
      stopReason = 'tool_use';
    } catch {
      // Not valid JSON: no tool_use block, so completeJSON counts it as a failed attempt.
      log.warn(`${model}: JSON mode returned unparseable text (${text.length} chars)`);
    }
  } else if (text) {
    content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
  }

  if (finishReason && !STOP_REASON[finishReason]) {
    log.warn(`${model}: finishReason ${finishReason}`);
  }

  return {
    id: `msg_gemini_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      cache_read_input_tokens: usage?.cachedContentTokenCount ?? 0,
      cache_creation_input_tokens: 0,
    },
  } as Anthropic.Message;
}
