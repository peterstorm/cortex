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
  getMemory,
  repointEdgesToMemory,
  repointFactSources,
} from '../infra/db.js';
import { tokenize, hybridSimilarityScored } from '../core/similarity.js';
import { createMemory } from '../core/types.js';
import type { SimilaritySpace } from '../core/types.js';
import { consolidationThresholdFor } from '../config.js';
import { invalidateSurfaceCache } from './generate.js';

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
 * The duplicate threshold is calibrated PER SIMILARITY SPACE: raw local-BGE
 * cosine runs hot (same-domain pairs score 0.6-0.75), so it uses
 * CONSOLIDATION_LOCAL_COSINE_THRESHOLD (0.8) while Jaccard and Gemini cosine
 * use CONSOLIDATION_SIMILARITY_THRESHOLD (0.5). An explicit `threshold`
 * argument overrides the per-space defaults uniformly.
 *
 * @param memories - Active memories to compare
 * @param threshold - Optional uniform threshold override (default: per-space)
 * @returns Array of similar pairs sorted by similarity (descending)
 */
export function findSimilarPairs(
  memories: readonly Memory[],
  threshold?: number
): readonly MemoryPair[] {
  const pairs: MemoryPair[] = [];

  // Pre-tokenize all memories once (summary+content) to avoid O(n^2) re-tokenization
  const tokenSets = memories.map(m => tokenize(`${m.summary} ${m.content}`));

  // Per pair, compare within a common embedding space: gemini-gemini if both
  // have one, else local-local, else no embeddings (Jaccard fallback).
  // Picking `embedding ?? local_embedding` per memory independently would
  // produce cross-type pairs (768d vs 384d) that always fall back to Jaccard.
  const commonEmbeddings = (
    a: Memory,
    b: Memory
  ): {
    embA: Float64Array | Float32Array | null;
    embB: Float64Array | Float32Array | null;
    cosineSpace: SimilaritySpace;
  } => {
    if (a.embedding && b.embedding) {
      return { embA: a.embedding, embB: b.embedding, cosineSpace: 'gemini-cosine' };
    }
    if (a.local_embedding && b.local_embedding) {
      return { embA: a.local_embedding, embB: b.local_embedding, cosineSpace: 'local-cosine' };
    }
    return { embA: null, embB: null, cosineSpace: 'jaccard' };
  };

  // Compare each pair exactly once (i < j ensures no duplicates)
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const { embA, embB, cosineSpace } = commonEmbeddings(memories[i], memories[j]);
      const { score, method } = hybridSimilarityScored(tokenSets[i], tokenSets[j], embA, embB);
      // Dimension mismatch inside hybridSimilarityScored falls back to
      // Jaccard even when embeddings were provided — trust `method`.
      const space: SimilaritySpace = method === 'cosine' ? cosineSpace : 'jaccard';
      const pairThreshold = threshold ?? consolidationThresholdFor(space);

      if (score >= pairThreshold) {
        pairs.push({ memoryA: memories[i], memoryB: memories[j], similarity: score });
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
 * - Embeddings start null: merged content is new text, so carrying over an
 *   old embedding would make future recall/dedup rank against stale vectors.
 *   Backfill (which fills null embeddings) re-embeds at next opportunity.
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
    embedding: null,
    local_embedding: null,
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
  readonly threshold?: number; // Default: per-space (consolidationThresholdFor)
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
  // I/O: Fetch all active memories
  const activeMemories = getActiveMemories(db);

  // Pure: Find similar pairs (per-space threshold unless overridden)
  const pairs = findSimilarPairs(activeMemories, options.threshold);

  return pairs;
}

/**
 * Result of a mergePair attempt (discriminated union).
 * 'skipped' means no DB mutation happened — e.g. a member of the pair
 * was already superseded by an earlier merge in the same review session.
 */
export type MergePairResult =
  | { readonly kind: 'merged'; readonly mergedId: string }
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * Merge a single memory pair
 * FR-075: Merge memories
 * FR-076: Create supersedes edges
 * FR-077: Mark old memories as superseded
 * FR-082: Human-only operation (not automatic)
 *
 * The merged memory inherits all non-supersedes edges of both members
 * (source_of pairings, typed semantic edges) and the members' entity facts
 * are re-pointed to it — merging must not orphan the graph.
 *
 * I/O boundary - performs database operations
 *
 * @param db - Database instance
 * @param pair - Memory pair to merge
 * @param mergedSummary - Human-provided merged summary
 * @param mergedContent - Human-provided merged content
 * @param sessionId - Current session ID
 * @param cwd - Project root; when provided, the surface cache is invalidated
 *              after a successful merge (superseded members must not be
 *              served from a stale cached surface)
 * @returns MergePairResult — merged with new ID, or skipped with reason
 */
export function mergePair(
  db: Database,
  pair: MemoryPair,
  mergedSummary: string,
  mergedContent: string,
  sessionId: string,
  cwd?: string
): MergePairResult {
  // Pure: Build merged memory (id + timestamp from I/O boundary)
  const mergedMemory = buildMergedMemory(
    pair, mergedSummary, mergedContent, sessionId,
    randomUUID(), new Date().toISOString()
  );

  let skipped: MergePairResult | null = null;

  // I/O: All DB writes in a single transaction for atomicity
  const tx = db.transaction(() => {
    // Guard: pair members must still be active IN THE DATABASE. Pairs come
    // from a snapshot; with overlapping pairs (A,B),(B,C) a member already
    // superseded by an earlier merge must not be merged again. Checking the
    // in-memory snapshot is not enough — re-fetch by ID inside the tx.
    for (const member of [pair.memoryA, pair.memoryB]) {
      const fresh = getMemory(db, member.id);
      if (!fresh) {
        skipped = { kind: 'skipped', reason: `memory ${member.id} no longer exists` };
        return;
      }
      if (fresh.status !== 'active') {
        skipped = {
          kind: 'skipped',
          reason: `memory ${member.id} has status '${fresh.status}' (expected 'active')`,
        };
        return;
      }
    }

    insertMemory(db, mergedMemory);

    // Re-point graph edges and facts from old members to the merged memory
    // (must precede superseding; deleting them would orphan code pairings)
    repointEdgesToMemory(db, pair.memoryA.id, mergedMemory.id);
    repointEdgesToMemory(db, pair.memoryB.id, mergedMemory.id);
    repointFactSources(db, pair.memoryA.id, mergedMemory.id);
    repointFactSources(db, pair.memoryB.id, mergedMemory.id);

    // Mark old memories as superseded (FR-077)
    updateMemory(db, pair.memoryA.id, { status: 'superseded' });
    updateMemory(db, pair.memoryB.id, { status: 'superseded' });

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
  });

  tx();

  if (skipped) return skipped;

  // Invalidate cached surfaces: two members were superseded and a merged
  // memory was inserted — any cached surface is stale.
  if (cwd !== undefined) {
    invalidateSurfaceCache(cwd);
  }

  return { kind: 'merged', mergedId: mergedMemory.id };
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
  const threshold = options.threshold; // undefined → per-space defaults
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
