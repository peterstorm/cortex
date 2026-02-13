/**
 * Extract command: Session-end memory extraction pipeline
 *
 * Satisfies:
 * - FR-001: Extract memories automatically at session end
 * - FR-004: Track cursor position via extractions table
 * - FR-009: Complete extraction within 30 seconds (p95)
 * - FR-010: Handle extraction errors without blocking session closure
 * - FR-011: Log extraction errors to inspect later
 * - FR-012: Support resumable extraction if transcript >100KB
 *
 * Imperative shell - orchestrates I/O and pure functions:
 * 1. Read transcript file
 * 2. Get extraction checkpoint
 * 3. Truncate if needed (pure)
 * 4. Get git context
 * 5. Build extraction prompt (pure)
 * 6. Call Claude CLI
 * 7. Parse response (pure)
 * 8. For each candidate:
 *    - Insert memory
 *    - Compute similarity + create edges
 * 9. Save checkpoint
 * 10. Run lifecycle
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { HookInput, Memory, MemoryCandidate } from '../core/types.js';
import { createMemory } from '../core/types.js';
import {
  truncateTranscript,
  buildExtractionPrompt,
  parseExtractionResponse,
} from '../core/extraction.js';
import {
  tokenize,
  jaccardSimilarity,
  jaccardPreFilter,
  cosineSimilarity,
  classifySimilarity,
} from '../core/similarity.js';
import {
  insertMemory,
  getExtractionCheckpoint,
  saveExtractionCheckpoint,
  getActiveMemories,
  insertEdge,
} from '../infra/db.js';
import { extractMemories, isClaudeLlmAvailable } from '../infra/claude-llm.js';
import { getGitContext } from '../infra/git-context.js';
import { runLifecycle } from './lifecycle.js';
import { invalidateSurfaceCache } from './generate.js';

// ============================================================================
// RESULT TYPES
// ============================================================================

export interface ExtractionResult {
  readonly success: boolean;
  readonly extracted_count: number;
  readonly edge_count: number;
  readonly cursor_position: number;
  readonly error?: string;
}

// ============================================================================
// IMPERATIVE SHELL - I/O ORCHESTRATION
// ============================================================================

/**
 * Execute extraction command
 * I/O boundary - orchestrates pure functions with external operations
 *
 * NEVER throws - all errors caught and returned in result for FR-010
 *
 * @param input - Hook input from stdin
 * @param projectDb - Project database instance
 * @returns Extraction result
 */
export async function executeExtract(
  input: HookInput,
  projectDb: Database
): Promise<ExtractionResult> {
  try {
    // Validate Claude CLI availability
    if (!isClaudeLlmAvailable()) {
      logInfo('Claude CLI not found on PATH — extraction skipped');
      return {
        success: false,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: 0,
        error: 'Claude CLI not available',
      };
    }

    // I/O: Read transcript file
    let transcriptContent: string;
    try {
      transcriptContent = readFileSync(input.transcript_path, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to read transcript: ${message}`);
      return {
        success: false,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: 0,
        error: `Failed to read transcript: ${message}`,
      };
    }

    // I/O: Get extraction checkpoint for resumable extraction (FR-004)
    const checkpoint = getExtractionCheckpoint(projectDb, input.session_id);
    const cursorStart = checkpoint?.cursor_position ?? 0;

    // Pure: Truncate transcript if >100KB (FR-012)
    const { truncated, newCursor } = truncateTranscript(
      transcriptContent,
      100_000,
      cursorStart
    );

    // Skip if no new content
    if (truncated.trim() === '') {
      return {
        success: true,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: newCursor,
      };
    }

    // I/O: Get git context
    const gitContext = getGitContext(input.cwd);

    // Pure: Derive project name from cwd
    const projectName = basename(input.cwd);

    // Pure: Build extraction prompt
    const prompt = buildExtractionPrompt(truncated, gitContext, projectName);

    // I/O: Call Claude CLI for extraction (async)
    logInfo('Using Claude for memory extraction');
    let response: string;
    try {
      response = await extractMemories(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Claude extraction failed: ${message}`);
      // Save checkpoint at newCursor to advance past failed chunk (no retry)
      saveExtractionCheckpoint(projectDb, {
        session_id: input.session_id,
        cursor_position: newCursor,
        extracted_at: new Date().toISOString(),
      });
      return {
        success: false,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: newCursor,
        error: `Claude extraction failed: ${message}`,
      };
    }

    // Pure: Parse extraction response
    const candidates = parseExtractionResponse(response);

    if (candidates.length === 0) {
      // No memories extracted - still save checkpoint
      saveExtractionCheckpoint(projectDb, {
        session_id: input.session_id,
        cursor_position: newCursor,
        extracted_at: new Date().toISOString(),
      });

      return {
        success: true,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: newCursor,
      };
    }

    // Process each candidate — individual insert failures are non-fatal.
    // Intentional: we continue inserting remaining candidates even if one fails,
    // because partial extraction is better than none (FR-010).
    const insertedMemories: Memory[] = [];
    for (const candidate of candidates) {
      try {
        const memory = candidateToMemory(candidate, input.session_id, gitContext);
        insertMemory(projectDb, memory);
        insertedMemories.push(memory);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Failed to insert memory: ${message}`);
      }
    }

    // Compute similarity and create edges (FR-061)
    let edgeCount = 0;
    if (insertedMemories.length > 0) {
      try {
        edgeCount = computeSimilarityAndCreateEdges(
          projectDb,
          insertedMemories
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Failed to compute similarity: ${message}`);
        // Non-fatal - continue
      }
    }

    // I/O: Save checkpoint (FR-004)
    saveExtractionCheckpoint(projectDb, {
      session_id: input.session_id,
      cursor_position: newCursor,
      extracted_at: new Date().toISOString(),
    });

    // I/O: Run lifecycle (decay, archive, prune)
    try {
      runLifecycle(projectDb);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Lifecycle failed: ${message}`);
      // Non-fatal - continue
    }

    // I/O: Invalidate surface cache since new memories were extracted (FR-022)
    if (insertedMemories.length > 0) {
      try {
        invalidateSurfaceCache(input.cwd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Cache invalidation failed: ${message}`);
        // Non-fatal - continue
      }
    }

    return {
      success: true,
      extracted_count: insertedMemories.length,
      edge_count: edgeCount,
      cursor_position: newCursor,
    };
  } catch (err) {
    // Catch-all for unexpected errors (FR-010, FR-011)
    const message = err instanceof Error ? err.message : String(err);
    logError(`Unexpected extraction error: ${message}`);
    return {
      success: false,
      extracted_count: 0,
      edge_count: 0,
      cursor_position: 0,
      error: `Unexpected error: ${message}`,
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert memory candidate to full Memory object
 * Pure function - builds domain object
 */
function candidateToMemory(
  candidate: MemoryCandidate,
  sessionId: string,
  gitContext: { branch: string; recent_commits: readonly string[]; changed_files: readonly string[] }
): Memory {
  const id = randomUUID();
  const now = new Date().toISOString();

  const sourceContext = JSON.stringify({
    branch: gitContext.branch,
    commits: gitContext.recent_commits.slice(0, 3), // Top 3 commits
    files: gitContext.changed_files.slice(0, 10),   // Top 10 files
  });

  return createMemory({
    id,
    content: candidate.content,
    summary: candidate.summary,
    memory_type: candidate.memory_type,
    scope: candidate.scope,
    confidence: candidate.confidence,
    priority: candidate.priority,
    pinned: false,
    source_type: 'extraction',
    source_session: sessionId,
    source_context: sourceContext,
    tags: candidate.tags,
    embedding: null, // Queue for backfill
    local_embedding: null,  // Queue for backfill
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    status: 'active',
  });
}

/**
 * Compute similarity between new memories and existing, create edges
 * I/O boundary - reads existing memories, inserts edges
 *
 * Uses Jaccard pre-filter to avoid unnecessary comparisons (FR-061)
 *
 * @param db - Database instance
 * @param newMemories - Newly inserted memories
 * @returns Number of edges created
 */
function computeSimilarityAndCreateEdges(
  db: Database,
  newMemories: readonly Memory[]
): number {
  // I/O: Get all active memories for comparison
  const existingMemories = getActiveMemories(db);

  let edgeCount = 0;

  for (const newMem of newMemories) {
    // Pure: Tokenize new memory for Jaccard comparison
    const newTokens = tokenize(`${newMem.summary} ${newMem.content}`);

    for (const existingMem of existingMemories) {
      // Skip self-comparison
      if (newMem.id === existingMem.id) continue;

      // Pure: Tokenize existing memory
      const existingTokens = tokenize(`${existingMem.summary} ${existingMem.content}`);

      // Pure: Jaccard pre-filter (FR-061)
      const jaccardScore = jaccardSimilarity(newTokens, existingTokens);
      const preFilter = jaccardPreFilter(jaccardScore);

      // Skip if definitely different
      if (preFilter.result === 'definitely_different') {
        continue;
      }

      // For "maybe" range: compute cosine similarity if embeddings available
      // Since we queue embeddings for backfill, skip cosine for now
      // In future, this would use gemini/local embeddings if available

      // For now, use Jaccard score directly for "maybe" range
      if (preFilter.result === 'maybe') {
        // Pure: Classify similarity action
        const action = classifySimilarity(jaccardScore);

        // Create edge based on action
        if (action.action === 'relate') {
          try {
            insertEdge(db, {
              source_id: newMem.id,
              target_id: existingMem.id,
              relation_type: 'relates_to',
              strength: action.strength,
              bidirectional: true,
              status: 'active',
            });
            edgeCount++;
          } catch (err) {
            // Duplicate edge constraint - skip silently
          }
        } else if (action.action === 'suggest') {
          try {
            insertEdge(db, {
              source_id: newMem.id,
              target_id: existingMem.id,
              relation_type: 'relates_to',
              strength: action.strength,
              bidirectional: true,
              status: 'suggested',
            });
            edgeCount++;
          } catch (err) {
            // Duplicate edge constraint - skip silently
          }
        }
        // Note: 'consolidate' action logged but not handled in v1
      }

      // If definitely_similar, create strong edge
      if (preFilter.result === 'definitely_similar') {
        try {
          insertEdge(db, {
            source_id: newMem.id,
            target_id: existingMem.id,
            relation_type: 'relates_to',
            strength: jaccardScore,
            bidirectional: true,
            status: 'active',
          });
          edgeCount++;
        } catch (err) {
          // Duplicate edge constraint - skip silently
        }
      }
    }
  }

  return edgeCount;
}

/**
 * Log error to stderr (FR-011)
 * Non-blocking error reporting
 */
function logError(message: string): void {
  process.stderr.write(`[cortex:extract] ERROR: ${message}\n`);
}

/**
 * Log info to stderr
 */
function logInfo(message: string): void {
  process.stderr.write(`[cortex:extract] INFO: ${message}\n`);
}
