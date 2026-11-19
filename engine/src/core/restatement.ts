/**
 * Restatements: two memories of one type whose current-model embeddings are so
 * close that they state the same fact.
 *
 * Pure. Both functions read `Memory.local_embedding`, which the read boundary
 * (infra/db.ts rowToMemory) only ever fills with a vector from the CURRENT
 * model; a memory without one is never compared, so it is always kept.
 */

import type { Memory } from './types.js';
import { cosineSimilarity } from './similarity.js';

/**
 * Cosine of two memories of the same type, or null when they cannot be
 * compared: different types, a missing vector, or vectors of different widths.
 */
function sameTypeCosine(a: Memory, b: Memory): number | null {
  if (a.memory_type !== b.memory_type) return null;
  if (a.local_embedding === null || b.local_embedding === null) return null;
  if (a.local_embedding.length !== b.local_embedding.length) return null;
  return cosineSimilarity(a.local_embedding, b.local_embedding);
}

/**
 * Keep the first of every group of items stating the same fact, in rank order.
 *
 * An item is dropped when an already-kept item has the same memory_type and a
 * cosine at or above `threshold`; the comparison is against kept items only,
 * so a dropped item never causes another drop. Items without a current-model
 * embedding are always kept. `threshold` null means the active model is not
 * calibrated for it, and every item is kept.
 *
 * Callers apply it BEFORE cutting a ranked list to its limit, so a slot a
 * restatement would have taken goes to the next distinct hit.
 */
export function distinctFacts<T>(
  ranked: readonly T[],
  memoryOf: (item: T) => Memory,
  threshold: number | null
): readonly T[] {
  if (threshold === null) return ranked;
  const kept: T[] = [];
  for (const item of ranked) {
    const memory = memoryOf(item);
    const restates = kept.some((other) => {
      const cosine = sameTypeCosine(memory, memoryOf(other));
      return cosine !== null && cosine >= threshold;
    });
    if (!restates) kept.push(item);
  }
  return kept;
}

/** One older memory that restates a newer one, and how close the two are. */
export type Restatement = Readonly<{
  /** The newer memory, which stays active. */
  kept: string;
  /** The older memory, which is superseded by `kept`. */
  superseded: string;
  /** Cosine of the two current-model embeddings, at or above the threshold. */
  similarity: number;
}>;

/** Newest first; equal timestamps by id, so the order never depends on input order. */
function newestFirst(a: Memory, b: Memory): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A vector scaled to length 1, so cosine is a plain dot product. */
function unit(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  const scale = norm === 0 ? 0 : 1 / Math.sqrt(norm);
  return vector.map((x) => x * scale);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

type Leader = Readonly<{ id: string; vector: Float32Array }>;

/**
 * Plan which memories of one database restate a newer one.
 *
 * Newest-anchored leader clustering: walking from the newest memory to the
 * oldest, a memory becomes a leader unless its cosine to an already-chosen
 * leader of the same type reaches `threshold`; then it restates the most
 * similar such leader. Only leaders absorb, so nothing chains: an old memory
 * close to a superseded one but not to its leader stays.
 *
 * Never superseded: pinned memories (pinning protects the memory itself, so a
 * pinned memory is a leader and may supersede an older unpinned copy), `code`
 * memories, and memories without a current-model embedding (neither leaders
 * nor superseded).
 *
 * @param memories - The active memories of ONE database.
 * @returns The plan, newest restatement first. Applying it and planning again
 *   over the remaining memories yields nothing.
 */
export function planRestatements(
  memories: readonly Memory[],
  threshold: number
): readonly Restatement[] {
  const comparable = memories
    .flatMap((memory) =>
      memory.memory_type !== 'code' && memory.local_embedding !== null
        ? [{ memory, embedding: memory.local_embedding }]
        : []
    )
    .sort((a, b) => newestFirst(a.memory, b.memory));

  const leadersByType = new Map<string, Leader[]>();
  const plan: Restatement[] = [];

  for (const { memory, embedding } of comparable) {
    const vector = unit(embedding);
    const leaders = leadersByType.get(memory.memory_type) ?? [];

    let best: Readonly<{ leader: Leader; similarity: number }> | null = null;
    if (!memory.pinned) {
      for (const leader of leaders) {
        if (leader.vector.length !== vector.length) continue;
        const similarity = dot(vector, leader.vector);
        if (similarity >= threshold && (best === null || similarity > best.similarity)) {
          best = { leader, similarity };
        }
      }
    }

    if (best === null) {
      leaders.push({ id: memory.id, vector });
      leadersByType.set(memory.memory_type, leaders);
    } else {
      plan.push({ kept: best.leader.id, superseded: memory.id, similarity: best.similarity });
    }
  }

  return plan;
}
