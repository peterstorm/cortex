/**
 * Semantic edge classification command
 *
 * Upgrades generic 'relates_to' edges (created by the similarity pre-filter)
 * with typed relationships. Calls the LLM directly via the OpenAI-compatible
 * endpoint when configured (thinking disabled — ~30x faster), else the
 * `claude -p`/`pi -p` subprocess path.
 *
 * FR-056: Typed edges between memories
 *
 * Flow:
 * 1. Find 'relates_to' edges that have not been classified yet (attempt
 *    tracking via edges.classified_at; content-changed edges re-qualify)
 * 2. Load source/target memories for each
 * 3. Batch pairs and send to the LLM for classification (bounded concurrency)
 * 4. Replace generic edges with typed ones; mark every attempted edge so
 *    declined classifications are not re-asked on the next maintenance run
 *
 * Designed to run as fire-and-forget step in extract-and-generate hook.
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import type { MemoryPair, EdgeClassification } from '../infra/claude-llm.js';
import { classifyEdges, isClaudeLlmAvailable } from '../infra/claude-llm.js';
import {
  getRelatesToEdgesWithMemories,
  deleteEdge,
  insertEdge,
  markEdgeClassified,
} from '../infra/db.js';
import { resolveOpenAiCompatEndpoint } from '../infra/llm-client.js';
import { acquireLock, releaseLock } from '../infra/lock.js';

/** Max pairs per LLM call. Direct calls with thinking disabled are cheap. */
const BATCH_SIZE = 10;

/** Max classification calls in flight at once (vLLM max-num-seqs is typically 8+). */
const CONCURRENCY = 3;

export interface SemanticEdgesOptions {
  /** Max edges to process (0 = all) */
  readonly limit: number;
  /** Per-project lock directory. */
  readonly lockDir?: string;
}

export type SemanticEdgesResult =
  | { ok: true; classified: number; failed: number; skipped: number }
  | { ok: false; error: string };

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
 * Run bounded-concurrency map over an array. Pure function.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Content hash of an edge's endpoint memories. Attempt tracking stores this
 * on the edge; when the current hash differs from classify_hash the pair
 * changed since the last attempt and is re-qualified for classification.
 * Pure function.
 */
export function pairContentHash(
  source: Pick<Memory, 'content' | 'summary'>,
  target: Pick<Memory, 'content' | 'summary'>
): string {
  return createHash('sha256')
    .update(`${source.content}\n${source.summary}\n${target.content}\n${target.summary}`)
    .digest('hex');
}

/**
 * Build the classification candidate pairs.
 *
 * An edge qualifies when it has never been attempted (classified_at IS NULL)
 * or its endpoint content changed since the last attempt (classify_hash no
 * longer matches). Pure function.
 */
export function selectClassificationCandidates(
  rows: readonly ReturnType<typeof getRelatesToEdgesWithMemories>[number][],
  limit: number
): readonly { edgeId: string; pair: MemoryPair }[] {
  const candidates: Array<{ edgeId: string; pair: MemoryPair }> = [];

  for (const { edge, source, target } of rows) {
    if (candidates.length >= limit && limit > 0) break;
    if (edge.classified_at !== null) {
      const hash = pairContentHash(source, target);
      if (hash === edge.classify_hash) continue;
    }
    candidates.push({
      edgeId: edge.id,
      pair: {
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
      },
    });
  }

  return candidates;
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
  const lockFile = join(options.lockDir ?? '/tmp/cortex-locks', 'semantic-edges.lock');
  const lock = acquireLock(lockFile);
  if (!lock.acquired) {
    logInfo(`Semantic edges skipped: lock ${lock.reason}`);
    return { ok: true, classified: 0, failed: 0, skipped: 0 };
  }

  try {
    const directAvailable = resolveOpenAiCompatEndpoint() !== null;
    if (!directAvailable && !isClaudeLlmAvailable()) {
      return {
        ok: false,
        error:
          'No LLM available: no OpenAI-compatible endpoint configured and no LLM CLI on PATH',
      };
    }

    // Step 1: Load relates_to edges joined with endpoint memories, then
    // select candidates (never-attempted or content-changed since attempt)
    const allRows = getRelatesToEdgesWithMemories(db);
    const candidates = selectClassificationCandidates(allRows, options.limit);

    if (candidates.length === 0) {
      const unattempted = allRows.filter((r) => r.edge.classified_at === null).length;
      logInfo(
        unattempted === 0
          ? 'All relates_to edges are already classified'
          : `All ${unattempted} unclassified relates_to edges have a missing endpoint memory`
      );
      return { ok: true, classified: 0, failed: 0, skipped: 0 };
    }

    logInfo(`Found ${candidates.length} relates_to edges to classify`);

    // Step 2: Build batches of pairs (endpoint memories come from the JOIN,
    // so no per-edge lookups and no missing-memory skips are possible)
    const batches = batch(candidates, BATCH_SIZE);

    // Step 3: Batch and classify with bounded concurrency
    let classified = 0;
    let failed = 0;
    const skipped = 0;

    await mapLimit(batches, CONCURRENCY, async (batchPairs) => {
      // Attempt timestamp: set on every edge in this batch once the model
      // answered, so declined edges are not re-asked on future runs. On a
      // thrown error the edges stay unmarked and are retried next run.
      const attemptedAt = new Date().toISOString();

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
          // Content fingerprint at attempt time, stored for future runs
          const contentHash = pairContentHash(pair.source, pair.target);

          if (classification && classification.relation_type !== 'relates_to') {
            // Delete old generic edge + insert typed one atomically
            try {
              const replaceEdge = db.transaction(() => {
                deleteEdge(db, edgeId);
                insertEdge(db, {
                  source_id: classification.source_id,
                  target_id: classification.target_id,
                  relation_type: classification.relation_type,
                  strength: classification.strength,
                  bidirectional: true,
                  status: 'active',
                  classified_at: attemptedAt,
                  classify_hash: contentHash,
                });
              });
              replaceEdge();
              classified++;
            } catch (err) {
              // Unique constraint or other DB error — non-fatal
              failed++;
            }
          } else {
            // LLM returned relates_to or nothing: keep the edge, but mark
            // it attempted so it is not re-classified on every run.
            markEdgeClassified(db, edgeId, attemptedAt, contentHash);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Batch classification failed: ${message}`);
        failed += batchPairs.length;
      }
    });

    logInfo(`Semantic edges: classified=${classified}, failed=${failed}, skipped=${skipped}`);
    return { ok: true, classified, failed, skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Semantic edges failed: ${message}` };
  } finally {
    releaseLock(lockFile);
  }
}

function logInfo(message: string): void {
  process.stderr.write(`[cortex:semantic-edges] INFO: ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[cortex:semantic-edges] ERROR: ${message}\n`);
}
