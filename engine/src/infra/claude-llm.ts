/**
 * Claude CLI client for memory extraction.
 * Shells out to `claude -p` via Bun.spawn — leverages user's Anthropic subscription.
 *
 * FR-001: Extract memories automatically at session end
 * FR-009: Complete extraction within 30 seconds (p95)
 */

import type { MemoryPair, EdgeClassification } from './gemini-llm.js';
import { buildEdgeClassificationPrompt, parseEdgeClassificationResponse } from './gemini-llm.js';

const EXTRACTION_TIMEOUT_MS = 30_000;

/**
 * Check if `claude` binary is available on PATH.
 */
export function isClaudeLlmAvailable(): boolean {
  return Bun.which('claude') !== null;
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
  if (!isClaudeLlmAvailable()) {
    throw new Error('Claude CLI not found on PATH — install claude or verify PATH');
  }

  const proc = Bun.spawn(
    ['claude', '-p', '--model', 'haiku', '--output-format', 'text', '--allowedTools', ''],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CORTEX_EXTRACTING: '1' },
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

  // Race between process completion and timeout
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Claude extraction timed out after ${EXTRACTION_TIMEOUT_MS}ms`));
    }, EXTRACTION_TIMEOUT_MS)
  );

  const result = await Promise.race([proc.exited, timeout]);

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
 * Classify edges between memory pairs using Claude CLI.
 * Kept for parity with gemini-llm — not wired in v1.
 *
 * @param pairs - Memory pairs to classify
 * @returns Array of edge classifications
 */
export async function classifyEdges(
  pairs: readonly MemoryPair[]
): Promise<readonly EdgeClassification[]> {
  if (pairs.length === 0) return [];

  const prompt = buildEdgeClassificationPrompt(pairs);
  const response = await extractMemories(prompt);
  return parseEdgeClassificationResponse(response);
}
