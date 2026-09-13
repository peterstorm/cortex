/**
 * LLM client for memory extraction and edge classification.
 *
 * Prefers the direct OpenAI-compatible endpoint (see llm-client.ts — ~30x
 * faster with thinking disabled). Callers request either JSON mode or strict
 * schema-guided decoding as appropriate. Falls back to the `claude -p` /
 * `pi -p` subprocess path when no endpoint is configured or a single direct
 * call fails. Once consecutive direct failures reach the saturation threshold
 * (default 3, CORTEX_LLM_MAX_DIRECT_FAILURES) the fallback is suppressed and
 * the call throws instead: a saturated server answers with empty content or
 * timeouts, and escalating to a full agent-loop subprocess would only consume
 * more of the same capacity. Callers defer the work (unmarked edges,
 * un-advanced checkpoints) and retry on the next run.
 *
 * Concurrency: every LLM call (direct or subprocess) acquires a slot from a
 * process-wide pool (default 2, CORTEX_LLM_MAX_CONCURRENCY), so cortex's
 * background work can never occupy more than a bounded share of a model
 * server that live agents already rely on.
 *
 * FR-001: Extract memories automatically at session end
 * FR-009: Complete extraction within 30 seconds (p95)
 * FR-056: Support typed edges between memories
 */

import type { EdgeRelation, MemoryType } from '../core/types.js';
import { isEdgeRelation, EDGE_RELATIONS } from '../core/types.js';
import { extractJsonSlice } from '../core/json-utils.js';
import { resolveOpenAiCompatEndpoint, chatCompletionText } from './llm-client.js';
import { readFileSync } from 'node:fs';

const EXTRACTION_TIMEOUT_MS = 90_000;
const EDGE_CLASSIFICATION_TIMEOUT_MS = 90_000;

/**
 * Memory pair for edge classification.
 */
export interface MemoryPair {
  readonly source: {
    readonly id: string;
    readonly content: string;
    readonly summary: string;
    readonly memory_type: MemoryType;
  };
  readonly target: {
    readonly id: string;
    readonly content: string;
    readonly summary: string;
    readonly memory_type: MemoryType;
  };
}

/**
 * Edge classification result.
 */
export interface EdgeClassification {
  /** 1-based ordinal of the pair this classification answers, when the model echoes it. */
  readonly pair_index?: number;
  readonly source_id: string;
  readonly target_id: string;
  readonly relation_type: EdgeRelation;
  readonly strength: number;
}

/**
 * Outcome of one classification batch, as consumed by the caller.
 *
 * `ok` carries every classification the model returned for the batch;
 * `unparseable` means the response could not be interpreted at all (or its
 * deterministic pair_index protocol was violated) — the caller must count
 * the batch as failed and leave edges unmarked for retry, never interpret
 * it as a genuine decline.
 */
export type EdgeClassificationOutcome =
  | { readonly kind: 'ok'; readonly classifications: readonly EdgeClassification[] }
  | { readonly kind: 'unparseable'; readonly reason: string };

/** Pi's inexpensive, capable models for structured memory extraction. */
const PI_EXTRACTION_MODELS: Readonly<Record<string, string>> = {
  anthropic: 'claude-haiku-4-5',
  google: 'gemini-3.1-flash-lite',
  'google-vertex': 'gemini-3.1-flash-lite',
  openai: 'gpt-5.4-mini',
  'openai-codex': 'gpt-5.4-mini',
};

export interface LlmInvocation {
  readonly binary: 'claude' | 'pi';
  readonly args: readonly string[];
  readonly provider?: string;
  readonly model?: string;
}

/** Detect which CLI binary to use for headless LLM calls. An explicit
 * CORTEX_LLM_BINARY override always wins; otherwise the active pi harness
 * implies `pi`, and the default is `claude`. */
function getLlmBinary(env: NodeJS.ProcessEnv): 'claude' | 'pi' {
  const override = env.CORTEX_LLM_BINARY;
  if (override === 'claude' || override === 'pi') return override;
  return env.PI_CODING_AGENT_DIR || env.PI_CODING_AGENT ? 'pi' : 'claude';
}

/** Read the Pi default provider only when no active-session provider is known. */
function getDefaultProvider(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const home = env.HOME || env.USERPROFILE || '';
    const settingsPath = `${home}/.pi/agent/settings.json`;
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as { defaultProvider?: unknown };
    return typeof settings.defaultProvider === 'string' ? settings.defaultProvider : undefined;
  } catch (err) {
    // Absent settings.json is the normal case. A file that EXISTS but cannot
    // be read/parsed silently changes provider/model resolution — surface it.
    const error = err as NodeJS.ErrnoException;
    const home = env.HOME || env.USERPROFILE || '';
    if (error.code !== 'ENOENT') {
      process.stderr.write(
        `[cortex:llm] WARN: ${home}/.pi/agent/settings.json exists but could not be read/parsed ` +
          `(defaultProvider ignored): ${error.message}\n`
      );
    }
    return undefined;
  }
}

/**
 * Resolve a headless extraction invocation.
 *
 * Pi does not expose an Anthropic Haiku model through every provider. Prefer
 * the active Pi session's provider, then select its cheap extraction model —
 * cloud parents (GPT/Claude/etc.) always get the cheap map model regardless
 * of which model the session itself runs. Providers without a map entry
 * (local vLLM, custom proxies) reuse the active session's model when the
 * resolved provider is the active provider. Explicit CORTEX_LLM_* values
 * always win.
 */
export function buildLlmInvocation(env: NodeJS.ProcessEnv): LlmInvocation {
  const binary = getLlmBinary(env);
  if (binary === 'claude') {
    return {
      binary,
      args: [binary, '-p', '--model', env.CORTEX_LLM_MODEL || 'haiku', '--output-format', 'text'],
      model: env.CORTEX_LLM_MODEL || 'haiku',
    };
  }

  const activeProvider = env.CORTEX_PI_PROVIDER || env.PI_PROVIDER;
  const activeModel = env.CORTEX_PI_MODEL || env.PI_MODEL;
  const provider = env.CORTEX_LLM_PROVIDER || activeProvider || getDefaultProvider(env);
  const model = env.CORTEX_LLM_MODEL
    || (provider ? PI_EXTRACTION_MODELS[provider] : undefined)
    || (provider === activeProvider ? activeModel : undefined);
  const args = [binary, '-p'];

  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  // Structured ingestion does not benefit from hidden reasoning. Pinning this
  // also prevents the headless child from inheriting the interactive session's
  // PI_REASONING_LEVEL through its environment.
  args.push('--thinking', 'off', '--no-session');

  return { binary, args, provider, model };
}

/**
 * Check if the LLM binary is available on PATH.
 */
export function isClaudeLlmAvailable(): boolean {
  const env = typeof Bun !== 'undefined' ? Bun.env : process.env;
  return Bun.which(getLlmBinary(env)) !== null;
}

/**
 * Run a prompt through the headless LLM CLI (claude -p / pi -p) and return raw response text.
 * Shared by extraction and edge classification fallbacks and ai-prune with
 * configurable timeout.
 *
 * @param prompt - Prompt to send via stdin
 * @param timeoutMs - Timeout in milliseconds
 * @returns Raw response text
 * @throws Error if binary not found, non-zero exit, timeout, or empty response
 */
export async function runLlmPrompt(prompt: string, timeoutMs: number): Promise<string> {
  const env = typeof Bun !== 'undefined' ? Bun.env : process.env;
  const { binary, args, provider, model } = buildLlmInvocation(env);

  if (!isClaudeLlmAvailable()) {
    throw new Error(`${binary} CLI not found on PATH`);
  }

  if (binary === 'pi') {
    process.stderr.write(`[cortex:llm] INFO: Pi extraction model: ${provider ?? 'default'}/${model ?? 'default'}\n`);
  }

  const proc = Bun.spawn(
    args,
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: (() => {
        const env = { ...process.env, CORTEX_EXTRACTING: '1' };
        delete env.CLAUDECODE;
        return env;
      })(),
    }
  );

  // Write prompt to stdin, then close to signal EOF
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Start draining stdout/stderr immediately to prevent pipe buffer deadlock.
  // Linux pipes hold 64KB — if claude -p writes more than that before we read,
  // it blocks on write and proc.exited never resolves. Classic deadlock.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  // Race between process completion and timeout.
  // Timer must be cleared after resolution to prevent keeping the event loop alive.
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`LLM CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let result: number;
  try {
    result = await Promise.race([proc.exited, timeout]);
  } finally {
    clearTimeout(timer!);
  }

  if (result !== 0) {
    const stderr = await stderrPromise;
    throw new Error(`Extraction LLM CLI exited with code ${result}: ${stderr.slice(0, 500)}`);
  }

  const stdout = await stdoutPromise;

  if (!stdout.trim()) {
    throw new Error('Empty response from Claude CLI');
  }

  return stdout;
}

/** Shared option shape for the direct-endpoint LLM calls and their fallback. */
export type DirectLlmOptions = {
  jsonMode?: boolean;
  jsonSchema?: object;
  maxTokens?: number;
};

/** Transport used by the classification call; injectable so tests can drive
 * the strict/tolerant routing without shelling out. */
export type LlmPromptTransport = (
  prompt: string,
  timeoutMs: number,
  options?: DirectLlmOptions
) => Promise<{ text: string; direct: boolean }>;

/**
 * Process-wide LLM slot pool.
 *
 * Every LLM consumer (extraction, edge classification, AI pruning, and the
 * subprocess fallback) funnels through runLlmPromptDirect, so capping slots
 * here bounds how much of the shared model server cortex's background work
 * can occupy at once — critical when live agents already hold most of the
 * server's concurrent slots. Waiters queue in arrival order; a woken waiter
 * re-checks the limit so a slot taken by a synchronous caller in the gap can
 * never be double-grabbed (no lost wake credits: each release resolves
 * exactly one waiter, and a re-queued waiter waits for a later release).
 */
const llmSlots = { active: 0, waiters: [] as Array<() => void> };

/** Test hook: reset the per-process LLM slot pool. */
export function resetLlmConcurrencyForTests(): void {
  llmSlots.active = 0;
  llmSlots.waiters = [];
}

/**
 * Shared env-int parser for the LLM guardrail knobs: a positive integer
 * wins; absent, non-integer, or below 1 falls back to the default.
 */
function envPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * Max in-flight LLM calls per process. Background work must be a polite
 * straggler on a shared server, so the default is small; 1 is the most
 * conservative setting, values below 1 are rejected and fall back to 2.
 */
function maxConcurrentLlmCalls(env: NodeJS.ProcessEnv): number {
  return envPositiveInt(env, 'CORTEX_LLM_MAX_CONCURRENCY', 2);
}

async function acquireLlmSlot(): Promise<void> {
  const limit = maxConcurrentLlmCalls(process.env);
  while (llmSlots.active >= limit) {
    await new Promise<void>((resolve) => llmSlots.waiters.push(resolve));
  }
  llmSlots.active++;
}

function releaseLlmSlot(): void {
  llmSlots.active--;
  const next = llmSlots.waiters.shift();
  if (next) next();
}

/** Per-process consecutive direct-endpoint failures; gives the operator a recurrence signal. */
let consecutiveDirectFailures = 0;

/** Test hook: reset the per-process consecutive-failure counter. */
export function resetConsecutiveDirectFailuresForTests(): void {
  consecutiveDirectFailures = 0;
}

/**
 * Consecutive direct-endpoint failures after which the CLI-subprocess
 * fallback is suppressed. Below the threshold a transient failure still
 * falls back, because the subprocess path can genuinely differ (different
 * model, prompt, timeout); at/above it the server is saturated or
 * misconfigured and escalation would amplify the outage.
 */
function getDirectFailureFallbackThreshold(env: NodeJS.ProcessEnv): number {
  return envPositiveInt(env, 'CORTEX_LLM_MAX_DIRECT_FAILURES', 3);
}

export async function runLlmPromptDirect(
  prompt: string,
  timeoutMs: number,
  direct: DirectLlmOptions = {}
): Promise<{ text: string; direct: boolean }> {
  // The slot covers BOTH the direct attempt and any subprocess fallback: a
  // `claude -p` / `pi -p` agent loop is one background job from the server's
  // point of view, and it must not stack on top of other in-flight calls.
  await acquireLlmSlot();
  try {
    return await runLlmPromptDirectUnbounded(prompt, timeoutMs, direct);
  } finally {
    releaseLlmSlot();
  }
}

/**
 * Run a prompt through the LLM, preferring the direct OpenAI-compatible
 * endpoint (thinking disabled — ~30x faster on reasoning models) and
 * falling back to the CLI subprocess path when no endpoint is configured
 * or the direct call fails.
 *
 * The `direct` flag tells the caller which transport produced the text:
 * strict parsing is only safe for the direct endpoint's guided decoding;
 * subprocess output is not schema-guided and needs the tolerant parser.
 */
async function runLlmPromptDirectUnbounded(
  prompt: string,
  timeoutMs: number,
  direct: DirectLlmOptions = {}
): Promise<{ text: string; direct: boolean }> {
  const endpoint = resolveOpenAiCompatEndpoint();
  if (endpoint) {
    try {
      const text = await chatCompletionText(endpoint, prompt, {
        jsonMode: direct.jsonMode,
        jsonSchema: direct.jsonSchema,
        maxTokens: direct.maxTokens,
        timeoutMs,
      });
      consecutiveDirectFailures = 0;
      return { text, direct: true };
    } catch (err) {
      consecutiveDirectFailures++;
      const count = consecutiveDirectFailures;
      const recurrence = count === 1 ? '' : ` (${count} consecutive direct-endpoint failures)`;
      const failureDetail = (err as Error).message ?? err;
      const threshold = getDirectFailureFallbackThreshold(process.env);
      if (count >= threshold) {
        // The direct endpoint keeps failing: the server is saturated or
        // misconfigured. Spawning `claude -p` / `pi -p` here would start full
        // agent loops that consume even more of the same saturated capacity,
        // so fail now and let the caller defer (edges stay unmarked,
        // checkpoints stay put, the next run retries).
        process.stderr.write(
          `[cortex:llm] ERROR: direct LLM call failed (${failureDetail})${recurrence}; ` +
            `suppressing ${getLlmBinary(process.env)} subprocess fallback after ${threshold} consecutive ` +
            `failure(s) — deferring work to the next run instead of escalating load ` +
            `(adjust CORTEX_LLM_MAX_DIRECT_FAILURES to change the threshold)\n`
        );
        throw new Error(
          `direct LLM endpoint saturated: ${count} consecutive failure(s); ` +
            `subprocess fallback suppressed to avoid escalating server load`
        );
      }
      process.stderr.write(
        `[cortex:llm] WARNING: direct LLM call failed (${failureDetail})${recurrence}; ` +
          `falling back to ${getLlmBinary(process.env)} subprocess\n`
      );
    }
  }
  return { text: await runLlmPrompt(prompt, timeoutMs), direct: false };
}

/**
 * Extract memories from transcript using the LLM.
 *
 * Runs the extraction prompt via the direct OpenAI-compatible endpoint
 * (thinking disabled, valid JSON output) or, failing that, the `claude -p` /
 * `pi -p` subprocess; returns the raw response text. Caller is responsible
 * for parsing via parseExtractionResponse.
 *
 * @param prompt - Extraction prompt (from buildExtractionPrompt)
 * @returns Raw LLM response text
 * @throws Error if the LLM binary not found, non-zero exit, timeout, empty
 * response, or the direct endpoint is saturated (subprocess fallback suppressed)
 */
export async function extractMemories(prompt: string): Promise<string> {
  const { text } = await runLlmPromptDirect(prompt, EXTRACTION_TIMEOUT_MS, {
    jsonMode: true,
    maxTokens: 8192,
  });
  return text;
}

/**
 * Strict JSON schema requested for direct classification batches. The parser
 * still rejects malformed, wrapped, truncated, or provider-noncompliant output
 * so transport failures remain explicit and retryable.
 */
const EDGE_CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // 1-based ordinal of the pair this classification answers. The
          // prompt enumerates pairs explicitly, so the join never depends on
          // the model echoing free-text IDs.
          pair_index: { type: 'integer' },
          source_id: { type: 'string' },
          target_id: { type: 'string' },
          relation_type: { type: 'string', enum: [...EDGE_RELATIONS] },
          strength: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['pair_index', 'source_id', 'target_id', 'relation_type', 'strength'],
        additionalProperties: false,
      },
    },
  },
  required: ['edges'],
  additionalProperties: false,
};

/**
 * Classify edges between memory pairs using the LLM.
 *
 * Prefers the direct OpenAI-compatible endpoint with strict schema-guided
 * decoding (output shape is guaranteed, response parsing is reliable);
 * falls back to the CLI subprocess path.
 *
 * The return type distinguishes a real model answer (ok) from an
 * unparseable response (unparseable): the caller must count the latter as a
 * batch failure and leave edges unmarked for retry, never as a decline.
 *
 * @param pairs - Memory pairs to classify
 * @returns Classification outcome; the strict/direct path throws on
 *          malformed responses instead of returning unparseable
 */
export async function classifyEdges(
  pairs: readonly MemoryPair[],
  transport: LlmPromptTransport = runLlmPromptDirect
): Promise<EdgeClassificationOutcome> {
  if (pairs.length === 0) return { kind: 'ok', classifications: [] };

  const prompt = buildEdgeClassificationPrompt(pairs);
  const { text, direct } = await transport(prompt, EDGE_CLASSIFICATION_TIMEOUT_MS, {
    jsonSchema: EDGE_CLASSIFICATION_SCHEMA,
    maxTokens: 4096,
  });
  // Strict mode only on the direct path: guided decoding bounds the output
  // shape, so a strict-parse failure means truncation or a server problem —
  // counting it as a batch failure keeps it from degrading into a silent
  // decline. Transport failures already trigger the subprocess fallback. The
  // subprocess fallback is not schema-guided (models wrap JSON in
  // fences/prose), so its output gets the tolerant parser, which never
  // throws and reports unparseable responses explicitly.
  return parseEdgeClassificationResponse(text, { strict: direct });
}

/**
 * Build prompt for edge classification.
 * Pure function - no side effects.
 */
export function buildEdgeClassificationPrompt(
  pairs: readonly MemoryPair[]
): string {
  const pairDescriptions = pairs
    .map(
      (pair, idx) => `
Pair ${idx + 1}:
  pair_index: ${idx + 1}
  Source [${pair.source.id}]:
    Type: ${pair.source.memory_type}
    Summary: ${pair.source.summary}
    Content: ${pair.source.content}

  Target [${pair.target.id}]:
    Type: ${pair.target.memory_type}
    Summary: ${pair.target.summary}
    Content: ${pair.target.content}
`
    )
    .join('\n');

  return `Classify relationships between memory pairs.

Memory Pairs:
${pairDescriptions}

Edge Relation Types:
- relates_to: General semantic connection
- derived_from: Target derived from source
- contradicts: Target contradicts source
- exemplifies: Target is example of source
- refines: Target refines/improves source
- supersedes: Target replaces source
- source_of: Source is origin of target

Rules:
1. Assign relation_type based on semantic relationship
2. Assign strength 0-1 based on relationship strength:
   - 0.8-1.0: Strong, clear relationship
   - 0.5-0.79: Moderate relationship
   - 0.3-0.49: Weak relationship
3. Only return edges with strength >= 0.3

Return JSON object:
{
  "edges": [
    {
      "pair_index": 1,
      "source_id": "id1",
      "target_id": "id2",
      "relation_type": "relates_to",
      "strength": 0.75
    }
  ]
}

For every classification, "pair_index" must be the number of the pair it
answers (Pair 1 → pair_index 1, Pair 2 → pair_index 2, ...).
If no strong relationships, return {"edges": []}.`;
}

/**
 * Parse edge classification response.
 *
 * Tolerant mode (default) extracts JSON from fences/prose and accepts both
 * the bare array and the schema-guided {"edges": [...]} wrapper shape the
 * classification prompt explicitly requests. It never throws: an unparseable
 * response is reported as {kind:'unparseable'} so the caller can count the
 * batch as failed and retry instead of mistaking garbage for a decline.
 * Any invalid item makes the whole response unparseable so no affected pair
 * can be mistaken for a genuine decline; the caller retries the batch.
 *
 * Strict mode (direct API with guided decoding) requires the whole response
 * to be valid JSON and accepts either the guided {"edges": [...]} envelope or
 * a legacy bare array. Every item must be schema-valid; pair_index remains
 * optional for legacy compatibility. Invalid items are decoder anomalies and
 * throw so callers retry the batch rather than retiring affected pairs.
 */
export function parseEdgeClassificationResponse(
  response: string,
  options: { strict?: boolean } = {}
): EdgeClassificationOutcome {
  if (options.strict) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.trim());
    } catch (e) {
      throw new Error(
        `Edge classification response is not valid JSON (probably truncated): ${(e as Error).message}`
      );
    }
    const checked = checkEdgesArray(parsed, 'strict mode');
    if (!checked.ok) {
      // A dropped item must never degrade into a permanent "declined" verdict:
      // schema-guided decoding makes invalid items a decoder/server anomaly,
      // so the batch fails and the edges are retried instead of retired.
      throw new Error(
        checked.reason === NO_EDGES_ARRAY
          ? `Edge classification response has no edges array: ${String(response).slice(0, 200)}`
          : `Edge classification response contained ${checked.reason}`
      );
    }
    return { kind: 'ok', classifications: normalizeClassifications(checked.valid) };
  }

  try {
    // Extract JSON from response: ```json fence, else the first JSON slice
    // (handles trailing prose the model adds after the JSON array), else raw.
    const fenceMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonText = fenceMatch?.[1] ?? extractJsonSlice(response) ?? response;

    const parsed: unknown = JSON.parse(jsonText.trim());

    const checked = checkEdgesArray(parsed, 'tolerant response');
    if (!checked.ok) {
      // Any dropped item can correspond to a pair the shell would otherwise
      // retire as an implicit decline. Fail the whole tolerant batch so every
      // edge remains unmarked and retryable.
      return {
        kind: 'unparseable',
        reason: checked.reason === NO_EDGES_ARRAY
          ? 'response contains no edges array'
          : checked.reason,
      };
    }
    return { kind: 'ok', classifications: normalizeClassifications(checked.valid) };
  } catch (e) {
    return {
      kind: 'unparseable',
      reason: `failed to parse edge classification response: ${(e as Error).message}`,
    };
  }
}

/** Sentinel for the one rejection whose wording differs between the modes. */
const NO_EDGES_ARRAY = 'no-edges-array';

/**
 * The shared half of both parse modes: unwrap the envelope and require EVERY
 * item to be schema-valid.
 *
 * Only what the two modes genuinely disagree about is left to them — strict
 * throws where tolerant returns, and each phrases the missing-array case for
 * its own caller. The rule itself ("any invalid item fails the whole batch,
 * so no pair can be mistaken for a decline") is stated once, because two
 * copies of it are two places it can be weakened to a filter.
 */
function checkEdgesArray(
  parsed: unknown,
  mode: string
): Readonly<{ ok: true; valid: readonly EdgeClassification[] }> | Readonly<{ ok: false; reason: string }> {
  const array = unwrapEdgesArray(parsed);
  if (array === null) return { ok: false, reason: NO_EDGES_ARRAY };

  const valid = array.filter(isValidEdgeClassification);
  if (valid.length !== array.length) {
    return {
      ok: false,
      reason: `${array.length - valid.length} of ${array.length} items with invalid shape (${mode})`,
    };
  }
  return { ok: true, valid };
}

/**
 * Unwrap the classification envelope: accept either the bare array or the
 * schema-guided {"edges": [...]} shape (legacy compatibility). Returns null
 * when the response carries no edges array at all.
 */
function unwrapEdgesArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray((parsed as { edges?: unknown })?.edges)) {
    return (parsed as { edges: unknown[] }).edges;
  }
  return null;
}

/**
 * Normalize schema-valid classification items into the domain shape. Coerces
 * the ID/strength fields defensively (the type guard already checked types,
 * so this is belt-and-suspenders) and keeps pair_index optional for legacy
 * responses. Shared by strict and tolerant modes: the only difference
 * between those modes is the failure channel (throw vs unparseable).
 */
function normalizeClassifications(valid: readonly EdgeClassification[]): readonly EdgeClassification[] {
  return valid.map((c) => ({
    ...(c.pair_index !== undefined ? { pair_index: c.pair_index } : {}),
    source_id: String(c.source_id),
    target_id: String(c.target_id),
    relation_type: c.relation_type,
    strength: Number(c.strength),
  }));
}

/**
 * Validate edge classification object.
 * Type guard for runtime validation.
 */
function isValidEdgeClassification(
  obj: unknown
): obj is EdgeClassification {
  if (typeof obj !== 'object' || obj === null) return false;

  const classification = obj as Record<string, unknown>;

  if (
    typeof classification.source_id !== 'string' ||
    typeof classification.target_id !== 'string' ||
    typeof classification.relation_type !== 'string' ||
    typeof classification.strength !== 'number'
  ) {
    return false;
  }

  if (!isEdgeRelation(classification.relation_type)) {
    return false;
  }

  if (classification.strength < 0 || classification.strength > 1) {
    return false;
  }

  // Optional deterministic-protocol key: when present it must be a 1-based
  // integer so the caller can join classifications to pairs without trusting
  // the model's free-text IDs.
  if (
    classification.pair_index !== undefined &&
    (!Number.isInteger(classification.pair_index) ||
      (classification.pair_index as number) < 1)
  ) {
    return false;
  }

  return true;
}
