/**
 * Claude CLI client for memory extraction and edge classification.
 * Shells out to `claude -p` via Bun.spawn — leverages user's Anthropic subscription.
 *
 * FR-001: Extract memories automatically at session end
 * FR-009: Complete extraction within 30 seconds (p95)
 * FR-056: Support typed edges between memories
 */

import type { EdgeRelation } from '../core/types.js';
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
    readonly memory_type: string;
  };
  readonly target: {
    readonly id: string;
    readonly content: string;
    readonly summary: string;
    readonly memory_type: string;
  };
}

/**
 * Edge classification result.
 */
export interface EdgeClassification {
  readonly source_id: string;
  readonly target_id: string;
  readonly relation_type: EdgeRelation;
  readonly strength: number;
}

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

/** Detect which CLI binary to use for headless LLM calls. */
function getLlmBinary(env: NodeJS.ProcessEnv): 'claude' | 'pi' {
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
  } catch {
    return undefined;
  }
}

/**
 * Resolve a headless extraction invocation.
 *
 * Pi does not expose an Anthropic Haiku model through every provider. Prefer
 * the active Pi session's provider, then select its cheap extraction model.
 * Explicit CORTEX_LLM_* values always win; unknown/custom providers reuse the
 * active model instead of sending an unsupported guessed model ID.
 */
export function buildLlmInvocation(env: NodeJS.ProcessEnv): LlmInvocation {
  const binary = getLlmBinary(env);
  if (binary === 'claude') {
    return {
      binary,
      args: [binary, '-p', '--model', 'haiku', '--output-format', 'text'],
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
  args.push('--no-session');

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
 * Run a prompt through Claude CLI and return raw response text.
 * Shared by extraction and edge classification with configurable timeout.
 *
 * @param prompt - Prompt to send via stdin
 * @param timeoutMs - Timeout in milliseconds
 * @returns Raw Claude response text
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
      reject(new Error(`Extraction LLM CLI timed out after ${timeoutMs}ms`));
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
 */
async function runLlmPromptDirect(
  prompt: string,
  timeoutMs: number,
  direct: { jsonMode?: boolean; jsonSchema?: object; maxTokens?: number } = {}
): Promise<string> {
  const endpoint = resolveOpenAiCompatEndpoint();
  if (endpoint) {
    try {
      return await chatCompletionText(endpoint, prompt, {
        jsonMode: direct.jsonMode,
        jsonSchema: direct.jsonSchema,
        maxTokens: direct.maxTokens,
        timeoutMs,
      });
    } catch (err) {
      process.stderr.write(
        `[cortex:llm] WARNING: direct LLM call failed (${(err as Error).message ?? err}); ` +
          `falling back to ${getLlmBinary(process.env)} subprocess\n`
      );
    }
  }
  return runLlmPrompt(prompt, timeoutMs);
}

/**
 * Extract memories from transcript using the LLM.
 * Pipes prompt to `claude -p` via stdin and returns raw response text.
 * Caller is responsible for parsing via parseExtractionResponse.
 *
 * Prefers the direct OpenAI-compatible endpoint (thinking disabled, valid
 * JSON output); falls back to the CLI subprocess path.
 *
 * @param prompt - Extraction prompt (from buildExtractionPrompt)
 * @returns Raw LLM response text
 * @throws Error if the LLM binary not found, non-zero exit, or timeout
 */
export async function extractMemories(prompt: string): Promise<string> {
  return runLlmPromptDirect(prompt, EXTRACTION_TIMEOUT_MS, {
    jsonMode: true,
    maxTokens: 8192,
  });
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
          source_id: { type: 'string' },
          target_id: { type: 'string' },
          relation_type: { type: 'string', enum: [...EDGE_RELATIONS] },
          strength: { type: 'number' },
        },
        required: ['source_id', 'target_id', 'relation_type', 'strength'],
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
 * @param pairs - Memory pairs to classify
 * @returns Array of edge classifications
 */
export async function classifyEdges(
  pairs: readonly MemoryPair[]
): Promise<readonly EdgeClassification[]> {
  if (pairs.length === 0) return [];

  const prompt = buildEdgeClassificationPrompt(pairs);
  const response = await runLlmPromptDirect(prompt, EDGE_CLASSIFICATION_TIMEOUT_MS, {
    jsonSchema: EDGE_CLASSIFICATION_SCHEMA,
    maxTokens: 4096,
  });
  // Strict mode on the direct path: guided decoding guarantees structured
  // output, so a JSON failure means truncation or a server problem — the
  // caller must count the batch as failed instead of silently dropping it.
  return parseEdgeClassificationResponse(response, { strict: true });
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
      "source_id": "id1",
      "target_id": "id2",
      "relation_type": "relates_to",
      "strength": 0.75
    }
  ]
}

If no strong relationships, return {"edges": []}.`;
}

/**
 * Parse edge classification response.
 * Pure function - returns parsed edges or empty array on failure.
 */
/**
 * Parse edge classification response.
 *
 * Default (tolerant) mode extracts JSON from fences/prose and returns [] on
 * any failure, matching the legacy subprocess path. Strict mode (direct API
 * with guided decoding) requires the whole response to be a valid JSON
 * array and throws otherwise — callers must treat that as a batch failure.
 */
export function parseEdgeClassificationResponse(
  response: string,
  options: { strict?: boolean } = {}
): readonly EdgeClassification[] {
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
    return array
      .filter(isValidEdgeClassification)
      .map((c) => ({
        source_id: String(c.source_id),
        target_id: String(c.target_id),
        relation_type: c.relation_type,
        strength: Number(c.strength),
      }));
  }

  try {
    // Extract JSON from response: ```json fence, else the first JSON slice
    // (handles trailing prose the model adds after the JSON array), else raw.
    const fenceMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonText = fenceMatch?.[1] ?? extractJsonSlice(response) ?? response;

    const parsed = JSON.parse(jsonText.trim());

    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate and filter classifications
    return parsed
      .filter(isValidEdgeClassification)
      .map((c) => ({
        source_id: String(c.source_id),
        target_id: String(c.target_id),
        relation_type: c.relation_type,
        strength: Number(c.strength),
      }));
  } catch (e) {
    process.stderr.write(`WARNING: Failed to parse edge classification response: ${(e as Error).message}\n`);
    return [];
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

  return true;
}
