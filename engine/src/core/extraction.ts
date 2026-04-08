/**
 * Pure functions for transcript extraction and parsing.
 * Implements FR-002, FR-004, FR-005, FR-006, FR-007, FR-008, FR-012, FR-108
 */

import type { MemoryType, MemoryScope, MemoryCandidate, GitContext } from './types.js';
import { MEMORY_TYPES, isMemoryType } from './types.js';
import type { EntityFactCandidate, EntityProfile } from './entities.js';
import { isValidEntityFactCandidate } from './entities.js';

/** Result of parsing an extraction response — memories and optional entity-facts */
export interface ParsedExtractionResult {
  readonly memories: readonly MemoryCandidate[];
  readonly entities: readonly EntityFactCandidate[];
}

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
  projectName: string,
  knownEntities: readonly EntityProfile[] = []
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

  const knownEntitiesBlock = formatKnownEntities(knownEntities);

  return `Extract memories from this Claude Code session transcript.

Git Context:
${contextBlock}
${knownEntitiesBlock}
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

6. Entity Extraction:
   Extract notable entities and facts as subject-predicate-object triples.
   Entity types: person, project, tool, concept, org, other.
   Only extract concrete, factual assertions — not vague observations.

Return JSON object with memories and entities:
{
  "memories": [
    {
      "content": "Full detailed content",
      "summary": "Concise 1-2 sentence summary",
      "memory_type": "decision",
      "scope": "project",
      "confidence": 0.85,
      "priority": 8,
      "tags": ["api-design", "performance"]
    }
  ],
  "entities": [
    {
      "entity_name": "NixOS",
      "entity_type": "tool",
      "predicate": "used for",
      "object": "system configuration"
    }
  ]
}

If no significant memories or entities, return empty arrays.`;
}

/**
 * Parses LLM extraction response into memory candidates and entity-fact candidates.
 *
 * Supports two response formats for backward compatibility:
 * - Old format: JSON array of memories → { memories: [...], entities: [] }
 * - New format: JSON object with "memories" and optional "entities" keys
 *
 * FR-005: Validate memory types
 * FR-006: Validate confidence range
 * FR-007: Validate priority range
 *
 * @param response - Raw LLM response text
 * @returns Parsed memories and entity-fact candidates
 */
export function parseExtractionResponse(
  response: string
): ParsedExtractionResult {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || [
      null,
      response,
    ];
    const jsonText = jsonMatch[1] || response;

    const parsed = JSON.parse(jsonText.trim());

    // Determine format: old (plain array) or new (object with memories key)
    let rawMemories: unknown[];
    let rawEntities: unknown[];

    if (Array.isArray(parsed)) {
      // Old format: plain JSON array of memories
      rawMemories = parsed;
      rawEntities = [];
    } else if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.memories)) {
      // New format: { memories: [...], entities: [...] }
      rawMemories = parsed.memories;
      rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
    } else {
      process.stderr.write(`[cortex:extraction] WARN: Expected array or {memories:[]}, got ${typeof parsed}. Returning empty.\n`);
      return { memories: [], entities: [] };
    }

    // Validate and filter memory candidates
    const validMemories = rawMemories.filter(isValidCandidate);
    if (validMemories.length === 0 && rawMemories.length > 0) {
      process.stderr.write(`[cortex:extraction] WARN: 0 valid from ${rawMemories.length} raw candidates\n`);
    }

    const memories: readonly MemoryCandidate[] = validMemories.map((c) => ({
      content: String(c.content),
      summary: String(c.summary),
      memory_type: isMemoryType(c.memory_type) ? c.memory_type : 'context',
      scope: c.scope === 'global' ? 'global' as const : 'project' as const,
      confidence: Number(c.confidence),
      priority: Number(c.priority),
      tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    }));

    // Validate and filter entity-fact candidates
    const entities: readonly EntityFactCandidate[] = rawEntities
      .filter(isValidEntityFactCandidate)
      .map((c) => ({
        entity_name: String((c as any).entity_name).trim(),
        entity_type: (c as any).entity_type,
        predicate: String((c as any).predicate).trim(),
        object: String((c as any).object).trim(),
      }));

    return { memories, entities };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[cortex:extraction] WARN: Parse failure: ${message}. Response (truncated): ${response.slice(0, 200)}\n`);
    return { memories: [], entities: [] };
  }
}

/**
 * Format known entities as a prompt section for extraction context.
 * Max 20 entities, max 3 facts each. Compact one-line-per-entity format.
 * Pure function.
 */
export function formatKnownEntities(
  profiles: readonly EntityProfile[],
  maxEntities: number = 20,
  maxFactsPerEntity: number = 3
): string {
  const withFacts = profiles.filter(p => p.currentFacts.length > 0);
  if (withFacts.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push('Known Entities (already tracked):');

  const selected = withFacts.slice(0, maxEntities);
  for (const profile of selected) {
    const facts = profile.currentFacts
      .slice(0, maxFactsPerEntity)
      .map(f => `${f.predicate} → ${f.object}`)
      .join('; ');
    lines.push(`- ${profile.entity.name} (${profile.entity.entity_type}): ${facts}`);
  }

  lines.push('');
  lines.push('Do NOT re-extract facts that are already known unless the transcript contradicts them.');
  lines.push('When a new fact contradicts an existing one, extract the new fact — it will supersede the old one.');
  lines.push('');

  return lines.join('\n');
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
