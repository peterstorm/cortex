/**
 * Cosine calibration: which absolute cosine thresholds a local embedding model
 * has been measured to support, one field per use.
 *
 * A cosine threshold is a property of a MODEL's similarity distribution, not of
 * "local embeddings" in general. A model can be calibrated for one use (say,
 * deciding that a new memory duplicates an existing one) without being
 * calibrated for another (say, the relates_to edge bands), so every use reads
 * its own field and a missing field fails closed to that use's Jaccard path.
 * The measured records, with the data behind them, live in config.ts.
 *
 * Pure: types, and decisions over plain numbers.
 */

import { hybridSimilarityScored } from './similarity.js';

/**
 * What a new memory's best score against one existing memory means.
 *
 * - `skip-only`: at or above `skipFrom` the new memory says nothing the
 *   existing one does not, so it is not stored. There is no merge band: below
 *   `skipFrom` the new memory is kept on its own. A model whose cosine cannot
 *   tell "same fact, extra detail" from "a different rule on the same subject"
 *   gets this shape, because appending one rule to another is worse than
 *   keeping both.
 * - `merge-then-skip`: from `mergeFrom` up to `skipFrom` the new content is
 *   appended to the existing memory; at or above `skipFrom` it is skipped.
 *   Invariant: mergeFrom < skipFrom.
 */
export type DuplicateBands =
  | Readonly<{ kind: 'skip-only'; skipFrom: number }>
  | Readonly<{ kind: 'merge-then-skip'; mergeFrom: number; skipFrom: number }>;

/** The duplicate thresholds of one similarity space. */
export type DedupThresholds = Readonly<{
  /** A new memory against an existing one (extraction and remember). */
  existing: DuplicateBands;
  /** A candidate against an already-kept candidate of the same extraction batch: skipped at or above. */
  intraBatch: number;
}>;

/**
 * relates_to edge bands in a cosine space: below `relateFrom` ignore, then
 * relate, suggest from `suggestFrom`, consolidate from `consolidateFrom`.
 */
export type CosineEdgeBands = Readonly<{
  relateFrom: number;
  suggestFrom: number;
  consolidateFrom: number;
}>;

/**
 * Everything one local model's cosine was measured to support. A model with no
 * record is uncalibrated: every comparison falls back to Jaccard and the uses
 * that need cosine (dedupe, distinct recall) are off.
 */
export type CosineCalibration = Readonly<{
  /** Extraction dedup and remember's duplicate check. */
  dedup: DedupThresholds;
  /** consolidate: pairs at or above are listed for human review. */
  consolidationCandidate: number;
  /** relates_to edge bands; null = edges are classified on Jaccard. */
  edgeBands: CosineEdgeBands | null;
  /** dedupe: an older memory at or above this cosine to a newer one restates it; null = dedupe is off. */
  restatement: number | null;
  /** recall: a hit at or above this cosine to a better-ranked one is the same fact; null = every hit is shown. */
  distinctRecall: number | null;
}>;

/**
 * Duplicate thresholds per similarity space. `cosine` is null when the active
 * model is not calibrated for dedup: then embeddings are never compared, even
 * when both sides carry one.
 */
export type DedupPolicy = Readonly<{
  jaccard: DedupThresholds;
  cosine: DedupThresholds | null;
}>;

/** What happens to a new memory given its score against one existing memory. */
export type DedupVerdict = 'keep' | 'merge' | 'skip';

/** Classify one score under one space's bands. */
export function dedupVerdict(score: number, bands: DuplicateBands): DedupVerdict {
  if (score >= bands.skipFrom) return 'skip';
  if (bands.kind === 'merge-then-skip' && score >= bands.mergeFrom) return 'merge';
  return 'keep';
}

/** The lowest score at which a new memory is not stored as a memory of its own. */
export function duplicateFloor(bands: DuplicateBands): number {
  return bands.kind === 'merge-then-skip' ? bands.mergeFrom : bands.skipFrom;
}

/**
 * Score two items for dedup and name the thresholds that score must be read
 * against. Cosine is used only when the policy is calibrated for it and both
 * sides carry a vector of the same width; otherwise the score is Jaccard and
 * so are the thresholds. Scores from the two spaces are never compared to one
 * another's thresholds.
 */
export function compareForDedup(
  tokensA: ReadonlySet<string>,
  tokensB: ReadonlySet<string>,
  embeddingA: Float32Array | null,
  embeddingB: Float32Array | null,
  policy: DedupPolicy
): Readonly<{ score: number; thresholds: DedupThresholds }> {
  const cosine = policy.cosine;
  if (cosine === null) {
    return { score: hybridSimilarityScored(tokensA, tokensB, null, null).score, thresholds: policy.jaccard };
  }
  const { score, method } = hybridSimilarityScored(tokensA, tokensB, embeddingA, embeddingB);
  return { score, thresholds: method === 'cosine' ? cosine : policy.jaccard };
}
