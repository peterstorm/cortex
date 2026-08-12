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
  | { ok: true; classified: number; failed: number }
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
 * Run bounded-concurrency map over an array. Worker failures propagate to
 * the caller; workers must handle their own per-item errors.
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
 * Whether a typed relation is symmetric for traversal purposes. Directional
 * relations (supersedes, derived_from, source_of, refines, exemplifies)
 * keep their source→target direction; only the general connection and
 * contradicts are symmetric. Pure function.
 */
export function isBidirectionalRelation(relation: EdgeClassification['relation_type']): boolean {
  return relation === 'relates_to' || relation === 'contradicts';
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
          memory_type: source.memory_type as Memory['memory_type'],
        },
        target: {
          id: target.id,
          content: target.content,
          summary: target.summary,
          memory_type: target.memory_type as Memory['memory_type'],
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
    return { ok: true, classified: 0, failed: 0 };
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
      logInfo('All relates_to edges are already classified (or only content-unchanged declines remain)');
      return { ok: true, classified: 0, failed: 0 };
    }

    logInfo(`Found ${candidates.length} relates_to edges to classify`);

    // Step 2: Build batches of pairs (endpoint memories come from the JOIN,
    // so no per-edge lookups and no missing-memory skips are possible)
    const batches = batch(candidates, BATCH_SIZE);

    // Step 3: Batch and classify with bounded concurrency
    // Attempt timestamp: set on every edge in this batch once the model
    // answered, so declined edges are not re-asked on future runs. On a
    // thrown error or an unparseable response the edges stay unmarked and
    // are retried next run.
    let classified = 0;
    let failed = 0;

    await mapLimit(batches, CONCURRENCY, async (batchPairs) => {
      const attemptedAt = new Date().toISOString();

      let classifications: readonly EdgeClassification[];
      let byIndex: Map<number, EdgeClassification> | null = null;
      let byKey: Map<string, EdgeClassification>;
      try {
        const outcome = await classifyEdges(
          batchPairs.map((p) => p.pair)
        );
        if (outcome.kind === 'unparseable') {
          // Garbage is not a decline: leave the edges unmarked and count the
          // batch as failed so a later run retries them. The old behavior
          // ([] on parse failure) permanently retired every pair while
          // reporting ok:true failed:0.
          logError(`Classification response was not parseable (${outcome.reason}) — batch of ${batchPairs.length} left unmarked, will be retried`);
          failed += batchPairs.length;
          return;
        }
        classifications = outcome.classifications;

        // Join classifications to pairs. When the model echoed pair_index (the
        // deterministic protocol this prompt requests), the join is by ordinal
        // and never depends on free-text ID fidelity: a direction-flipped or
        // mangled ID cannot silently discard a valid classification. A
        // response that mixes indexed and unindexed entries, or carries an
        // out-of-range index, is corrupt — treat it as a batch failure
        // (edges unmarked, retried) rather than a decline.
        byIndex = new Map<number, EdgeClassification>();
        byKey = new Map<string, EdgeClassification>();
        for (const c of classifications) {
          if (c.pair_index !== undefined) {
            if (byIndex.has(c.pair_index)) {
              throw new Error(
                `classification response contains duplicate pair_index ${c.pair_index} — corrupt response, batch failed`
              );
            }
            byIndex.set(c.pair_index, c);
          } else {
            byKey.set(`${c.source_id}:${c.target_id}`, c);
          }
        }
        if (byIndex.size > 0) {
          if (byIndex.size !== classifications.length) {
            throw new Error(
              `classification response mixed indexed and unindexed entries (${byIndex.size} of ${classifications.length} indexed)`
            );
          }
          for (const index of byIndex.keys()) {
            if (index < 1 || index > batchPairs.length) {
              throw new Error(
                `classification pair_index ${index} is out of range for a ${batchPairs.length}-pair batch`
              );
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Classification batch failed: ${message}`);
        failed += batchPairs.length;
        return;
      }

      // Step 4: Replace edges with typed versions. Each edge's write is
      // guarded separately so a persistence error counts exactly one failure
      // and is never misattributed to the LLM batch.
      const joinByIndex = byIndex !== null && byIndex.size > 0;
      for (const [pairOrdinal, { edgeId, pair }] of batchPairs.entries()) {
        try {
          const key = `${pair.source.id}:${pair.target.id}`;
          const classification = joinByIndex
            ? byIndex!.get(pairOrdinal + 1)
            : byKey.get(key);
          // Content fingerprint at attempt time, stored for future runs
          const contentHash = pairContentHash(pair.source, pair.target);

          if (classification && classification.relation_type !== 'relates_to') {
            // Delete old generic edge + insert typed one atomically
            const replaceEdge = db.transaction(() => {
              deleteEdge(db, edgeId);
              insertEdge(db, {
                source_id: classification.source_id,
                target_id: classification.target_id,
                relation_type: classification.relation_type,
                strength: classification.strength,
                // Directional relation types keep direction; only the
                // general connection is symmetric.
                bidirectional: isBidirectionalRelation(classification.relation_type),
                status: 'active',
                classified_at: attemptedAt,
                classify_hash: contentHash,
              });
            });
            replaceEdge();
            classified++;
          } else {
            // LLM returned relates_to or nothing: keep the edge, but mark
            // it attempted so it is not re-classified on every run.
            markEdgeClassified(db, edgeId, attemptedAt, contentHash);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError(`Edge ${edgeId} write failed (not a classification failure): ${message}`);
          failed++;
          // A unique-constraint conflict means a typed edge for this
          // pair already exists (e.g. the similarity pre-filter re-created
          // a relates_to candidate after a content change). The
          // classification is effectively already done — retire the
          // candidate so it is not re-sent to the LLM on every run.
          if (/unique constraint/i.test(message)) {
            markEdgeClassified(db, edgeId, attemptedAt, pairContentHash(pair.source, pair.target));
          }
        }
      }
    });

    logInfo(`Semantic edges: classified=${classified}, failed=${failed}`);
    return { ok: true, classified, failed };
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
