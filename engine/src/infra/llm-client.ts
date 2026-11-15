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
 * Two deployment realities shape the thinking-disabling here:
 *
 * - Chat templates name the thinking switch differently by model family:
 *   DeepSeek-style templates read `thinking`, Qwen3-style templates read
 *   `enable_thinking`. Extra chat_template_kwargs are inert (Jinja ignores
 *   unreferenced context variables), so we send both and each template honors
 *   whichever it knows.
 * - On local routing servers (vLLM/sglang fronting whatever weights are
 *   loaded) the model NAME in config is not the model that answers: the server
 *   accepts any name and serves the loaded weights. The loaded model can
 *   change underneath a fixed config, which is why a one-shot served-model
 *   check warns on name mismatch and why an empty-content response that
 *   carries reasoning_content names the thinking failure explicitly.
 * - Some templates have no thinking switch at all. GLM served by Hyperflare
 *   thinks regardless of chat_template_kwargs and of `thinking: disabled`, and
 *   treats a request without `reasoning_effort` as MAX effort: a one-sentence
 *   extraction burns thousands of tokens and returns empty content. For such
 *   a served model the only bound on hidden reasoning is `reasoning_effort`,
 *   so it is sent too (`low`, the lowest the model accepts), decided from the
 *   model the server reports it is serving, not from the configured name.
 *   CORTEX_LLM_REASONING_EFFORT overrides (low|medium|high|max|none).
 *
 * Endpoint resolution order:
 *  1. Explicit env: CORTEX_LLM_API_URL + CORTEX_LLM_API_KEY + CORTEX_LLM_MODEL
 *  2. pi's provider config (~/.pi/agent/models.json + settings.json), using
 *     CORTEX_LLM_PROVIDER, CORTEX_PI_PROVIDER (the active session selection),
 *     PI_PROVIDER, then settings.defaultProvider.
 *     The provider's `!command` apiKey style is executed via bash.
 *     When the resolved provider is the active session's own provider
 *     (CORTEX_PI_PROVIDER/PI_PROVIDER), the session's model
 *     (CORTEX_PI_MODEL/PI_MODEL) is preferred over models[0]: the live
 *     session is proof that exact model exists, while models[0] goes stale
 *     when the served model changes (e.g. a 404 after a vLLM model swap).
 *
 * Falls back to null (caller then uses the legacy subprocess path) whenever
 * an OpenAI-compatible endpoint cannot be resolved.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { match } from 'ts-pattern';

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

/** Pi API adapters proven to expose the OpenAI `/chat/completions` contract. */
const OPENAI_CHAT_COMPLETIONS_APIS = new Set(['openai-completions']);

function getEnv(name: string): string | undefined {
  if (typeof Bun !== 'undefined') return Bun.env[name] ?? undefined;
  return process.env[name] ?? undefined;
}

/**
 * Read a JSON config file, or null when it does not exist (a legitimately
 * absent config is the normal case). A file that EXISTS but cannot be read
 * or parsed is a user-visible configuration failure and warns instead of
 * silently disabling the direct path.
 */
function readJsonConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    if (existsSync(path)) {
      warnResolution(`config ${path} exists but could not be read/parsed: ${(err as Error).message}`);
    }
    return null;
  }
}

function runShellCommand(command: string): string | null {
  try {
    const result = spawnSync('bash', ['-c', command], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').trim().slice(0, 1_000);
      warnResolution(
        `apiKey shell command failed (status=${result.status ?? 'null'}, signal=${result.signal ?? 'none'})` +
          (stderr === '' ? '' : `: ${stderr}`)
      );
      return null;
    }
    const out = (result.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch (err) {
    // The command itself never ran (spawn ENOENT, EACCES, signal) — a
    // different failure class from "the command printed nothing", and the
    // caller's 'resolved empty' warning would misattribute it.
    warnResolution(`apiKey shell command could not be started: ${err instanceof Error ? err.message : String(err)}`);
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
  // A partial CORTEX_LLM_* override is almost always a mistake: the user
  // thinks they configured the direct path, and the fall-through may resolve
  // a different endpoint than they intended. Name the missing variables.
  const envSet = [envUrl, envKey, envModel].filter((value) => value !== undefined);
  if (envSet.length > 0) {
    const missing = (['CORTEX_LLM_API_URL', 'CORTEX_LLM_API_KEY', 'CORTEX_LLM_MODEL'] as const)
      .filter((key) => getEnv(key) === undefined);
    warnResolution(
      `partial CORTEX_LLM_* configuration: ${envSet.length} of 3 variables set, ` +
        `missing ${missing.join(', ')}; falling through to the pi provider config`
    );
  }

  const piDir = join(getEnv('HOME') ?? homedir(), '.pi', 'agent');
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

  const explicitProvider = getEnv('CORTEX_LLM_PROVIDER');
  const activeProvider = getEnv('CORTEX_PI_PROVIDER') || getEnv('PI_PROVIDER');
  const activeModel = getEnv('CORTEX_PI_MODEL') || getEnv('PI_MODEL');
  const providerId =
    explicitProvider ||
    activeProvider ||
    defaultProvider;
  if (!providerId) return null;

  const provider = (providers as Record<string, unknown>)[providerId];
  if (!provider || typeof provider !== 'object') {
    warnResolution(`provider '${providerId}' is not defined in ~/.pi/agent/models.json`);
    return null;
  }
  const providerRecord = provider as Record<string, unknown>;

  if (
    typeof providerRecord.api === 'string' &&
    !OPENAI_CHAT_COMPLETIONS_APIS.has(providerRecord.api)
  ) {
    warnResolution(
      `provider '${providerId}' uses api '${providerRecord.api}', not the OpenAI chat-completions adapter`
    );
    return null;
  }

  const baseUrl = providerRecord.baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('http')) {
    warnResolution(`provider '${providerId}' has no http baseUrl`);
    return null;
  }

  const rawKey = providerRecord.apiKey;
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    warnResolution(`provider '${providerId}' has no apiKey; direct LLM calls disabled, falling back to subprocess`);
    return null;
  }
  const apiKey = rawKey.startsWith('!') ? runShellCommand(rawKey.slice(1)) : rawKey;
  if (!apiKey) {
    warnResolution(`provider '${providerId}' apiKey command resolved empty; direct LLM calls disabled, falling back to subprocess`);
    return null;
  }

  const modelsList = providerRecord.models;
  const models0 =
    Array.isArray(modelsList) && modelsList.length > 0
      ? (modelsList[0] as { id?: unknown })?.id
      : undefined;
  // Prefer the active session's model when this endpoint is the session's own
  // provider (mirrors the subprocess path): the live session is actively
  // using that exact model, so it is guaranteed to exist — unlike models[0],
  // which can point at a model the server no longer serves.
  const model =
    activeProvider !== undefined &&
    providerId === activeProvider &&
    typeof activeModel === 'string' &&
    activeModel.length > 0
      ? activeModel
      : models0;
  if (typeof model !== 'string') {
    warnResolution(`provider '${providerId}' has no models[0].id; direct LLM calls disabled, falling back to subprocess`);
    return null;
  }

  return { baseUrl: normalizeBaseUrl(baseUrl), apiKey, model };
}

/** Emit one WARN per rejected user-visible direct-endpoint configuration. */
function warnResolution(reason: string): void {
  process.stderr.write(`[cortex:llm] WARN: ${reason}\n`);
}

/**
 * chat_template_kwargs that disable thinking under every known convention.
 * Sent on every request: DeepSeek-style templates read `thinking`, Qwen3-style
 * templates read `enable_thinking`, and templates ignore keys they don't read,
 * so sending both is safe for every OpenAI-compatible server.
 */
export const THINKING_DISABLED_KWARGS: Readonly<Record<string, boolean>> = Object.freeze({
  thinking: false,
  enable_thinking: false,
});

/** Efforts an OpenAI-compatible server may accept in `reasoning_effort`. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

/** What `pi -p --thinking` should be for a background call: off, or an effort. */
export type BackgroundThinking = 'off' | ReasoningEffort;

/**
 * CORTEX_LLM_REASONING_EFFORT, parsed once. `auto` (unset) lets the served model
 * decide, `none` sends no effort at all, and `invalid` keeps the raw value so it
 * can be reported; it behaves as `auto`.
 */
export type EffortOverride =
  | { readonly kind: 'auto' }
  | { readonly kind: 'none' }
  | { readonly kind: 'effort'; readonly effort: ReasoningEffort }
  | { readonly kind: 'invalid'; readonly raw: string };

/** Pure: parse the override variable's value. */
export function parseEffortOverride(raw: string | undefined): EffortOverride {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '') return { kind: 'auto' };
  if (value === 'none' || value === 'off') return { kind: 'none' };
  const effort = REASONING_EFFORTS.find((candidate) => candidate === value);
  return effort === undefined ? { kind: 'invalid', raw: raw ?? '' } : { kind: 'effort', effort };
}

/** GLM ids (`glm-5.3-flash-hyperflare-tp2-v16`, `GLM-5.3-Flash`, ...). */
const NO_THINKING_OFF_SWITCH = /^glm/i;

/**
 * Pure: whether any of these models has no thinking off-switch. Sending an
 * effort to a GLM served by an engine that does honour the template switches
 * is harmless; sending none to Hyperflare's GLM is a runaway.
 */
export function thinkingCannotBeDisabled(served: readonly string[]): boolean {
  return served.some((id) => NO_THINKING_OFF_SWITCH.test(id));
}

/**
 * Pure: the models to judge the family by. The server's own list is the
 * evidence (routing servers answer with whatever is loaded, whatever the
 * session is pinned to); the configured name is only the fallback when the
 * server could not be asked.
 */
export function answeringModels(requested: string, served: readonly string[]): readonly string[] {
  return served.length > 0 ? served : [requested];
}

/**
 * Pure and total: the `reasoning_effort` to send, or undefined to send none.
 * An explicit effort wins, `none` suppresses, and otherwise a model with no
 * off-switch is asked for `low`.
 */
export function reasoningEffortFor(
  models: readonly string[],
  override: EffortOverride,
): ReasoningEffort | undefined {
  return match(override)
    .with({ kind: 'none' }, () => undefined)
    .with({ kind: 'effort' }, ({ effort }) => effort)
    .with({ kind: 'auto' }, { kind: 'invalid' }, () => (thinkingCannotBeDisabled(models) ? ('low' as const) : undefined))
    .exhaustive();
}

/**
 * Pure: detect a requested-model / served-model mismatch, or null when the
 * check is inconclusive (empty served list) or clean (name is served).
 *
 * Local routing servers accept ANY model name and serve the loaded weights
 * regardless, so a stale config name never 404s — it silently changes which
 * model answers (and which chat-template convention its thinking switch
 * uses). Surfacing that once is the difference between a readable WARN and a
 * week of "empty content" failures.
 */
export function findServedModelMismatch(
  requested: string,
  served: readonly string[]
): string | null {
  if (served.length === 0 || served.includes(requested)) return null;
  return (
    `requested model '${requested}' is not in the served model list [${served.join(', ')}]; ` +
    'routing servers serve the loaded weights regardless of the requested name — ' +
    'check what is actually loaded (its chat template may name the thinking switch differently)'
  );
}

/**
 * Served-model probe. Best-effort by contract: an unreachable /models
 * endpoint, a slow server, or an unexpected payload degrades to "unknown"
 * (no ids) — the diagnostic must never break or delay a completion by more
 * than SERVED_MODEL_CHECK_TIMEOUT_MS. The answer is cached per endpoint for
 * SERVED_MODELS_TTL_MS: the served model only changes when an operator
 * switches primaries, so a minute keeps a long-running ingestion honest
 * without probing on every call.
 */
const SERVED_MODEL_CHECK_TIMEOUT_MS = 2000;
const SERVED_MODELS_TTL_MS = 60_000;

type ServedProbe = Readonly<{ at: number; ids: Promise<readonly string[]> }>;
const servedProbes = new Map<string, ServedProbe>();
let servedModelCheckDone = false;
const warnedEffortOverrides = new Set<string>();

/**
 * Test/reset hook: the one-shot warn guard, the probe cache and the reported
 * overrides are process state; tests that exercise them twice in a row need a
 * way to re-arm them.
 */
export function resetServedModelCheck(): void {
  servedModelCheckDone = false;
  servedProbes.clear();
  warnedEffortOverrides.clear();
}

/** Pure: the model ids in a `/models` payload; anything unrecognisable yields none. */
export function parseServedModelIds(payload: unknown): readonly string[] {
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) return [];
  const { data } = payload;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string'
      ? [entry.id]
      : [],
  );
}

async function probeServedModels(endpoint: LlmEndpoint): Promise<readonly string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVED_MODEL_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    return parseServedModelIds(payload);
  } catch {
    // Best-effort diagnostic: any failure here is not actionable for the caller.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** The ids the endpoint reports serving (cached for a minute); empty when unknown. Never throws. */
function servedModelIds(endpoint: LlmEndpoint): Promise<readonly string[]> {
  const cached = servedProbes.get(endpoint.baseUrl);
  if (cached !== undefined && Date.now() - cached.at < SERVED_MODELS_TTL_MS) return cached.ids;
  const ids = probeServedModels(endpoint);
  servedProbes.set(endpoint.baseUrl, { at: Date.now(), ids });
  return ids;
}

/** One WARN per process when the configured name is not what the server serves. */
function warnOnServedMismatchOnce(requested: string, served: readonly string[]): void {
  if (servedModelCheckDone) return;
  servedModelCheckDone = true;
  const warning = findServedModelMismatch(requested, served);
  if (warning !== null) {
    process.stderr.write(`[cortex:llm] WARN: ${warning}\n`);
  }
}

/** The override from the environment, with an unrecognised value reported once per process. */
function readEffortOverride(): EffortOverride {
  const override = parseEffortOverride(getEnv('CORTEX_LLM_REASONING_EFFORT'));
  if (override.kind === 'invalid' && !warnedEffortOverrides.has(override.raw)) {
    warnedEffortOverrides.add(override.raw);
    warnResolution(
      `ignoring CORTEX_LLM_REASONING_EFFORT='${override.raw}' (expected low, medium, high, max or none); ` +
        'the effort is chosen from the served model instead'
    );
  }
  return override;
}

/**
 * What `pi -p --thinking` should be for a background call to this endpoint:
 * the effort a model with no off-switch must be given, else `off`. The
 * subprocess fallback uses it so it does not run an agent loop at the maximum
 * reasoning that `--thinking off` falls back to on such a model.
 */
export async function backgroundThinking(endpoint: LlmEndpoint): Promise<BackgroundThinking> {
  const served = await servedModelIds(endpoint);
  return reasoningEffortFor(answeringModels(endpoint.model, served), readEffortOverride()) ?? 'off';
}

/**
 * Run a single chat completion and return the assistant's text content.
 * Always disables thinking (THINKING_DISABLED_KWARGS, both known conventions)
 * and, when the model answering has no thinking off-switch (GLM), also bounds
 * its reasoning with `reasoning_effort` (see reasoningEffortFor).
 *
 * @throws Error on HTTP/network/empty-content failures — callers decide
 *         whether to fall back to the subprocess path.
 */
export async function chatCompletionText(
  endpoint: LlmEndpoint,
  prompt: string,
  options: ChatCompletionOptions = {}
): Promise<string> {
  return (await chatCompletion(endpoint, prompt, options)).content;
}

/** A completion with the identity of the model that actually answered. */
export interface ChatCompletion {
  readonly content: string;
  /**
   * The model the provider reports, falling back to the requested name. On
   * routing servers this is the evidence of which weights answered.
   */
  readonly model: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

const tokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * chatCompletionText's contract, plus the reported model and token usage —
 * what an evaluation records to keep its runs comparable.
 *
 * @throws Error on HTTP/network/empty-content failures.
 */
export async function chatCompletion(
  endpoint: LlmEndpoint,
  prompt: string,
  options: ChatCompletionOptions = {}
): Promise<ChatCompletion> {
  const {
    jsonMode = false,
    maxTokens = 2048,
    temperature = 0,
    timeoutMs = 90_000,
  } = options;

  // On local routing servers the configured name is not the model that
  // answers: warn once where the operator is already looking, and let the
  // model that IS answering decide whether it needs an effort bound.
  const served = await servedModelIds(endpoint);
  warnOnServedMismatchOnce(endpoint.model, served);
  const effort = reasoningEffortFor(answeringModels(endpoint.model, served), readEffortOverride());

  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature,
    stream: false,
    chat_template_kwargs: { ...THINKING_DISABLED_KWARGS },
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  };
  if (options.jsonSchema) {
    // Request strict schema-guided decoding where the provider supports it;
    // callers still parse defensively because provider compliance can vary.
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
  const effectiveTimeoutMs = timeoutMs;
  const timer = setTimeout(
    () => controller.abort(new Error(`LLM request timed out after ${effectiveTimeoutMs}ms`)),
    effectiveTimeoutMs,
  );
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
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      choices?: Array<{
        message?: { content?: unknown; reasoning_content?: unknown };
        finish_reason?: unknown;
      }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      // A thinking model that ignored both thinking-disable conventions burns
      // its whole token budget on reasoning_content and returns empty
      // content. Name that failure mode explicitly: "empty content" otherwise
      // reads like a network glitch and never gets connected to the served
      // model's chat template.
      const reasoning = choice?.message?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
        throw new Error(
          'LLM API returned only reasoning_content (content empty): the served model is thinking and ' +
            `ignored chat_template_kwargs ${JSON.stringify(THINKING_DISABLED_KWARGS)}; check which model ` +
            'is actually loaded at the endpoint (routing servers serve whatever weights are loaded ' +
            'regardless of the requested name) and how its chat template names the thinking switch; ' +
            'a model with no thinking switch needs CORTEX_LLM_REASONING_EFFORT=low to bound its reasoning'
        );
      }
      throw new Error('LLM API returned empty content');
    }
    if (choice?.finish_reason === 'length') {
      // Truncation produces cut-off JSON that parses as a generic error
      // downstream; name the real cause so the operator can raise maxTokens
      // or shrink the prompt instead of hunting a phantom malformed response.
      throw new Error(
        `LLM output truncated (max_tokens=${maxTokens} reached, finish_reason=length); ` +
          `raise maxTokens or reduce prompt size`
      );
    }
    return {
      content,
      model: typeof data.model === 'string' && data.model !== '' ? data.model : endpoint.model,
      promptTokens: tokenCount(data.usage?.prompt_tokens),
      completionTokens: tokenCount(data.usage?.completion_tokens),
    };
  } catch (err) {
    // The timeout aborts with a reason; surface it as a timeout-named error
    // so operators can distinguish "prompt exceeded the deadline" from a
    // generic network/abort failure.
    const message = err instanceof Error ? err.message : String(err);
    if ((err as Error)?.name === 'AbortError' || message.includes('timed out after')) {
      throw new Error(`LLM request timed out after ${effectiveTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
