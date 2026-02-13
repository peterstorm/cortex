/**
 * Pure functions for transcript extraction and parsing.
 * Implements FR-002, FR-004, FR-005, FR-006, FR-007, FR-008, FR-012, FR-108
 */

import type { MemoryType, MemoryScope, MemoryCandidate, GitContext } from './types.js';
import { MEMORY_TYPES, isMemoryType } from './types.js';

export interface TruncationResult {
  readonly truncated: string;
  readonly newCursor: number;
}

/**
 * Truncates transcript to maxBytes while preserving JSONL line boundaries.
 * Returns truncated content and new cursor position for resumable extraction.
 *
 * FR-004: Track cursor position for resumable extraction
 * FR-012: Transcript size threshold 100KB for resumable extraction
 *
 * @param content - JSONL transcript content
 * @param maxBytes - Maximum size in bytes (default 100KB per FR-012)
 * @param cursor - Optional starting position for resuming extraction
 * @returns Truncated content and new cursor position
 */
export function truncateTranscript(
  content: string,
  maxBytes: number = 100_000,
  cursor: number = 0
): TruncationResult {
  // Start from cursor position
  const remainingContent = content.slice(cursor);

  // If remaining content fits within maxBytes, return as-is
  const remainingBytes = Buffer.byteLength(remainingContent, "utf8");
  if (remainingBytes <= maxBytes) {
    return {
      truncated: remainingContent,
      newCursor: content.length, // End of content
    };
  }

  // Find the last complete line within maxBytes
  // Truncate to maxBytes first, then find last newline
  const truncatedBuffer = Buffer.from(remainingContent, "utf8").slice(
    0,
    maxBytes
  );
  const truncatedStr = truncatedBuffer.toString("utf8");

  // Find last newline to preserve JSONL boundary
  const lastNewline = truncatedStr.lastIndexOf("\n");

  if (lastNewline === -1) {
    // No newline found - return empty, cursor stays at current position
    return {
      truncated: "",
      newCursor: cursor,
    };
  }

  // Include the newline character
  const result = truncatedStr.slice(0, lastNewline + 1);
  const bytesConsumed = Buffer.byteLength(result, "utf8");

  return {
    truncated: result,
    newCursor: cursor + bytesConsumed,
  };
}

/**
 * Builds extraction prompt for LLM given transcript and git context.
 *
 * FR-002: Extract from JSONL transcript format
 * FR-005: Extract memory type (8 types)
 * FR-006: Extract confidence (0-1)
 * FR-007: Extract priority (1-10)
 * FR-008: Classify scope (project/global, >0.8 confidence = global)
 *
 * @param transcript - JSONL transcript content (possibly truncated)
 * @param gitContext - Git repository context
 * @param projectName - Project name for context
 * @returns Prompt string for LLM
 */
export function buildExtractionPrompt(
  transcript: string,
  gitContext: GitContext,
  projectName: string
): string {
  const { branch, recent_commits, changed_files } = gitContext;

  const contextBlock = [
    `Project: ${projectName}`,
    `Branch: ${branch}`,
    recent_commits && recent_commits.length > 0
      ? `Recent commits:\n${recent_commits.map((c) => `  - ${c}`).join("\n")}`
      : null,
    changed_files && changed_files.length > 0
      ? `Changed files:\n${changed_files.map((f) => `  - ${f}`).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `Extract memories from this Claude Code session transcript.

Git Context:
${contextBlock}

Transcript (JSONL format):
${transcript}

Extract memories following these rules:

1. Memory Types (FR-005):
   - architecture: System design, structure, patterns
   - decision: Choices made with rationale
   - pattern: Reusable code/design patterns
   - gotcha: Pitfalls, edge cases, warnings
   - context: Background info, explanations
   - progress: Status updates, completed work
   - code_description: Prose explanation of code
   - code: Raw source code (paired with code_description)

2. Scope Classification (FR-008):
   - global: Reusable across projects (confidence >0.8 required)
   - project: Specific to this project (default)

3. Confidence (FR-006): 0-1 score based on clarity and relevance
   - High (0.8-1.0): Clear, actionable, well-explained
   - Medium (0.5-0.79): Useful but could be clearer
   - Low (0.3-0.49): Vague or context-dependent

4. Priority (FR-007): 1-10 score based on importance
   - Critical (9-10): Must-know information
   - High (7-8): Important decisions/patterns
   - Medium (4-6): Useful context/progress
   - Low (1-3): Minor details

5. Tags: Extract relevant keywords/topics as array of strings

Return JSON array of memories:
[
  {
    "content": "Full detailed content",
    "summary": "Concise 1-2 sentence summary",
    "memory_type": "decision",
    "scope": "project",
    "confidence": 0.85,
    "priority": 8,
    "tags": ["api-design", "performance"]
  }
]

If no significant memories, return empty array [].`;
}

/**
 * Parses LLM extraction response into memory candidates.
 *
 * FR-005: Validate memory types
 * FR-006: Validate confidence range
 * FR-007: Validate priority range
 *
 * @param response - Raw LLM response text
 * @returns Array of validated memory candidates, or empty array on parse failure
 */
export function parseExtractionResponse(
  response: string
): readonly MemoryCandidate[] {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || [
      null,
      response,
    ];
    const jsonText = jsonMatch[1] || response;

    const parsed = JSON.parse(jsonText.trim());

    if (!Array.isArray(parsed)) {
      process.stderr.write(`[cortex:extraction] WARN: Expected array, got ${typeof parsed}. Returning empty.\n`);
      return [];
    }

    // Validate and filter candidates
    const valid = parsed.filter(isValidCandidate);
    if (valid.length === 0 && parsed.length > 0) {
      process.stderr.write(`[cortex:extraction] WARN: 0 valid from ${parsed.length} raw candidates\n`);
    }

    return valid.map((c) => ({
      content: String(c.content),
      summary: String(c.summary),
      memory_type: isMemoryType(c.memory_type) ? c.memory_type : 'context',
      scope: c.scope === 'global' ? 'global' as const : 'project' as const,
      confidence: Number(c.confidence),
      priority: Number(c.priority),
      tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[cortex:extraction] WARN: Parse failure: ${message}. Response (truncated): ${response.slice(0, 200)}\n`);
    return [];
  }
}

/**
 * Validates a memory candidate object.
 */
function isValidCandidate(obj: unknown): obj is MemoryCandidate {
  if (typeof obj !== "object" || obj === null) return false;

  const candidate = obj as Record<string, unknown>;

  // Check required fields exist
  if (
    typeof candidate.content !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.memory_type !== "string" ||
    typeof candidate.scope !== "string" ||
    typeof candidate.confidence !== "number" ||
    typeof candidate.priority !== "number"
  ) {
    return false;
  }

  // Validate memory type (FR-005)
  if (!MEMORY_TYPES.includes(candidate.memory_type as MemoryType)) {
    return false;
  }

  // Validate scope
  if (candidate.scope !== "project" && candidate.scope !== "global") {
    return false;
  }

  // Validate confidence range (FR-006)
  if (candidate.confidence < 0 || candidate.confidence > 1) {
    return false;
  }

  // Validate priority range (FR-007)
  if (
    candidate.priority < 1 ||
    candidate.priority > 10 ||
    !Number.isInteger(candidate.priority)
  ) {
    return false;
  }

  return true;
}

/**
 * Builds embedding text with metadata prefix for semantic search.
 *
 * FR-108: Embedding metadata prefix: '[memory_type] [project:name] summary content'
 *
 * @param memory - Memory candidate with type and content
 * @param projectName - Project name for prefix
 * @returns Formatted text for embedding
 */
export function buildEmbeddingText(
  memory: MemoryCandidate,
  projectName: string
): string {
  return `[${memory.memory_type}] [project:${projectName}] ${memory.summary}`;
}
