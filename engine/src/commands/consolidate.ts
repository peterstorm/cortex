/**
 * Consolidate command: Detect and merge duplicate memories
 * FR-071, FR-074, FR-075, FR-076, FR-077, FR-079, FR-080, FR-081, FR-082
 *
 * Split into functional core (pure) and imperative shell (I/O)
 */

import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import {
  getActiveMemories,
  createCheckpoint,
  restoreCheckpoint,
  insertMemory,
  insertEdge,
  updateMemory,
} from '../infra/db.js';
import { tokenize, jaccardSimilarity, cosineSimilarity, jaccardPreFilter } from '../core/similarity.js';
import { createMemory } from '../core/types.js';

// ============================================================================
// FUNCTIONAL CORE - PURE FUNCTIONS
// ============================================================================

/**
 * Memory pair with similarity score
 */
export interface MemoryPair {
  readonly memoryA: Memory;
  readonly memoryB: Memory;
  readonly similarity: number;
}

/**
 * Find similar pairs among active memories
 * FR-071: Detect duplicate memories via semantic similarity
 * FR-074: Present pairs with similarity > threshold
 *
 * Uses Jaccard pre-filter to avoid unnecessary cosine computations.
 * Only compares memories with embeddings of the same type (gemini vs local).
 *
 * @param memories - Active memories to compare
 * @param threshold - Similarity threshold (default 0.5)
 * @returns Array of similar pairs sorted by similarity (descending)
 */
export function findSimilarPairs(
  memories: readonly Memory[],
  threshold: number = 0.5
): readonly MemoryPair[] {
  const pairs: MemoryPair[] = [];

  // Compare each pair exactly once (i < j ensures no duplicates)
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const memoryA = memories[i];
      const memoryB = memories[j];

      // Jaccard pre-filter (cheap text-based similarity)
      const tokensA = tokenize(memoryA.summary);
      const tokensB = tokenize(memoryB.summary);
      const jaccardScore = jaccardSimilarity(tokensA, tokensB);
      const preFilter = jaccardPreFilter(jaccardScore);

      // Skip if definitely different (Jaccard < 0.1)
      if (preFilter.result === 'definitely_different') {
        continue;
      }

      // If definitely similar (Jaccard > 0.6), use Jaccard score
      if (preFilter.result === 'definitely_similar') {
        pairs.push({ memoryA, memoryB, similarity: jaccardScore });
        continue;
      }

      // "maybe" range (0.1 <= Jaccard <= 0.6) - use cosine if embeddings available
      // Prefer gemini embeddings over local
      const embeddingA = memoryA.embedding ?? memoryA.local_embedding;
      const embeddingB = memoryB.embedding ?? memoryB.local_embedding;

      if (embeddingA && embeddingB) {
        // Check dimension match (gemini=768, local=384)
        if (embeddingA.length !== embeddingB.length) {
          // Dimension mismatch - fall back to Jaccard
          if (jaccardScore >= threshold) {
            pairs.push({ memoryA, memoryB, similarity: jaccardScore });
          }
          continue;
        }

        const cosineSim = cosineSimilarity(embeddingA, embeddingB);
        if (cosineSim >= threshold) {
          pairs.push({ memoryA, memoryB, similarity: cosineSim });
        }
      } else {
        // No embeddings - fall back to Jaccard
        if (jaccardScore >= threshold) {
          pairs.push({ memoryA, memoryB, similarity: jaccardScore });
        }
      }
    }
  }

  // Sort by similarity descending
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Format a memory pair for human review
 * FR-074: Present pairs for review
 *
 * @param pair - Memory pair to format
 * @returns Human-readable string representation
 */
export function formatPairForReview(pair: MemoryPair): string {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Similarity: ${(pair.similarity * 100).toFixed(1)}%

Memory A (ID: ${pair.memoryA.id})
  Type: ${pair.memoryA.memory_type}
  Priority: ${pair.memoryA.priority}
  Summary: ${pair.memoryA.summary}
  Content: ${pair.memoryA.content}

Memory B (ID: ${pair.memoryB.id})
  Type: ${pair.memoryB.memory_type}
  Priority: ${pair.memoryB.priority}
  Summary: ${pair.memoryB.summary}
  Content: ${pair.memoryB.content}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
}

/**
 * Build merged memory from a pair
 * FR-075: Merge memories with combined summary
 * FR-076: Mark as superseding old memories
 *
 * Pure function - creates new memory domain object
 *
 * Strategy:
 * - Use higher priority of the two
 * - Preserve pinned flag if either is pinned
 * - Combine tags (deduplicated)
 * - Prefer voyage embedding over local if available
 * - Use provided merged summary and content
 * - Set scope to 'global' if either is global, else 'project'
 *
 * @param pair - Memory pair to merge
 * @param mergedSummary - Human-provided merged summary
 * @param mergedContent - Human-provided merged content
 * @param sessionId - Current session ID for source tracking
 * @returns New merged memory
 */
export function buildMergedMemory(
  pair: MemoryPair,
  mergedSummary: string,
  mergedContent: string,
  sessionId: string,
  id: string,
  now: string
): Memory {
  const { memoryA, memoryB } = pair;

  // Merge strategy
  const priority = Math.max(memoryA.priority, memoryB.priority);
  const pinned = memoryA.pinned || memoryB.pinned;
  const scope = memoryA.scope === 'global' || memoryB.scope === 'global' ? 'global' : 'project';

  // Combine and deduplicate tags
  const combinedTags = Array.from(new Set([...memoryA.tags, ...memoryB.tags]));

  // Prefer gemini embedding from either memory
  const embedding = memoryA.embedding ?? memoryB.embedding ?? null;
  const local_embedding = memoryA.local_embedding ?? memoryB.local_embedding ?? null;

  // Use memory type from higher-priority memory
  const memory_type = memoryA.priority >= memoryB.priority ? memoryA.memory_type : memoryB.memory_type;

  // Build source context with merge metadata
  const source_context = JSON.stringify({
    source: 'consolidation',
    merged_from: [memoryA.id, memoryB.id],
    session_id: sessionId,
  });

  return createMemory({
    id,
    content: mergedContent,
    summary: mergedSummary,
    memory_type,
    scope,
    embedding,
    local_embedding,
    confidence: 1.0, // Merged memories have full confidence (human-approved)
    priority,
    pinned,
    source_type: 'manual', // Consolidation is a manual operation
    source_session: sessionId,
    source_context,
    tags: combinedTags,
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    status: 'active',
  });
}

// ============================================================================
// IMPERATIVE SHELL - I/O ORCHESTRATION
// ============================================================================

/**
 * Result of consolidate operation
 */
export interface ConsolidateResult {
  readonly pairs_found: number;
  readonly pairs_merged: number;
  readonly pairs_skipped: number;
  readonly checkpoint_path: string;
}

/**
 * Options for consolidate command
 */
export interface ConsolidateOptions {
  readonly threshold?: number; // Default 0.5
  readonly maxPasses?: number; // Default 3 (FR-081)
  readonly sessionId?: string; // For source tracking
}

/**
 * Detect duplicate memories and return pairs for review
 * FR-071: Detect duplicates via similarity > 0.5
 * FR-074: Present pairs for review
 *
 * This is a read-only operation that returns pairs for the caller to review.
 * The caller (skill/agent) decides which pairs to merge.
 *
 * @param db - Database instance
 * @param options - Detection options
 * @returns Array of similar pairs
 */
export function detectDuplicates(
  db: Database,
  options: ConsolidateOptions = {}
): readonly MemoryPair[] {
  const threshold = options.threshold ?? 0.5;

  // I/O: Fetch all active memories
  const activeMemories = getActiveMemories(db);

  // Pure: Find similar pairs
  const pairs = findSimilarPairs(activeMemories, threshold);

  return pairs;
}

/**
 * Merge a single memory pair
 * FR-075: Merge memories
 * FR-076: Create supersedes edges
 * FR-077: Mark old memories as superseded
 * FR-082: Human-only operation (not automatic)
 *
 * I/O boundary - performs database operations
 *
 * @param db - Database instance
 * @param pair - Memory pair to merge
 * @param mergedSummary - Human-provided merged summary
 * @param mergedContent - Human-provided merged content
 * @param sessionId - Current session ID
 * @returns ID of newly created merged memory
 */
export function mergePair(
  db: Database,
  pair: MemoryPair,
  mergedSummary: string,
  mergedContent: string,
  sessionId: string
): string {
  // Pure: Build merged memory (id + timestamp from I/O boundary)
  const mergedMemory = buildMergedMemory(
    pair, mergedSummary, mergedContent, sessionId,
    randomUUID(), new Date().toISOString()
  );

  // I/O: All DB writes in a single transaction for atomicity
  const tx = db.transaction(() => {
    insertMemory(db, mergedMemory);

    // Create supersedes edges (FR-076)
    insertEdge(db, {
      source_id: mergedMemory.id,
      target_id: pair.memoryA.id,
      relation_type: 'supersedes',
      strength: 1.0,
      bidirectional: false,
      status: 'active',
    });

    insertEdge(db, {
      source_id: mergedMemory.id,
      target_id: pair.memoryB.id,
      relation_type: 'supersedes',
      strength: 1.0,
      bidirectional: false,
      status: 'active',
    });

    // Mark old memories as superseded (FR-077)
    updateMemory(db, pair.memoryA.id, { status: 'superseded' });
    updateMemory(db, pair.memoryB.id, { status: 'superseded' });
  });

  tx();

  return mergedMemory.id;
}

/**
 * Execute full consolidate command with checkpoint/rollback safety
 * FR-079: Create checkpoint before consolidation
 * FR-080: Rollback on failure
 * FR-081: Max 3 passes per trigger
 *
 * Note: This function detects pairs but does NOT automatically merge them.
 * FR-082 requires human approval for each merge. The caller (skill/agent)
 * must call detectDuplicates() to get pairs, review them, and then call
 * mergePair() for each approved merge.
 *
 * This function is provided for convenience in testing and future automation,
 * but in production the skill will use detectDuplicates() + mergePair() directly.
 *
 * @param db - Database instance
 * @param options - Consolidate options
 * @returns Consolidate result
 */
export function executeConsolidate(
  db: Database,
  options: ConsolidateOptions = {}
): ConsolidateResult {
  const threshold = options.threshold ?? 0.5;
  const maxPasses = options.maxPasses ?? 3; // FR-081: default 3, enforced below
  const sessionId = options.sessionId ?? 'consolidate-session';

  // FR-079: Create checkpoint before consolidation
  let checkpointPath: string;
  try {
    checkpointPath = createCheckpoint(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create checkpoint: ${message}`);
  }

  try {
    let totalPairsMerged = 0;
    let totalPairsSkipped = 0;
    let totalPairsFound = 0;

    // FR-081: Cap detection passes to prevent infinite loops.
    // Each pass detects pairs; merging is human-only (FR-082).
    // Currently single-pass since no auto-merge, but the guard
    // ensures safety if iterative merge logic is added later.
    for (let pass = 0; pass < maxPasses; pass++) {
      const activeMemories = getActiveMemories(db);
      const pairs = findSimilarPairs(activeMemories, threshold);

      totalPairsFound += pairs.length;
      totalPairsSkipped += pairs.length;

      // FR-082: human-only — pairs returned for review, not auto-merged.
      // No merges happen here, so subsequent passes would find same pairs.
      // Break after first pass since results won't change without merges.
      break;
    }

    // Clean up checkpoint file on success
    try { unlinkSync(checkpointPath); } catch { /* already gone */ }

    return {
      pairs_found: totalPairsFound,
      pairs_merged: totalPairsMerged,
      pairs_skipped: totalPairsSkipped,
      checkpoint_path: checkpointPath,
    };
  } catch (err) {
    // FR-080: Rollback on failure
    try {
      restoreCheckpoint(db, checkpointPath);
    } catch (rollbackErr) {
      const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      const origMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Consolidation failed AND rollback failed. Original: ${origMsg}. Rollback: ${rollbackMsg}`
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Consolidation failed (rolled back): ${message}`);
  }
}
