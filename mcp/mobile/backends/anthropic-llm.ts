/**
 * Built-in `LlmFn` for the mobile recipe-generator that uses the Anthropic
 * Messages API directly via `fetch()` — no SDK dependency.
 *
 * The recipe-generator's `LlmFn` interface is `(system, user) -> Promise<string>`.
 * This implementation reads `ANTHROPIC_API_KEY` from the environment (loaded
 * from `${CLAUDE_PLUGIN_DATA}/.env` by `mobile-server.ts`'s dotenv bootstrap)
 * and POSTs to /v1/messages with Claude Sonnet 4.6 (or whatever
 * `ANTHROPIC_MOBILE_MODEL` overrides to).
 *
 * Why fetch, not the SDK: keeping the mobile MCP runtime light. We make
 * exactly one model API call per module being generated; the SDK's batching /
 * streaming / caching machinery doesn't pay for itself here.
 */

import type { LlmFn } from './recipe-generator.js';

interface AnthropicMessagesResponse {
  content: Array<{ type: 'text'; text: string }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export class AnthropicLlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicLlmConfigError';
  }
}

/**
 * Build an `LlmFn` backed by the Anthropic Messages API. Throws
 * `AnthropicLlmConfigError` at construction time if `ANTHROPIC_API_KEY` is
 * unset; this lets callers fall back to a passed-in `llm` arg without
 * blowing up on every recipe generation.
 */
export function createAnthropicLlmFn(opts?: {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}): LlmFn {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnthropicLlmConfigError(
      'ANTHROPIC_API_KEY not set in env (loaded from $CLAUDE_PLUGIN_DATA/.env). ' +
      'Either set the key in .env or pass `llm: <custom LlmFn>` to ' +
      '`generateRecipesFromAppSummary`.',
    );
  }
  const model = opts?.model ?? process.env.ANTHROPIC_MOBILE_MODEL ?? DEFAULT_MODEL;
  const maxTokens = opts?.maxTokens ?? 4096;

  return async (system: string, user: string): Promise<string> => {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `anthropic-llm: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as AnthropicMessagesResponse;
    const textBlock = data.content.find((c) => c.type === 'text');
    if (!textBlock) {
      throw new Error(`anthropic-llm: no text block in response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return textBlock.text;
  };
}

/**
 * Lazy singleton — most callers just want "give me the default LlmFn." Throws
 * the same `AnthropicLlmConfigError` on first call if the key is missing.
 */
let cached: LlmFn | undefined;
export function getDefaultAnthropicLlmFn(): LlmFn {
  if (!cached) cached = createAnthropicLlmFn();
  return cached;
}
