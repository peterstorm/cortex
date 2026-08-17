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
 * 2. Load source/target memories in a single JOIN (no per-edge lookups)
 * 3. Batch pairs and send to the LLM for classification (bounded concurrency)
 * 4. Replace generic edges with typed ones; after a successfully parsed model
 *    answer, mark answered/declined edges so they are not re-asked next run
 *
 * Designed to run as fire-and-forget step in extract-and-generate hook.
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { chunk } from '../core/chunk.js';
import type { MemoryPair, EdgeClassification, LlmPromptTransport } from '../infra/claude-llm.js';
import { classifyEdges, isClaudeLlmAvailable } from '../infra/claude-llm.js';
import {
  getRelatesToEdgesWithMemories,
  deleteEdge,
  insertEdge,
  markEdgeClassified,
  markEdgeFailed,
  type EdgeWithMemories,
} from '../infra/db.js';
import { resolveOpenAiCompatEndpoint } from '../infra/llm-client.js';
import { acquireLock, releaseLock } from '../infra/lock.js';
import { EDGE_FAILURE_BACKOFF_HOURS } from '../config.js';

/** Max pairs per LLM call. Direct calls with thinking disabled are cheap. */
const BATCH_SIZE = 10;

/** Max classification calls in flight at once. Must stay at or below the
 * process-wide LLM slot pool (CORTEX_LLM_MAX_CONCURRENCY, default 2) — the
 * pool is the true cap on shared-server occupancy; this worker pool only
 * shapes how many batches queue for it. */
const CONCURRENCY = 2;

export interface SemanticEdgesOptions {
  /** Max edges to process (0 = all) */
  readonly limit: number;
  /** Per-project lock directory. */
  readonly lockDir?: string;
  /**
   * LLM transport for the classification call. Defaults to the real direct
   * endpoint; tests pass a plain function fake so they exercise the actual
   * classifyEdges parsing/routing instead of mocking the whole module.
   */
  readonly transport?: LlmPromptTransport;
}

/**
 * A batch's classifications, joined back to the pairs that produced them
 * (pure). Either every entry matched a pair, or the response is corrupt and
 * the whole batch fails — a partial join is never a decline.
 */
export type ClassificationJoin =
  | { readonly ok: true; readonly byOrdinal: true; readonly byIndex: ReadonlyMap<number, EdgeClassification> }
  | { readonly ok: true; readonly byOrdinal: false; readonly byKey: ReadonlyMap<string, EdgeClassification> }
  | { readonly ok: false; readonly reason: string };

/** The composite key used when the model did not echo pair_index. */
function pairKey(sourceId: string, targetId: string): string {
  return `${sourceId}:${targetId}`;
}

/**
 * Join classifications back to the pairs they answer (pure).
 *
 * When the model echoed pair_index — the deterministic protocol this prompt
 * requests — the join is by ordinal and never depends on free-text ID
 * fidelity: a direction-flipped or mangled ID cannot silently discard a valid
 * classification. A response that mixes indexed and unindexed entries,
 * duplicates an index or key, references an unknown pair, or carries an
 * out-of-range index is corrupt, and the caller must treat that as a batch
 * failure (edges left unmarked and retried) rather than a decline.
 *
 * Extracted from the batch worker so the trickiest logic in this command has
 * a unit-test surface that needs neither a database nor an LLM transport.
 */
export function joinClassificationsToPairs(
  batchPairs: readonly { readonly pair: MemoryPair }[],
  classifications: readonly EdgeClassification[]
): ClassificationJoin {
  const byIndex = new Map<number, EdgeClassification>();
  const byKey = new Map<string, EdgeClassification>();
  const expectedKeys = new Set(batchPairs.map(({ pair }) => pairKey(pair.source.id, pair.target.id)));

  for (const c of classifications) {
    if (c.pair_index !== undefined) {
      if (byIndex.has(c.pair_index)) {
        return { ok: false, reason: `classification response contains duplicate pair_index ${c.pair_index} — corrupt response, batch failed` };
      }
      byIndex.set(c.pair_index, c);
    } else {
      const key = pairKey(c.source_id, c.target_id);
      if (!expectedKeys.has(key)) {
        return { ok: false, reason: `classification response referenced unknown unindexed pair ${key} — batch failed` };
      }
      if (byKey.has(key)) {
        return { ok: false, reason: `classification response contains duplicate unindexed pair ${key} — batch failed` };
      }
      byKey.set(key, c);
    }
  }

  if (byIndex.size === 0) return { ok: true, byOrdinal: false, byKey };

  if (byIndex.size !== classifications.length) {
    return { ok: false, reason: `classification response mixed indexed and unindexed entries (${byIndex.size} of ${classifications.length} indexed)` };
  }
  for (const index of byIndex.keys()) {
    if (index < 1 || index > batchPairs.length) {
      return { ok: false, reason: `classification pair_index ${index} is out of range for a ${batchPairs.length}-pair batch` };
    }
  }
  return { ok: true, byOrdinal: true, byIndex };
}

/**
 * Whether a write error is a unique-constraint conflict (pure).
 *
 * Prefers the SQLite result code, which is stable across versions and
 * locales; the message regex remains only as a fallback for drivers that
 * surface the constraint without a code.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
  }
  return /unique constraint/i.test(err instanceof Error ? err.message : String(err));
}

export type SemanticEdgesResult =
  | { ok: true; classified: number; failed: number }
  | { ok: false; error: string };

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
 * An edge qualifies when it has never been attempted, its endpoint content
 * changed since the last recorded attempt (classify_hash no longer matches),
 * or its last attempt FAILED and the backoff has since elapsed with the
 * content unchanged. A FAILED attempt carries a backoff while the content is
 * unchanged, so an unhealthy server is not re-hammered with the same failed
 * batch on every maintenance run — but it never retires the edge the way a
 * decline does: once the backoff elapses the attempt is re-asked (for
 * answered edges this covers a failed re-classification after a content
 * change), and a content change resets the backoff immediately (new
 * information is worth one more try).
 * Pure function.
 */
export function selectClassificationCandidates(
  rows: readonly EdgeWithMemories[],
  limit: number,
  now: Date,
  backoffMs: number = EDGE_FAILURE_BACKOFF_HOURS * 60 * 60 * 1000
): readonly { edgeId: string; pair: MemoryPair }[] {
  const candidates: Array<{ edgeId: string; pair: MemoryPair }> = [];

  for (const { edge, source, target } of rows) {
    if (candidates.length >= limit && limit > 0) break;
    const hash = pairContentHash(source, target);
    if (hash === edge.classify_hash) {
      // Content unchanged since the edge's last recorded attempt. No failure
      // on record means the edge was ANSWERED at this content — skip it.
      if (edge.last_failed_at === null) continue;
      // A failed attempt at this content (a success would have cleared
      // last_failed_at) must not retire the edge the way a decline does:
      // honor the backoff, then re-ask.
      const lastFailedMs = Date.parse(edge.last_failed_at);
      if (!Number.isNaN(lastFailedMs) && now.getTime() - lastFailedMs < backoffMs) continue;
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
    // select candidates (never-attempted or content-changed since attempt;
    // failed attempts inside the backoff window are skipped)
    const allRows = getRelatesToEdgesWithMemories(db);
    const candidates = selectClassificationCandidates(allRows, options.limit, new Date());

    if (candidates.length === 0) {
      logInfo('All relates_to edges are already classified (or only content-unchanged declines remain)');
      return { ok: true, classified: 0, failed: 0 };
    }

    logInfo(`Found ${candidates.length} relates_to edges to classify`);

    // Step 2: Build batches of pairs (endpoint memories come from the JOIN,
    // so no per-edge lookups and no missing-memory skips are possible)
    const batches = chunk(candidates, BATCH_SIZE);

    // Step 3: Batch and classify with bounded concurrency
    // Attempt timestamp: set on every edge in this batch once the model
    // answered, so declined edges are not re-asked on future runs. On a
    // thrown error or an unparseable response the edges stay UNCLASSIFIED
    // (a failure is never a decline) but record last_failed_at so the
    // backoff delays the retry instead of re-hammering an unhealthy server.
    let classified = 0;
    let failed = 0;

    await mapLimit(batches, CONCURRENCY, async (batchPairs) => {
      const attemptedAt = new Date().toISOString();

      // One place records a failed batch: stamp last_failed_at on every edge
      // (backoff, never a decline) and count the batch in `failed`. Both the
      // unparseable and the thrown-error paths go through here so the two
      // retry-safety paths cannot diverge.
      const recordBatchFailure = (batch: readonly { edgeId: string; pair: MemoryPair }[]): void => {
        for (const { edgeId, pair } of batch) {
          recordAttempt(edgeId, 'failure stamp (backoff not applied)', () =>
            markEdgeFailed(db, edgeId, attemptedAt, pairContentHash(pair.source, pair.target))
          );
        }
        failed += batch.length;
      };

      let join: ClassificationJoin;
      try {
        const outcome = await classifyEdges(
          batchPairs.map((p) => p.pair),
          options.transport
        );
        if (outcome.kind === 'unparseable') {
          // Garbage is not a decline: count the batch as failed and retry it
          // later — but record the failure on each edge (timestamp + content
          // hash) so candidate selection applies the failure backoff instead
          // of re-asking the same batch on every maintenance run.
          logError(`Classification response was not parseable (${outcome.reason}) — batch of ${batchPairs.length} left unmarked, will be retried after backoff`);
          recordBatchFailure(batchPairs);
          return;
        }
        // A corrupt join is a batch failure, not a decline: the edges stay
        // unmarked and are retried after the backoff.
        join = joinClassificationsToPairs(batchPairs, outcome.classifications);
        if (!join.ok) {
          logError(`Classification batch failed: ${join.reason}`);
          recordBatchFailure(batchPairs);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Classification batch failed: ${message}`);
        recordBatchFailure(batchPairs);
        return;
      }

      // Step 4: Replace edges with typed versions. Each edge's write is
      // guarded separately so a persistence error counts exactly one failure
      // and is never misattributed to the LLM batch.
      const joinByIndex = join.byOrdinal;
      for (const [pairOrdinal, { edgeId, pair }] of batchPairs.entries()) {
        // Content fingerprint at attempt time, stored for future runs. Computed
        // once per pair, outside the guard: both the success path and the
        // unique-constraint path in the catch stamp the same fingerprint, and
        // hashing it twice invites the two copies to drift apart.
        const contentHash = pairContentHash(pair.source, pair.target);
        try {
          const classification = join.byOrdinal
            ? join.byIndex.get(pairOrdinal + 1)
            : join.byKey.get(pairKey(pair.source.id, pair.target.id));

          if (classification && classification.relation_type !== 'relates_to') {
            // Delete old generic edge + insert typed one atomically
            const replaceEdge = db.transaction(() => {
              deleteEdge(db, edgeId);
              insertEdge(db, {
                // pair_index binds this answer to trusted input endpoints. The
                // model-echoed IDs are diagnostic only and may be reversed or
                // mangled; never let them redefine a directional edge.
                source_id: joinByIndex ? pair.source.id : classification.source_id,
                target_id: joinByIndex ? pair.target.id : classification.target_id,
                relation_type: classification.relation_type,
                strength: classification.strength,
                // Directional relation types keep direction; relates_to and
                // contradicts are symmetric.
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
          if (isUniqueConstraintError(err)) {
            recordAttempt(edgeId, 'unique-constraint recovery stamp', () =>
              markEdgeClassified(db, edgeId, attemptedAt, contentHash)
            );
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

/**
 * Record one edge's attempt outcome without letting the write escape.
 *
 * Every call site is inside a `mapLimit` worker, where an escaping error
 * rejects `Promise.all` and discards the classified/failed tallies of every
 * other batch that already finished — while the abandoned runner keeps writing
 * against a database the caller's `finally` is about to close. Losing one
 * edge's stamp costs a premature re-ask on the next run; losing the run's
 * counts costs the run.
 *
 * Both stamping paths share this because they are the same decision made
 * twice: `recordBatchFailure`'s backoff stamp and the unique-constraint
 * recovery stamp are mirror images, and the recovery one was reachable
 * unguarded for exactly as long as the two were written separately.
 *
 * @param edgeId - Edge the stamp belongs to, for the diagnostic.
 * @param what - What was being recorded, for the diagnostic.
 * @param write - The stamping write; its failure is reported, never rethrown.
 */
function recordAttempt(edgeId: string, what: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Edge ${edgeId} ${what} could not be recorded: ${message}`);
  }
}

function logInfo(message: string): void {
  process.stderr.write(`[cortex:semantic-edges] INFO: ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[cortex:semantic-edges] ERROR: ${message}\n`);
}
