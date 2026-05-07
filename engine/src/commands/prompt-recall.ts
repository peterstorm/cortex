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
import { searchByKeywordOr, getMemoriesWithEmbedding } from '../infra/db.js';
import { embedTexts, isGeminiAvailable } from '../infra/gemini-embed.ts';
import { rankBySimilarity } from '../core/similarity.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Common English stop words + filler words to filter from prompts */
export const STOP_WORDS = new Set([
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

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

/**
 * Extract meaningful keywords from a user prompt
 * Pure function: lowercase, strip punctuation, tokenize, filter stop words
 *
 * @param prompt - Raw user prompt text
 * @returns Array of meaningful keyword tokens
 */
export function extractUnigrams(prompt: string): readonly string[] {
  return prompt
    .toLowerCase()
    .replace(/[^\w\s.\-]/g, ' ')  // Strip punctuation (keep hyphens and dots for compound words / versions)
    .split(/\s+/)
    .filter(t => t.length > 1)  // Drop single chars
    .filter(t => !STOP_WORDS.has(t))
    .filter((t, i, arr) => arr.indexOf(t) === i);  // Deduplicate
}

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
 * Format prompt recall results as compact markdown
 * Returns empty string if no results or search was skipped
 *
 * @param memories - Recalled memories
 * @returns Markdown string with markers, or empty string
 */
export function formatPromptRecall(memories: readonly Memory[]): string {
  if (memories.length === 0) return '';

  const lines = memories.map(m => `- [${m.memory_type}] ${m.summary}`);

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

  // Search both DBs
  const projectResults = projectDb ? searchByKeywordOr(projectDb, tokens, limit) : [];
  const globalResults = globalDb ? searchByKeywordOr(globalDb, tokens, limit) : [];

  // Merge and deduplicate by ID
  const seenIds = new Set<string>();
  const merged: Memory[] = [];

  for (const mem of [...projectResults, ...globalResults]) {
    if (seenIds.has(mem.id)) continue;
    seenIds.add(mem.id);

    // Deduplicate against surface content — skip if summary already present
    if (options.surfaceContent && options.surfaceContent.includes(mem.summary)) {
      continue;
    }

    merged.push(mem);
  }

  // Respect limit after dedup
  return merged.slice(0, limit);
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
    const embeddings = await embedTexts(
      [options.prompt.trim()],
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
