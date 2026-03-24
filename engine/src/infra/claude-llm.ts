/**
 * Claude CLI client for memory extraction and edge classification.
 * Shells out to `claude -p` via Bun.spawn — leverages user's Anthropic subscription.
 *
 * FR-001: Extract memories automatically at session end
 * FR-009: Complete extraction within 30 seconds (p95)
 * FR-056: Support typed edges between memories
 */

import type { EdgeRelation } from '../core/types.js';
import { isEdgeRelation } from '../core/types.js';

const EXTRACTION_TIMEOUT_MS = 30_000;
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

/**
 * Check if `claude` binary is available on PATH.
 */
export function isClaudeLlmAvailable(): boolean {
  return Bun.which('claude') !== null;
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
async function runClaudePrompt(prompt: string, timeoutMs: number): Promise<string> {
  if (!isClaudeLlmAvailable()) {
    throw new Error('Claude CLI not found on PATH — install claude or verify PATH');
  }

  const proc = Bun.spawn(
    ['claude', '-p', '--model', 'haiku', '--output-format', 'text', '--allowedTools', ''],
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
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
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
    throw new Error(`Claude CLI exited with code ${result}: ${stderr.slice(0, 500)}`);
  }

  const stdout = await stdoutPromise;

  if (!stdout.trim()) {
    throw new Error('Empty response from Claude CLI');
  }

  return stdout;
}

/**
 * Extract memories from transcript using Claude CLI.
 * Pipes prompt to `claude -p` via stdin and returns raw response text.
 * Caller is responsible for parsing via parseExtractionResponse.
 *
 * @param prompt - Extraction prompt (from buildExtractionPrompt)
 * @returns Raw Claude response text
 * @throws Error if binary not found, non-zero exit, or timeout
 */
export async function extractMemories(prompt: string): Promise<string> {
  return runClaudePrompt(prompt, EXTRACTION_TIMEOUT_MS);
}

/**
 * Classify edges between memory pairs using Claude CLI.
 * Uses a longer timeout (90s) since this runs fire-and-forget
 * and the classification prompt is larger than extraction.
 *
 * @param pairs - Memory pairs to classify
 * @returns Array of edge classifications
 */
export async function classifyEdges(
  pairs: readonly MemoryPair[]
): Promise<readonly EdgeClassification[]> {
  if (pairs.length === 0) return [];

  const prompt = buildEdgeClassificationPrompt(pairs);
  const response = await runClaudePrompt(prompt, EDGE_CLASSIFICATION_TIMEOUT_MS);
  return parseEdgeClassificationResponse(response);
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

Return JSON array:
[
  {
    "source_id": "id1",
    "target_id": "id2",
    "relation_type": "relates_to",
    "strength": 0.75
  }
]

If no strong relationships, return empty array [].`;
}

/**
 * Parse edge classification response.
 * Pure function - returns parsed edges or empty array on failure.
 */
export function parseEdgeClassificationResponse(
  response: string
): readonly EdgeClassification[] {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || [
      null,
      response,
    ];
    const jsonText = jsonMatch[1] || response;

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
