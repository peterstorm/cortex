/**
 * Core similarity functions for memory comparison
 * Pure functional implementations with no I/O
 */

import type { SimilarityAction, SimilaritySpace, Memory } from './types.js';
import { KEYWORD_OVERLAP_WEIGHT } from '../config.js';

/**
 * Discriminated union for Jaccard pre-filter results
 */
export type JaccardPreFilter =
  | { result: 'definitely_similar'; score: number }
  | { result: 'definitely_different'; score: number }
  | { result: 'maybe'; score: number };

/**
 * Compute cosine similarity between two embedding vectors
 * Returns value in range [-1, 1] where 1 = identical, 0 = orthogonal, -1 = opposite
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Cosine similarity score
 */
export function cosineSimilarity(a: Float64Array | Float32Array, b: Float64Array | Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) {
    throw new Error('Cannot compute similarity for empty vectors');
  }

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);

  // Handle zero vectors
  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Tokenize text into a set of normalized tokens
 * Lowercases, removes punctuation, splits on whitespace
 *
 * @param text - Input text to tokenize
 * @returns Set of normalized tokens
 */
export function tokenize(text: string): ReadonlySet<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ') // Replace punctuation with spaces (unicode-aware)
    .replace(/\s+/g, ' ')      // Collapse multiple spaces
    .trim();

  if (normalized === '') {
    return new Set();
  }

  return new Set(normalized.split(' '));
}

/**
 * Common English stop words + filler words to filter from natural-language
 * queries and prompts. Shared by recall (tiered keyword search) and
 * prompt-recall (keyword extraction). Pure data.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // Articles & determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  // Pronouns
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'its', 'they', 'them', 'their',
  // Prepositions
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'over',
  // Conjunctions
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  // Common verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  // Filler / instruction words
  'please', 'help', 'want', 'need', 'like', 'just', 'also', 'very', 'really', 'actually', 'basically',
  'tell', 'show', 'explain', 'describe', 'give', 'make', 'let', 'get', 'know', 'think', 'see', 'look', 'find', 'use',
  // Question words
  'how', 'what', 'where', 'when', 'why', 'which', 'who', 'whom',
  // Other common words
  'not', 'no', 'yes', 'all', 'each', 'every', 'any', 'some', 'more', 'most', 'other', 'than',
  'if', 'then', 'else', 'only', 'own', 'same', 'such', 'too', 'here', 'there', 'now',
]);

/**
 * Extract meaningful keywords from a natural-language prompt or query.
 * Pure function: lowercase, strip punctuation (keeping hyphens/dots for
 * compound words and versions), tokenize, filter stop words, deduplicate.
 *
 * @param prompt - Raw prompt/query text
 * @returns Array of meaningful keyword tokens
 */
export function extractUnigrams(prompt: string): readonly string[] {
  return prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s.\-]/gu, ' ')  // Strip punctuation, unicode-aware (keep hyphens and dots for compound words / versions)
    .split(/\s+/)
    .filter(t => t.length > 1)  // Drop single chars
    .filter(t => !STOP_WORDS.has(t))
    .filter((t, i, arr) => arr.indexOf(t) === i);  // Deduplicate
}

/**
 * Compute Jaccard similarity between two token sets
 * Returns value in range [0, 1] where 1 = identical sets, 0 = no overlap
 *
 * @param tokensA - First token set
 * @param tokensB - Second token set
 * @returns Jaccard similarity score
 */
export function jaccardSimilarity(tokensA: ReadonlySet<string>, tokensB: ReadonlySet<string>): number {
  if (tokensA.size === 0 && tokensB.size === 0) {
    return 1.0; // Both empty = identical
  }
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0.0; // One empty = no overlap
  }

  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);

  return intersection.size / union.size;
}

/**
 * Classify similarity score into actionable categories.
 *
 * Bands are calibrated PER SIMILARITY SPACE — a raw local-BGE cosine of 0.65
 * means "same project domain, different aspect", while a Jaccard of 0.65
 * means "near-identical text". Applying the Jaccard bands to local cosine
 * produced O(n²) relates_to edges (nearly every same-project pair landed in
 * consolidate/suggest).
 *
 * Jaccard / Gemini-cosine bands (FR-059, well-separated spaces):
 * - < 0.1: ignore (unrelated)
 * - 0.1-0.4: relate (create relates_to edge)
 * - 0.4-0.5: suggest (create suggested edge for review)
 * - > 0.5: consolidate (flag for merge)
 *
 * Local-cosine bands (384-dim BGE, runs hot — consistent with the 0.75
 * dedup threshold and 0.85 merge ceiling in config.ts):
 * - < 0.6: ignore (same-domain background similarity)
 * - 0.6-0.75: relate
 * - 0.75-0.82: suggest
 * - >= 0.82: consolidate
 *
 * @param score - Similarity score in range [0, 1]
 * @param space - Similarity space the score was computed in (default 'jaccard')
 * @returns Similarity action with action type and strength (where applicable)
 */
export function classifySimilarity(
  score: number,
  space: SimilaritySpace = 'jaccard'
): SimilarityAction {
  if (space === 'local-cosine') {
    if (score < 0.6) {
      return { action: 'ignore' };
    }
    if (score < 0.75) {
      return { action: 'relate', strength: score };
    }
    if (score < 0.82) {
      return { action: 'suggest', strength: score };
    }
    return { action: 'consolidate' };
  }

  // 'jaccard' and 'gemini-cosine': well-separated spaces share the FR-059 bands
  if (score < 0.1) {
    return { action: 'ignore' };
  }
  if (score < 0.4) {
    return { action: 'relate', strength: score };
  }
  if (score <= 0.5) {
    return { action: 'suggest', strength: score };
  }
  return { action: 'consolidate' };
}

/**
 * Jaccard pre-filter to avoid expensive embedding similarity computation
 * Based on FR-060:
 * - > 0.6: definitely_similar (skip embedding check)
 * - < 0.1: definitely_different (skip embedding check)
 * - 0.1-0.6: maybe (proceed with embedding similarity)
 *
 * @param score - Pre-computed Jaccard similarity score
 * @returns Pre-filter result with classification and score
 */
export function jaccardPreFilter(score: number): JaccardPreFilter {
  if (score > 0.6) {
    return { result: 'definitely_similar', score };
  }
  if (score < 0.1) {
    return { result: 'definitely_different', score };
  }
  return { result: 'maybe', score };
}

/**
 * Result of a hybrid similarity computation, tagged with the method that
 * actually produced the score. Callers that know WHICH embedding space fed
 * the cosine (local 384-dim vs Gemini 768-dim) combine `method` with that
 * knowledge to pick calibrated thresholds/bands.
 */
export type HybridSimilarityResult = {
  readonly score: number;
  readonly method: 'cosine' | 'jaccard';
};

/**
 * Compute hybrid similarity preferring cosine (semantic) over Jaccard (lexical),
 * reporting which method produced the score.
 * Pure function — takes pre-computed tokens and optional embeddings.
 *
 * Algorithm:
 * 1. If both embeddings available + dimensions match → use cosine (catches semantic dupes)
 * 2. Otherwise fall back to Jaccard pre-filter:
 *    a. definitely_different (<0.1): return 0
 *    b. definitely_similar (>0.6): return Jaccard score
 *    c. maybe (0.1-0.6): return Jaccard score
 *
 * @param tokensA - Pre-tokenized first item
 * @param tokensB - Pre-tokenized second item
 * @param embeddingA - Optional embedding (Float32 or Float64)
 * @param embeddingB - Optional embedding (Float32 or Float64)
 * @returns Score in [0, 1] (0 if definitely_different) + the method used
 */
export function hybridSimilarityScored(
  tokensA: ReadonlySet<string>,
  tokensB: ReadonlySet<string>,
  embeddingA: Float64Array | Float32Array | null,
  embeddingB: Float64Array | Float32Array | null
): HybridSimilarityResult {
  // Prefer cosine when embeddings are available — catches semantic duplicates
  // that use different vocabulary but mean the same thing
  if (embeddingA && embeddingB) {
    if (embeddingA.length === embeddingB.length) {
      return { score: cosineSimilarity(embeddingA, embeddingB), method: 'cosine' };
    }
    process.stderr.write(
      `[cortex:similarity] WARN: embedding dimension mismatch (${embeddingA.length} vs ${embeddingB.length}), falling back to Jaccard\n`
    );
  }

  // Fallback: Jaccard with pre-filter when embeddings unavailable
  const jaccardScore = jaccardSimilarity(tokensA, tokensB);
  const preFilter = jaccardPreFilter(jaccardScore);

  if (preFilter.result === 'definitely_different') {
    return { score: 0, method: 'jaccard' };
  }

  return { score: jaccardScore, method: 'jaccard' };
}

/**
 * Compute hybrid similarity preferring cosine (semantic) over Jaccard (lexical).
 * Thin wrapper over hybridSimilarityScored for callers that don't need the
 * method (see that function for the algorithm).
 */
export function hybridSimilarity(
  tokensA: ReadonlySet<string>,
  tokensB: ReadonlySet<string>,
  embeddingA: Float64Array | Float32Array | null,
  embeddingB: Float64Array | Float32Array | null
): number {
  return hybridSimilarityScored(tokensA, tokensB, embeddingA, embeddingB).score;
}

/**
 * Batch similarity comparison result
 */
export type SimilarityResult = {
  targetIndex: number;
  score: number;
  action: SimilarityAction;
};

/**
 * Compare a single embedding against multiple target embeddings
 * Returns sorted results by similarity score (descending)
 *
 * @param query - Query embedding vector
 * @param targets - Array of target embedding vectors
 * @returns Array of similarity results sorted by score (highest first)
 */
export function batchCosineSimilarity(
  query: Float64Array | Float32Array,
  targets: (Float64Array | Float32Array)[]
): SimilarityResult[] {
  return targets
    .map((target, index) => {
      const score = cosineSimilarity(query, target);
      const action = classifySimilarity(score);
      return { targetIndex: index, score, action };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Rank memory candidates by cosine similarity to a query embedding.
 * Pure function — takes pre-fetched candidates and returns sorted results.
 *
 * @param candidates - Memories with their embeddings (from I/O layer)
 * @param queryEmbedding - Query embedding vector
 * @param limit - Maximum results to return
 * @returns Sorted array of {memory, score} by similarity descending
 */
export function rankBySimilarity(
  candidates: readonly { memory: Memory; embedding: Float64Array | Float32Array }[],
  queryEmbedding: Float64Array | Float32Array,
  limit: number,
  minScore: number = 0
): readonly { memory: Memory; score: number }[] {
  const matching = filterMatchingDimensions(candidates, queryEmbedding);
  return matching
    .map(({ memory, embedding }) => ({ memory, score: cosineSimilarity(queryEmbedding, embedding) }))
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Filter out candidates whose embedding dimension does not match the query.
 * Emits a single stderr warning with the count skipped (not one per row) so
 * legacy/corrupt rows degrade recall gracefully instead of killing it.
 */
function filterMatchingDimensions(
  candidates: readonly { memory: Memory; embedding: Float64Array | Float32Array }[],
  queryEmbedding: Float64Array | Float32Array
): readonly { memory: Memory; embedding: Float64Array | Float32Array }[] {
  const matching = candidates.filter(
    ({ embedding }) => embedding.length === queryEmbedding.length
  );
  const skipped = candidates.length - matching.length;
  if (skipped > 0) {
    process.stderr.write(
      `[cortex:similarity] WARN: skipped ${skipped} candidate(s) with embedding dimension != ${queryEmbedding.length}\n`
    );
  }
  return matching;
}

/**
 * Fraction of query tokens that appear in the memory's tokens.
 * 1.0 when every query token is covered, 0 when none are (or query is empty).
 *
 * This is deliberately NOT Jaccard: a fully-matching 1-2 token proper-noun
 * query against a ~30-token summary has Jaccard ≈ 0.03 (intersection/union),
 * which made the keyword boost a near no-op. Coverage normalizes by query
 * size only, so an exact proper-noun hit gets the full boost.
 *
 * @param queryTokens - Tokenized query
 * @param memoryTokens - Tokenized memory text
 * @returns Coverage ratio in [0, 1]
 */
export function queryCoverage(
  queryTokens: ReadonlySet<string>,
  memoryTokens: ReadonlySet<string>
): number {
  if (queryTokens.size === 0) return 0;
  let covered = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) covered++;
  }
  return covered / queryTokens.size;
}

/**
 * Rank memory candidates by fused cosine + keyword coverage score.
 * Pure function — takes pre-fetched candidates and returns sorted results.
 *
 * Formula: fused_score = min(1, cosine_score * (1 + keywordWeight * coverage))
 * where coverage is |queryTokens ∩ memoryTokens| / |queryTokens|.
 *
 * The keyword boost helps proper noun queries ("NixOS", "BullMQ") rank
 * exact lexical matches above semantically similar but different-vocabulary results.
 *
 * @param candidates - Memories with their embeddings (from I/O layer)
 * @param queryEmbedding - Query embedding vector
 * @param queryTokens - Pre-tokenized query for keyword overlap
 * @param limit - Maximum results to return
 * @param minScore - Minimum raw cosine score before fusion (default 0)
 * @param keywordWeight - Weight for keyword overlap boost (default KEYWORD_OVERLAP_WEIGHT)
 * @returns Sorted array of {memory, score} by fused score descending
 */
export function rankByFusedSimilarity(
  candidates: readonly { memory: Memory; embedding: Float64Array | Float32Array }[],
  queryEmbedding: Float64Array | Float32Array,
  queryTokens: ReadonlySet<string>,
  limit: number,
  minScore: number = 0,
  keywordWeight: number = KEYWORD_OVERLAP_WEIGHT
): readonly { memory: Memory; score: number }[] {
  const matching = filterMatchingDimensions(candidates, queryEmbedding);
  return matching
    .map(({ memory, embedding }) => {
      const cosineScore = cosineSimilarity(queryEmbedding, embedding);
      if (cosineScore < minScore) return null;

      const memoryTokens = tokenize(`${memory.summary} ${memory.tags.join(' ')}`);
      const coverage = queryCoverage(queryTokens, memoryTokens);
      const fusedScore = Math.min(1, cosineScore * (1 + keywordWeight * coverage));

      return { memory, score: fusedScore };
    })
    .filter((r): r is { memory: Memory; score: number } => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
