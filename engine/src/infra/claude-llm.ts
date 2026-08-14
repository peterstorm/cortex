/**
 * LLM client for memory extraction and edge classification.
 *
 * Prefers the direct OpenAI-compatible endpoint (see llm-client.ts — ~30x
 * faster, thinking disabled, schema-guided decoding); falls back to the
 * `claude -p` / `pi -p` subprocess path when no endpoint is configured or
 * the direct call fails.
 *
 * FR-001: Extract memories automatically at session end
 * FR-009: Complete extraction within 30 seconds (p95)
 * FR-056: Support typed edges between memories
 */

import type { EdgeRelation, MemoryType } from '../core/types.js';
import { isEdgeRelation, EDGE_RELATIONS } from '../core/types.js';
import { extractJsonSlice } from '../core/json-utils.js';
import { resolveOpenAiCompatEndpoint, chatCompletionText } from './llm-client.js';

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
    const content = require('fs').readFileSync(settingsPath, 'utf-8');
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
 * the active Pi session's provider, then select its cheap extraction model.
 * Explicit CORTEX_LLM_* values always win. Unknown/custom providers get no
 * model override (the provider's own default is used); the active session's
 * model is reused only when the resolved provider is the active provider.
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
 * @throws Error if binary not found, non-zero exit, or timeout
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
/** Transport used by the classification call; injectable so tests can drive
 * the strict/tolerant routing without shelling out. */
export type LlmPromptTransport = (
  prompt: string,
  timeoutMs: number,
  options?: { jsonMode?: boolean; jsonSchema?: object; maxTokens?: number }
) => Promise<{ text: string; direct: boolean }>;

/** Per-process consecutive direct-endpoint failures; gives the operator a recurrence signal. */
let consecutiveDirectFailures = 0;

export async function runLlmPromptDirect(
  prompt: string,
  timeoutMs: number,
  direct: { jsonMode?: boolean; jsonSchema?: object; maxTokens?: number } = {}
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
      process.stderr.write(
        `[cortex:llm] WARNING: direct LLM call failed (${(err as Error).message ?? err})${recurrence}; ` +
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
 * @throws Error if the LLM binary not found, non-zero exit, or timeout
 */
export async function extractMemories(prompt: string): Promise<string> {
  const { text } = await runLlmPromptDirect(prompt, EXTRACTION_TIMEOUT_MS, {
    jsonMode: true,
    maxTokens: 8192,
  });
  return text;
}

/**
 * Strict JSON schema for classification batches. Schema-guided decoding on
 * the direct API path makes malformed/wrapped/verbose output impossible.
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
 * Invalid items inside an otherwise-valid response are dropped; when the
 * dropped item carried a pair_index (the deterministic protocol), the whole
 * response is treated as unparseable so the affected pair is retried.
 *
 * Strict mode (direct API with guided decoding) requires the whole response
 * to be a valid JSON object with an edges array, requires every item to be
 * schema-valid (invalid items are a decoder anomaly and throw with a dropped
 * count), and throws otherwise — callers must treat that as a batch failure.
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
    // Accept both the bare array and the schema-guided {"edges": [...]} shape
    const array =
      Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { edges?: unknown })?.edges)
          ? (parsed as { edges: unknown[] }).edges
          : null;
    if (array === null) {
      throw new Error(
        `Edge classification response has no edges array: ${String(response).slice(0, 200)}`
      );
    }
    const valid = array.filter(isValidEdgeClassification);
    if (valid.length !== array.length) {
      // A dropped item must never degrade into a permanent "declined" verdict:
      // schema-guided decoding makes invalid items a decoder/server anomaly,
      // so the batch fails and the edges are retried instead of retired.
      throw new Error(
        `Edge classification response contained ${array.length - valid.length} of ` +
          `${array.length} items with invalid shape (strict mode)`
      );
    }
    return {
      kind: 'ok',
      classifications: valid.map((c) => ({
        ...(c.pair_index !== undefined ? { pair_index: c.pair_index } : {}),
        source_id: String(c.source_id),
        target_id: String(c.target_id),
        relation_type: c.relation_type,
        strength: Number(c.strength),
      })),
    };
  }

  try {
    // Extract JSON from response: ```json fence, else the first JSON slice
    // (handles trailing prose the model adds after the JSON array), else raw.
    const fenceMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonText = fenceMatch?.[1] ?? extractJsonSlice(response) ?? response;

    const parsed: unknown = JSON.parse(jsonText.trim());

    // Accept both the bare array and the schema-guided {"edges": [...]} shape
    const array =
      Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { edges?: unknown })?.edges)
          ? (parsed as { edges: unknown[] }).edges
          : null;
    if (array === null) {
      return {
        kind: 'unparseable',
        reason: 'response contains no edges array',
      };
    }

    const valid = array.filter(isValidEdgeClassification);
    if (valid.length !== array.length) {
      const dropped = array.filter((item) => !isValidEdgeClassification(item));
      // A dropped indexed item cannot be retried if we just ignore it: the
      // pair it answered would look declined. Surface the loss as a batch
      // failure. Legacy unindexed output keeps the old warn-and-filter.
      if (dropped.some((item) =>
        typeof item === 'object' && item !== null &&
        (item as { pair_index?: unknown }).pair_index !== undefined)) {
        return {
          kind: 'unparseable',
          reason: `${array.length - valid.length} of ${array.length} items had invalid shape (indexed response)`,
        };
      }
      process.stderr.write(
        `[cortex:llm] WARNING: dropping ${array.length - valid.length} of ${array.length} ` +
          `edge classifications with invalid shape from a tolerant-mode response\n`
      );
    }
    return {
      kind: 'ok',
      classifications: valid.map((c) => ({
        ...(c.pair_index !== undefined ? { pair_index: c.pair_index } : {}),
        source_id: String(c.source_id),
        target_id: String(c.target_id),
        relation_type: c.relation_type,
        strength: Number(c.strength),
      })),
    };
  } catch (e) {
    return {
      kind: 'unparseable',
      reason: `failed to parse edge classification response: ${(e as Error).message}`,
    };
  }
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
