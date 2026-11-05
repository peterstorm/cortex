/**
 * Prompt-aware recall for UserPromptSubmit hook
 *
 * Runs on EVERY prompt, so precision beats recall: a false positive costs
 * context on every turn, a false negative costs nothing (the user can /recall).
 *
 * Ranking is semantic-first: embed the prompt, score every active memory in
 * both DBs by cosine, keep hits above a floor and within a band of the best
 * hit. Strict keyword AND matches (every prompt keyword present) supplement
 * it. Broad keyword OR search is NOT used on the healthy path — it matches on
 * any single generic word, ignores score, and injected unrelated memories.
 * OR survives only as the degraded path when embedding fails.
 * Results already in the static surface are deduplicated away before ranking.
 *
 * Design: Pure functions (extractUnigrams, extractKeywords, selectSemanticHits,
 * mergePromptRecall, formatPromptRecall) + sync I/O boundary
 * (executePromptRecall, keyword only) + async I/O wrapper
 * (executePromptRecallWithFallback). Always succeeds — returns empty on errors.
 */

import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { searchByKeywordOr, searchByKeywordAnd, getMemoriesWithEmbedding } from '../infra/db.js';
import { embedLocal } from '../infra/local-embed.ts';
import { rankBySimilarity, STOP_WORDS, extractUnigrams } from '../core/similarity.js';
import { buildQueryEmbeddingText } from './recall.js';
import { sanitizeSurfaceText } from '../core/surface.js';
import {
  RECALL_MAX_BLOCK_BYTES,
  SUMMARY_MAX_CHARS,
  UNTRUSTED_MEMORY_WARNING,
} from '../config.js';

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

/** Minimum unigram count required to run the semantic path (below this a prompt is "ok do it"-grade noise) */
export const SEMANTIC_MIN_UNIGRAMS = 2;

/**
 * Cosine floor for prompt injection, stricter than MIN_COSINE_SCORE (0.45).
 *
 * Measured on the live corpus (34 embedded memories across project + global,
 * 10 on-topic and 7 off-topic prompts): on-topic top1 0.44-0.67 (9 of 10 at
 * or above 0.50), off-topic top1 at most 0.43. 0.50 sits 0.07 above the
 * worst off-topic score. The sample is small — revisit when the corpus grows.
 */
export const SEMANTIC_COSINE_FLOOR = 0.5;

/**
 * Keep only hits within this cosine distance of the best hit. A strong match
 * (0.67) should not drag in barely-passing neighbours (0.51), while a cluster
 * of equally relevant memories (0.59-0.63) is kept whole.
 */
export const SEMANTIC_RELATIVE_BAND = 0.15;

/** Max semantic hits (keyword AND hits can fill the rest of PROMPT_RECALL_LIMIT) */
export const SEMANTIC_LIMIT = 3;

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
 * True when the memory's summary already appears in the static surface, i.e.
 * injecting it again would repeat what is in context. Applied BEFORE semantic
 * ranking so surface hits do not consume the limit and starve real matches.
 */
export function isInSurface(memory: Memory, surfaceContent: string): boolean {
  return surfaceContent !== '' && surfaceContent.includes(memory.summary);
}

/**
 * Keep ranked hits within `band` of the best score. Expects `ranked` sorted
 * by descending score (rankBySimilarity's contract).
 */
export function selectSemanticHits(
  ranked: readonly { readonly memory: Memory; readonly score: number }[],
  band: number,
): readonly Memory[] {
  if (ranked.length === 0) return [];
  const cutoff = ranked[0].score - band;
  return ranked.filter(({ score }) => score >= cutoff).map(({ memory }) => memory);
}

/**
 * Merge semantic hits (first: ranked by relevance) with strict keyword hits,
 * deduplicated by id and capped at `limit`.
 */
export function mergePromptRecall(
  semantic: readonly Memory[],
  keyword: readonly Memory[],
  limit: number,
): readonly Memory[] {
  const seen = new Set<string>();
  const merged: Memory[] = [];
  for (const mem of [...semantic, ...keyword]) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    merged.push(mem);
    if (merged.length >= limit) break;
  }
  return merged;
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

  const header = [
    '<!-- CORTEX_RECALL_START -->',
    '## Prompt-Relevant Memories',
    '',
    UNTRUSTED_MEMORY_WARNING,
    '',
  ];
  const footer = ['<!-- CORTEX_RECALL_END -->'];

  // Byte budget: the block is injected on every prompt, so it is bounded by
  // construction. Overflow drops whole memories from the tail — never a
  // partial line, because a truncated sentence still reads as a full claim.
  const overhead = Buffer.byteLength([...header, ...footer].join('\n'), 'utf8');
  let used = overhead;

  const lines: string[] = [];
  for (const m of memories) {
    const summary = sanitizeSurfaceText(m.summary, SUMMARY_MAX_CHARS);
    if (!summary) continue; // fail closed: unrenderable memory is dropped
    const type = sanitizeSurfaceText(m.memory_type, 40);
    const line = `- [${type}] ${summary}`;
    const cost = Buffer.byteLength(line, 'utf8') + 1; // +1 for the join newline
    if (used + cost > RECALL_MAX_BLOCK_BYTES) break;
    lines.push(line);
    used += cost;
  }

  if (lines.length === 0) return '';

  return [...header, ...lines, ...footer].join('\n');
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
 * Strict keyword AND search across both databases: a memory matches only when
 * EVERY unigram appears. High precision; empty when the prompt has too few or
 * too many unigrams for AND to be meaningful.
 * I/O: Reads from databases
 */
function searchStrictKeyword(
  projectDb: Database | null,
  globalDb: Database | null,
  unigrams: readonly string[],
  limit: number,
): readonly Memory[] {
  const andEligible =
    unigrams.length >= AND_FIRST_MIN_UNIGRAMS &&
    unigrams.length <= AND_FIRST_MAX_UNIGRAMS;
  if (!andEligible) return [];
  return [
    ...(projectDb ? searchByKeywordAnd(projectDb, unigrams, limit) : []),
    ...(globalDb ? searchByKeywordAnd(globalDb, unigrams, limit) : []),
  ];
}

/**
 * Keyword-only prompt recall across both databases (strict AND, then broad OR).
 * This is the DEGRADED path: it runs only when the embedder is unavailable.
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

  // Tier 1: strict AND over unigrams. Misses are common, so OR still runs.
  const strict = searchStrictKeyword(projectDb, globalDb, unigrams, limit);

  // Tier 2: broad OR over unigrams + bigrams.
  const projectOr = projectDb ? searchByKeywordOr(projectDb, tokens, limit) : [];
  const globalOr = globalDb ? searchByKeywordOr(globalDb, tokens, limit) : [];

  // Merge: AND results first (higher precision), then OR results, dedup by ID.
  // Filter tag-only matches (FTS5 hit only in tag column) — usually low precision.
  // Filter against the static surface so we don't repeat what's already in context.
  const seenIds = new Set<string>();
  const merged: Memory[] = [];

  for (const mem of [...strict, ...projectOr, ...globalOr]) {
    if (seenIds.has(mem.id)) continue;
    seenIds.add(mem.id);

    if (isTagOnlyMatch(mem, unigrams)) continue;
    if (isInSurface(mem, options.surfaceContent)) continue;

    merged.push(mem);
    if (merged.length >= limit) break;
  }

  return merged;
}

/**
 * Async prompt recall: semantic-first, keyword-AND supplemented, keyword-only
 * when the embedder fails.
 *
 * 1. Fewer than SEMANTIC_MIN_UNIGRAMS unigrams → nothing ("ok do it" prompts).
 * 2. Embed the prompt; rank active memories from both DBs that are NOT already
 *    in the surface; keep hits above SEMANTIC_COSINE_FLOOR and within
 *    SEMANTIC_RELATIVE_BAND of the best.
 * 3. Add strict keyword AND hits (tag-only matches and surface repeats dropped).
 * 4. Embedding/ranking failure → degrade to keyword-only executePromptRecall.
 *
 * @param projectDb - Project-scoped database (or null if unavailable)
 * @param globalDb - Global database (or null if unavailable)
 * @param options - Prompt text, surface content for dedup, optional limit
 * @returns Deduplicated array of relevant memories, best first
 */
export async function executePromptRecallWithFallback(
  projectDb: Database | null,
  globalDb: Database | null,
  options: PromptRecallOptions,
): Promise<readonly Memory[]> {
  const unigrams = extractUnigrams(options.prompt);
  if (unigrams.length < SEMANTIC_MIN_UNIGRAMS) {
    return [];
  }

  const limit = options.limit ?? PROMPT_RECALL_LIMIT;

  let semantic: readonly Memory[];
  try {
    // Same [query] [project:name] prefix as recall.ts — memories were
    // embedded with a metadata prefix, so an unprefixed query lands in a
    // slightly different embedding space and degrades ranking.
    const queryEmbedding = await embedLocal(
      buildQueryEmbeddingText(options.prompt, options.projectName),
    );
    const candidates = [
      ...(projectDb ? getMemoriesWithEmbedding(projectDb) : []),
      ...(globalDb ? getMemoriesWithEmbedding(globalDb) : []),
    ].filter(({ memory }) => !isInSurface(memory, options.surfaceContent));

    semantic = selectSemanticHits(
      rankBySimilarity(candidates, queryEmbedding, SEMANTIC_LIMIT, SEMANTIC_COSINE_FLOOR),
      SEMANTIC_RELATIVE_BAND,
    );
  } catch {
    // Best-effort: embedder/DB failure degrades to keyword-only recall.
    return executePromptRecall(projectDb, globalDb, options);
  }

  const strict = searchStrictKeyword(projectDb, globalDb, unigrams, limit).filter(
    (mem) => !isTagOnlyMatch(mem, unigrams) && !isInSurface(mem, options.surfaceContent),
  );

  return mergePromptRecall(semantic, strict, limit);
}
