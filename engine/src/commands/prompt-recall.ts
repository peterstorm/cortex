/**
 * Prompt-aware recall for UserPromptSubmit hook
 *
 * Extracts keywords from the user's prompt, runs FTS5 OR search across
 * both project and global DBs, deduplicates against the static surface.
 * If the keyword path returns nothing AND the prompt has enough unigrams AND
 * Gemini is configured, falls back to a single-shot semantic search with a
 * conservative cosine floor. Outputs compact markdown for context injection.
 *
 * Design: Pure functions (extractUnigrams, extractKeywords, formatPromptRecall)
 * + sync I/O boundary (executePromptRecall) + async I/O wrapper
 * (executePromptRecallWithFallback). Always succeeds — returns empty on errors.
 */

import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { searchByKeywordOr, searchByKeywordAnd, getMemoriesWithEmbedding } from '../infra/db.js';
import { embedTexts, isGeminiAvailable } from '../infra/gemini-embed.ts';
import { rankBySimilarity, STOP_WORDS, extractUnigrams } from '../core/similarity.js';
import { buildQueryEmbeddingText } from './recall.js';
import { sanitizeSurfaceText } from '../core/surface.js';

// ============================================================================
// CONSTANTS
// ============================================================================

// STOP_WORDS and extractUnigrams moved to core/similarity.ts so recall.ts can
// use them without a command→command import cycle. Re-exported for
// backwards-compatible imports.
export { STOP_WORDS, extractUnigrams };

/** Minimum meaningful tokens required to run search */
export const MIN_MEANINGFUL_TOKENS = 2;

/** Maximum results to return */
export const PROMPT_RECALL_LIMIT = 5;

/** Minimum unigram count required to attempt semantic fallback when keyword path is empty */
export const SEMANTIC_FALLBACK_MIN_UNIGRAMS = 4;

/** Cosine similarity floor for semantic fallback — keeps noisy 0.5-range hits out of auto-recall */
export const SEMANTIC_FALLBACK_COSINE_FLOOR = 0.65;

/** Max results from semantic fallback (intentionally smaller than keyword limit — fallback noise tolerance is lower) */
export const SEMANTIC_FALLBACK_LIMIT = 3;

/** Min unigrams required to attempt strict AND search before falling back to OR */
export const AND_FIRST_MIN_UNIGRAMS = 2;

/** Max unigrams sent to AND search — beyond this, AND is too restrictive to be useful */
export const AND_FIRST_MAX_UNIGRAMS = 6;

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

export function extractKeywords(prompt: string): readonly string[] {
  const unigrams = extractUnigrams(prompt);

  // Generate bigrams (adjacent token pairs) for multi-word terms
  const bigrams: string[] = [];
  for (let i = 0; i < unigrams.length - 1 && bigrams.length < 10; i++) {
    bigrams.push(`${unigrams[i]} ${unigrams[i + 1]}`);
  }

  return [...unigrams, ...bigrams];
}

/**
 * Returns true when none of the query tokens appear in the memory's content
 * or summary — i.e. the FTS5 hit was carried entirely by tag column matches.
 * Tag-only matches are usually low-precision (tags are short labels that
 * collide with common words), so the prompt-recall hook excludes them.
 *
 * @param memory - Candidate memory from FTS5 search
 * @param tokens - Lowercased query unigrams
 * @returns true if the match was tag-only (caller should drop the result)
 */
export function isTagOnlyMatch(memory: Memory, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const haystack = `${memory.content} ${memory.summary}`.toLowerCase();
  return !tokens.some(tok => haystack.includes(tok));
}

/**
 * Format prompt recall results as compact markdown
 * Returns empty string if no results or search was skipped
 *
 * @param memories - Recalled memories
 * @returns Markdown string with markers, or empty string
 */
export function formatPromptRecall(memories: readonly Memory[]): string {
  if (memories.length === 0) return '';

  const lines = memories.map(m => `- [${m.memory_type}] ${sanitizeSurfaceText(m.summary)}`);

  return [
    '<!-- CORTEX_RECALL_START -->',
    '## Prompt-Relevant Memories',
    '',
    ...lines,
    '<!-- CORTEX_RECALL_END -->',
  ].join('\n');
}

// ============================================================================
// I/O BOUNDARY
// ============================================================================

export type PromptRecallOptions = {
  readonly prompt: string;
  readonly surfaceContent: string;
  readonly limit?: number;
  /** Project name for the [query] [project:name] embedding prefix (FR-039) */
  readonly projectName?: string;
};

/**
 * Execute prompt-aware keyword recall across both databases
 * I/O: Reads from databases
 *
 * @param projectDb - Project-scoped database (or null if unavailable)
 * @param globalDb - Global database (or null if unavailable)
 * @param options - Prompt text, surface content for dedup, and optional limit
 * @returns Deduplicated array of relevant memories
 */
export function executePromptRecall(
  projectDb: Database | null,
  globalDb: Database | null,
  options: PromptRecallOptions,
): readonly Memory[] {
  const tokens = extractKeywords(options.prompt);

  if (tokens.length < MIN_MEANINGFUL_TOKENS) {
    return [];
  }

  const limit = options.limit ?? PROMPT_RECALL_LIMIT;
  const unigrams = extractUnigrams(options.prompt);

  // Tier 1: strict AND over unigrams, when we have enough but not too many.
  // Returns precise multi-token matches; misses are common, so OR still runs as fallback.
  const andEligible =
    unigrams.length >= AND_FIRST_MIN_UNIGRAMS &&
    unigrams.length <= AND_FIRST_MAX_UNIGRAMS;
  const projectAnd = andEligible && projectDb
    ? searchByKeywordAnd(projectDb, unigrams, limit)
    : [];
  const globalAnd = andEligible && globalDb
    ? searchByKeywordAnd(globalDb, unigrams, limit)
    : [];

  // Tier 2: broad OR over unigrams + bigrams (preserves prior behaviour).
  const projectOr = projectDb ? searchByKeywordOr(projectDb, tokens, limit) : [];
  const globalOr = globalDb ? searchByKeywordOr(globalDb, tokens, limit) : [];

  // Merge: AND results first (higher precision), then OR results, dedup by ID.
  // Filter tag-only matches (FTS5 hit only in tag column) — usually low precision.
  // Filter against the static surface so we don't repeat what's already in context.
  const seenIds = new Set<string>();
  const merged: Memory[] = [];

  for (const mem of [...projectAnd, ...globalAnd, ...projectOr, ...globalOr]) {
    if (seenIds.has(mem.id)) continue;
    seenIds.add(mem.id);

    if (isTagOnlyMatch(mem, unigrams)) continue;

    if (options.surfaceContent && options.surfaceContent.includes(mem.summary)) {
      continue;
    }

    merged.push(mem);
    if (merged.length >= limit) break;
  }

  return merged;
}

/**
 * Async wrapper: keyword recall first, semantic fallback when keyword returns empty.
 *
 * Triggered only when:
 *   1. Keyword path returned 0 results
 *   2. Prompt has >= SEMANTIC_FALLBACK_MIN_UNIGRAMS distinct unigrams
 *      (bigrams are excluded from the count — short metaphor prompts shouldn't qualify)
 *   3. Gemini API key is present
 *
 * Errors during embedding never propagate — fallback is best-effort.
 *
 * @param projectDb - Project-scoped database (or null if unavailable)
 * @param globalDb - Global database (or null if unavailable)
 * @param options - Prompt text, surface content for dedup, optional limit, gemini key
 * @returns Deduplicated array of relevant memories (keyword OR semantic fallback)
 */
export async function executePromptRecallWithFallback(
  projectDb: Database | null,
  globalDb: Database | null,
  options: PromptRecallOptions & { readonly geminiApiKey?: string },
): Promise<readonly Memory[]> {
  const keywordResults = executePromptRecall(projectDb, globalDb, options);

  if (keywordResults.length > 0) {
    return keywordResults;
  }

  // Fallback gates
  const unigrams = extractUnigrams(options.prompt);
  if (unigrams.length < SEMANTIC_FALLBACK_MIN_UNIGRAMS) {
    return keywordResults;
  }
  if (!isGeminiAvailable(options.geminiApiKey)) {
    return keywordResults;
  }

  try {
    // Same [query] [project:name] prefix as recall.ts — memories were
    // embedded with a metadata prefix, so an unprefixed query lands in a
    // slightly different embedding space and degrades ranking.
    const embeddings = await embedTexts(
      [buildQueryEmbeddingText(options.prompt, options.projectName)],
      options.geminiApiKey!,
    );
    const queryEmbedding = embeddings[0];
    if (!queryEmbedding) {
      return keywordResults;
    }

    const embType = queryEmbedding instanceof Float64Array ? 'gemini' : 'local';
    const projectCandidates = projectDb
      ? getMemoriesWithEmbedding(projectDb, embType)
      : [];
    const globalCandidates = globalDb
      ? getMemoriesWithEmbedding(globalDb, embType)
      : [];

    const ranked = rankBySimilarity(
      [...projectCandidates, ...globalCandidates],
      queryEmbedding,
      SEMANTIC_FALLBACK_LIMIT,
      SEMANTIC_FALLBACK_COSINE_FLOOR,
    );

    // Dedup against the static surface — same rule as keyword path
    const filtered: Memory[] = [];
    for (const { memory } of ranked) {
      if (options.surfaceContent && options.surfaceContent.includes(memory.summary)) {
        continue;
      }
      filtered.push(memory);
    }

    return filtered;
  } catch {
    // Best-effort: any embedding/network/DB error returns the (empty) keyword result
    return keywordResults;
  }
}
