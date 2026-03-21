/**
 * Semantic edge classification command
 *
 * Upgrades generic 'relates_to' edges (created by Jaccard pre-filter) with
 * typed relationships using Claude Haiku via `claude -p`.
 *
 * FR-056: Typed edges between memories
 *
 * Flow:
 * 1. Find all 'relates_to' edges (Jaccard-created)
 * 2. Load source/target memories for each
 * 3. Batch pairs and send to Claude Haiku for classification
 * 4. Replace generic edges with typed ones
 *
 * Designed to run as fire-and-forget step in extract-and-generate hook.
 */

import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import type { MemoryPair, EdgeClassification } from '../infra/gemini-llm.js';
import { getRelatesToEdges, getMemoryById, deleteEdge, insertEdge } from '../infra/db.js';
import { classifyEdges } from '../infra/claude-llm.js';
import { isClaudeLlmAvailable } from '../infra/claude-llm.js';

/** Max pairs per LLM call to stay within 90s timeout */
const BATCH_SIZE = 10;

export interface SemanticEdgesOptions {
  /** Max edges to process (0 = all) */
  readonly limit: number;
}

export type SemanticEdgesResult =
  | { ok: true; classified: number; failed: number; skipped: number }
  | { ok: false; error: string };

/**
 * Build MemoryPair from edge source/target.
 * Pure function.
 */
function toMemoryPair(source: Memory, target: Memory): MemoryPair {
  return {
    source: {
      id: source.id,
      content: source.content,
      summary: source.summary,
      memory_type: source.memory_type,
    },
    target: {
      id: target.id,
      content: target.content,
      summary: target.summary,
      memory_type: target.memory_type,
    },
  };
}

/**
 * Batch an array into chunks.
 * Pure function.
 */
function batch<T>(arr: readonly T[], size: number): readonly T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/**
 * Run semantic edge classification on all relates_to edges.
 *
 * @param db - Project database
 * @returns Result with classification stats
 */
export async function executeSemanticEdges(
  db: Database,
  options: SemanticEdgesOptions = { limit: 0 }
): Promise<SemanticEdgesResult> {
  try {
    if (!isClaudeLlmAvailable()) {
      return { ok: false, error: 'Claude CLI not found on PATH' };
    }

    // Step 1: Get relates_to edges (optionally limited)
    const allRelatesToEdges = getRelatesToEdges(db);
    const relatesToEdges =
      options.limit > 0
        ? allRelatesToEdges.slice(0, options.limit)
        : allRelatesToEdges;

    if (relatesToEdges.length === 0) {
      logInfo('No relates_to edges to classify');
      return { ok: true, classified: 0, failed: 0, skipped: 0 };
    }

    logInfo(`Found ${relatesToEdges.length} relates_to edges to classify`);

    // Step 2: Load memory pairs, skip edges where either memory is missing
    const pairs: Array<{ edgeId: string; pair: MemoryPair }> = [];
    let skipped = 0;

    for (const edge of relatesToEdges) {
      const source = getMemoryById(db, edge.source_id);
      const target = getMemoryById(db, edge.target_id);

      if (!source || !target) {
        skipped++;
        continue;
      }

      pairs.push({
        edgeId: edge.id,
        pair: toMemoryPair(source, target),
      });
    }

    if (pairs.length === 0) {
      logInfo('No valid memory pairs found');
      return { ok: true, classified: 0, failed: 0, skipped };
    }

    // Step 3: Batch and classify
    let classified = 0;
    let failed = 0;
    const batches = batch(pairs, BATCH_SIZE);

    for (const batchPairs of batches) {
      try {
        const classifications = await classifyEdges(
          batchPairs.map((p) => p.pair)
        );

        // Build lookup: "sourceId:targetId" -> classification
        const classMap = new Map<string, EdgeClassification>();
        for (const c of classifications) {
          classMap.set(`${c.source_id}:${c.target_id}`, c);
        }

        // Step 4: Replace edges with typed versions
        for (const { edgeId, pair } of batchPairs) {
          const key = `${pair.source.id}:${pair.target.id}`;
          const classification = classMap.get(key);

          if (classification && classification.relation_type !== 'relates_to') {
            // Delete old generic edge, insert typed one
            try {
              deleteEdge(db, edgeId);
              insertEdge(db, {
                source_id: classification.source_id,
                target_id: classification.target_id,
                relation_type: classification.relation_type,
                strength: classification.strength,
                bidirectional: true,
                status: 'active',
              });
              classified++;
            } catch (err) {
              // Unique constraint or other DB error — non-fatal
              failed++;
            }
          }
          // If LLM returns relates_to or nothing, keep existing edge
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Batch classification failed: ${message}`);
        failed += batchPairs.length;
      }
    }

    logInfo(`Semantic edges: classified=${classified}, failed=${failed}, skipped=${skipped}`);
    return { ok: true, classified, failed, skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Semantic edges failed: ${message}` };
  }
}

function logInfo(message: string): void {
  process.stderr.write(`[cortex:semantic-edges] INFO: ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[cortex:semantic-edges] ERROR: ${message}\n`);
}
