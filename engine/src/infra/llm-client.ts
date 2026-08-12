/**
 * Direct OpenAI-compatible LLM client for Cortex background work
 * (memory extraction, edge classification).
 *
 * Replaces the `pi -p` / `claude -p` subprocess path when an OpenAI-compatible
 * endpoint is configured (e.g. the local vLLM server). Requests always disable
 * model thinking via chat_template_kwargs — structured extraction and
 * classification don't need hidden reasoning, and skipping it is ~30x faster
 * on reasoning models (a 2-pair classification drops from ~15s to ~0.5s).
 *
 * Endpoint resolution order:
 *  1. Explicit env: CORTEX_LLM_API_URL + CORTEX_LLM_API_KEY + CORTEX_LLM_MODEL
 *  2. pi's provider config (~/.pi/agent/models.json + settings.json), using
 *     CORTEX_LLM_PROVIDER, then PI_PROVIDER, then settings.defaultProvider.
 *     The provider's `!command` apiKey style is executed via bash.
 *
 * Falls back to null (caller then uses the legacy subprocess path) whenever
 * an OpenAI-compatible endpoint cannot be resolved.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface LlmEndpoint {
  /** Base URL without trailing slash, no /chat/completions suffix. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface ChatCompletionOptions {
  /** Ask the server for valid-JSON output (guided decoding where supported). */
  readonly jsonMode?: boolean;
  /** Strict JSON-schema guided decoding; takes precedence over jsonMode. */
  readonly jsonSchema?: object;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
}

/** Provider APIs that are not OpenAI-compatible chat/completions. */
const NON_OPENAI_APIS = new Set([
  'anthropic',
  'google-generative-ai',
  'google-vertex',
  'vertex',
  'aws-bedrock',
  'azure-ai',
]);

function getEnv(name: string): string | undefined {
  if (typeof Bun !== 'undefined') return Bun.env[name] ?? undefined;
  return process.env[name] ?? undefined;
}

function readJsonConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function runShellCommand(command: string): string | null {
  try {
    const result = spawnSync('bash', ['-c', command], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.status !== 0) return null;
    const out = (result.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(url: string): string {
  const stripped = url.replace(/\/+$/, '');
  if (stripped.endsWith('/chat/completions')) {
    return stripped.slice(0, -'/chat/completions'.length);
  }
  return stripped;
}

/**
 * Resolve an OpenAI-compatible endpoint for direct LLM calls, or null when
 * none is configured (caller falls back to the CLI subprocess path).
 */
export function resolveOpenAiCompatEndpoint(): LlmEndpoint | null {
  const envUrl = getEnv('CORTEX_LLM_API_URL');
  const envKey = getEnv('CORTEX_LLM_API_KEY');
  const envModel = getEnv('CORTEX_LLM_MODEL');
  if (envUrl && envKey && envModel) {
    return { baseUrl: normalizeBaseUrl(envUrl), apiKey: envKey, model: envModel };
  }

  const piDir = join(homedir(), '.pi', 'agent');
  const models = readJsonConfig(join(piDir, 'models.json'));
  if (!models || typeof models !== 'object') return null;

  const providers = (models as { providers?: unknown }).providers;
  if (!providers || typeof providers !== 'object') return null;

  const settings = readJsonConfig(join(piDir, 'settings.json')) as
    | { defaultProvider?: unknown }
    | null;
  const defaultProvider =
    settings && typeof settings.defaultProvider === 'string'
      ? settings.defaultProvider
      : undefined;

  const providerId =
    getEnv('CORTEX_LLM_PROVIDER') || getEnv('PI_PROVIDER') || defaultProvider;
  if (!providerId) return null;

  const provider = (providers as Record<string, unknown>)[providerId];
  if (!provider || typeof provider !== 'object') return null;
  const providerRecord = provider as Record<string, unknown>;

  if (typeof providerRecord.api === 'string' && NON_OPENAI_APIS.has(providerRecord.api)) {
    return null;
  }

  const baseUrl = providerRecord.baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('http')) return null;

  const rawKey = providerRecord.apiKey;
  if (typeof rawKey !== 'string' || rawKey.length === 0) return null;
  const apiKey = rawKey.startsWith('!') ? runShellCommand(rawKey.slice(1)) : rawKey;
  if (!apiKey) return null;

  const modelsList = providerRecord.models;
  const model =
    Array.isArray(modelsList) && modelsList.length > 0
      ? (modelsList[0] as { id?: unknown })?.id
      : undefined;
  if (typeof model !== 'string') return null;

  return { baseUrl: normalizeBaseUrl(baseUrl), apiKey, model };
}

/**
 * Run a single chat completion and return the assistant's text content.
 * Always disables thinking (chat_template_kwargs.thinking=false).
 *
 * @throws Error on HTTP/network/empty-content failures — callers decide
 *         whether to fall back to the subprocess path.
 */
export async function chatCompletionText(
  endpoint: LlmEndpoint,
  prompt: string,
  options: ChatCompletionOptions = {}
): Promise<string> {
  const {
    jsonMode = false,
    maxTokens = 2048,
    temperature = 0,
    timeoutMs = 90_000,
  } = options;

  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature,
    stream: false,
    chat_template_kwargs: { thinking: false },
  };
  if (options.jsonSchema) {
    // Strict schema-guided decoding: the model cannot deviate from the shape.
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'structured_output',
        schema: options.jsonSchema,
        strict: true,
      },
    };
  } else if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM API ${response.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('LLM API returned empty content');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
