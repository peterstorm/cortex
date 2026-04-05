/**
 * Prompt-aware keyword recall for UserPromptSubmit hook
 *
 * Extracts keywords from the user's prompt, runs FTS5 OR search across
 * both project and global DBs, deduplicates against the static surface,
 * and outputs compact markdown for injection into the conversation context.
 *
 * Design: Pure functions (extractKeywords, formatPromptRecall) + I/O boundary
 * (executePromptRecall). Always succeeds — returns empty on errors.
 */

import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { searchByKeywordOr } from '../infra/db.js';

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
export function extractKeywords(prompt: string): readonly string[] {
  const unigrams = prompt
    .toLowerCase()
    .replace(/[^\w\s.\-]/g, ' ')  // Strip punctuation (keep hyphens and dots for compound words / versions)
    .split(/\s+/)
    .filter(t => t.length > 1)  // Drop single chars
    .filter(t => !STOP_WORDS.has(t))
    .filter((t, i, arr) => arr.indexOf(t) === i);  // Deduplicate

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
