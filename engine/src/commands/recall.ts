/**
 * Recall command - Semantic search via Gemini embeddings OR FTS5 fallback
 * Orchestrates search across project+global DBs, follows graph edges, updates access stats
 */

import type { Database } from 'bun:sqlite';
import type { SearchResult, Memory, Edge } from '../core/types.js';
import { isGeminiAvailable, embedTexts } from '../infra/gemini-embed.ts';
import {
  getMemoriesWithEmbedding,
  getMemoriesWithEmbeddingByIds,
  searchByKeywordAnd,
  searchByKeywordOr,
  getEdgesForMemory,
  getMemoriesByIds,
  getAllEdges,
  updateMemory,
} from '../infra/db.js';
import { rankByFusedSimilarity, tokenize, extractUnigrams } from '../core/similarity.js';
import { mergeResults } from '../core/ranking.js';
import { MIN_COSINE_SCORE, SEMANTIC_PRE_FILTER_LIMIT } from '../config.js';
import { traverseGraph } from '../core/graph.js';

/** Only the top N recall results get their access stats bumped (FR-037). */
export const ACCESS_STATS_TOP_N = 3;

// Command options (validated externally)
export type RecallOptions = {
  readonly query: string; // Query text (required)
  readonly branch?: string; // Optional branch filter
  readonly limit?: number; // Default 10
  readonly keyword?: boolean; // Force keyword search (default false)
  readonly geminiApiKey?: string; // Gemini API key
  readonly projectName?: string; // Project name for embedding prefix (FR-039)
};

// Command result
export type RecallResult = {
  readonly results: readonly SearchResult[];
  readonly method: 'semantic' | 'keyword';
};

// Error result (discriminated union)
export type RecallError =
  | { type: 'empty_query' }
  | { type: 'embedding_failed'; message: string }
  | { type: 'search_failed'; message: string };

/**
 * Build query embedding text with project prefix for aligned search (FR-039)
 * Pure function — prefixes query with [query] [project:name] to align with memory
 * embeddings that use [memory_type] [project:name] prefix.
 * Exported for prompt-recall's semantic fallback (same embedding space).
 */
export function buildQueryEmbeddingText(query: string, projectName?: string): string {
  const trimmed = query.trim();
  if (projectName) {
    return `[query] [project:${projectName}] ${trimmed}`;
  }
  return `[query] ${trimmed}`;
}

/**
 * Filter search results by branch
 * Pure function - filters memories based on source_context.branch
 */
function filterByBranch(
  results: readonly SearchResult[],
  branch: string
): readonly SearchResult[] {
  return results.filter((result) => {
    try {
      const context = JSON.parse(result.memory.source_context);
      return context.branch === branch;
    } catch {
      // Invalid JSON or missing branch, exclude
      return false;
    }
  });
}

/**
 * Follow source_of edges to get linked code blocks
 * I/O: Reads edges and memories from database
 */
function followSourceOfEdges(
  db: Database,
  memory: Memory
): readonly Memory[] {
  const edges = getEdgesForMemory(db, memory.id);

  // Find source_of edges pointing FROM this memory
  const sourceOfEdges = edges.filter(
    (edge) => edge.source_id === memory.id && edge.relation_type === 'source_of'
  );

  if (sourceOfEdges.length === 0) {
    return [];
  }

  // Get target memories (code blocks)
  const targetIds = sourceOfEdges.map((edge) => edge.target_id);
  return getMemoriesByIds(db, targetIds);
}

/**
 * Get related memories via graph traversal (depth 2)
 * Pure over edge data from I/O
 */
function getRelatedMemories(
  db: Database,
  memoryId: string,
  allEdges: readonly Edge[]
): readonly Memory[] {
  // Pure: Traverse graph to depth 2
  const traversalResults = traverseGraph(memoryId, allEdges, {
    maxDepth: 2,
    direction: 'both',
  });

  // I/O: Batch-fetch discovered memories
  const memoryIds = traversalResults.map((result) => result.memoryId);
  if (memoryIds.length === 0) {
    return [];
  }

  return getMemoriesByIds(db, memoryIds);
}

/**
 * Tiered keyword search: strict AND first (precision), OR fallback (recall).
 *
 * A plain implicit-AND FTS5 query returns 0 results for natural-language
 * queries ("how do we handle connection pooling here") because every token —
 * including stopwords — must match. Mirror prompt-recall's tiers:
 * stopword-filter tokens, try AND, then top up with OR results (deduped,
 * AND hits first) when AND alone can't fill the limit.
 *
 * I/O: Reads from database
 */
function tieredKeywordSearch(
  db: Database,
  query: string,
  limit: number
): readonly Memory[] {
  const unigrams = extractUnigrams(query);
  // Stopword filtering can consume the whole query ("what is this?") —
  // fall back to the raw tokens so short queries still search.
  const tokens = unigrams.length > 0
    ? unigrams
    : query.split(/\s+/).filter(t => t.length > 0);

  const andResults = searchByKeywordAnd(db, tokens, limit);
  if (andResults.length >= limit) {
    return andResults;
  }

  const orResults = searchByKeywordOr(db, tokens, limit);

  const seen = new Set(andResults.map(m => m.id));
  const merged: Memory[] = [...andResults];
  for (const mem of orResults) {
    if (merged.length >= limit) break;
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    merged.push(mem);
  }
  return merged;
}

/**
 * Update access statistics for retrieved memories (FR-037)
 * I/O: Writes to database
 */
function updateAccessStats(db: Database, memories: readonly Memory[]): void {
  const now = new Date().toISOString();

  for (const memory of memories) {
    updateMemory(db, memory.id, {
      access_count: memory.access_count + 1,
      last_accessed_at: now,
    });
  }
}

/**
 * Assign position-based scores to keyword results to preserve FTS5 rank ordering.
 * Score range [1.0 → 0.5] ensures keyword results interleave naturally with
 * semantic cosine scores (typically 0.3–0.9) in mergeResults sort.
 */
function assignPositionScores(
  memories: readonly Memory[],
  source: 'project' | 'global'
): SearchResult[] {
  return memories.map((memory, i) => ({
    memory,
    score: memories.length > 1 ? 1 - (i / (memories.length - 1)) * 0.5 : 1.0,
    source,
    related: [],
  }));
}

/**
 * Execute recall command
 * Imperative shell - orchestrates I/O with pure search logic
 *
 * @param projectDb - Project database instance
 * @param globalDb - Global database instance
 * @param options - Command options
 * @returns Either error or result
 */
export async function executeRecall(
  projectDb: Database,
  globalDb: Database,
  options: RecallOptions
): Promise<{ success: true; result: RecallResult } | { success: false; error: RecallError }> {
  const query = options.query.trim();
  const limit = options.limit ?? 10;
  const forceKeyword = options.keyword ?? false;
  // When a branch filter will discard results post-ranking, over-fetch so
  // the filtered pool can still fill `limit`.
  const fetchLimit = options.branch ? limit * 5 : limit;

  // Validate query
  if (query === '') {
    return Promise.resolve({
      success: false,
      error: { type: 'empty_query' },
    });
  }

  let projectSearchResults: SearchResult[];
  let globalSearchResults: SearchResult[];
  let searchMethod: 'semantic' | 'keyword';

  // Determine search method
  const useSemantic =
    !forceKeyword && isGeminiAvailable(options.geminiApiKey);

  if (useSemantic) {
    // Semantic search via Gemini embeddings
    process.stderr.write(`[cortex:recall] INFO: Using Gemini semantic search\n`);
    try {
      // Build embedding text with project prefix (FR-039)
      const embeddingText = buildQueryEmbeddingText(query, options.projectName);

      // I/O: Embed query via Gemini
      const embeddings = await embedTexts(
        [embeddingText],
        options.geminiApiKey!
      );

      const queryEmbedding = embeddings[0];
      if (!queryEmbedding) {
        throw new Error('No embedding returned');
      }

      // I/O: Pre-filter via FTS5, then cosine rank the subset
      const embType = queryEmbedding instanceof Float64Array ? 'gemini' : 'local' as const;

      // Split query into tokens for OR search
      const queryTokens = query.split(/\s+/).filter(t => t.length > 0);

      // Pre-filter: get FTS5 candidate IDs, then fetch only those with embeddings
      const projectFts = queryTokens.length > 0
        ? searchByKeywordOr(projectDb, queryTokens, SEMANTIC_PRE_FILTER_LIMIT)
        : [];
      const globalFts = queryTokens.length > 0
        ? searchByKeywordOr(globalDb, queryTokens, SEMANTIC_PRE_FILTER_LIMIT)
        : [];

      // If FTS returns candidates WITH embeddings, rank only those; otherwise
      // fall back to a full scan. The empty-after-join check matters: FTS can
      // return hits whose embeddings haven't been backfilled yet, and ranking
      // an empty candidate set would silently return zero results.
      const candidatesFor = (
        db: Database,
        ftsHits: readonly { id: string }[]
      ): readonly { memory: Memory; embedding: Float64Array | Float32Array }[] => {
        if (ftsHits.length > 0) {
          const byIds = getMemoriesWithEmbeddingByIds(db, ftsHits.map(m => m.id), embType);
          if (byIds.length > 0) return byIds;
        }
        return getMemoriesWithEmbedding(db, embType);
      };
      const projectCandidates = candidatesFor(projectDb, projectFts);
      const globalCandidates = candidatesFor(globalDb, globalFts);

      const fusedQueryTokens = tokenize(query);
      const projectEmbedResults = rankByFusedSimilarity(projectCandidates, queryEmbedding, fusedQueryTokens, fetchLimit, MIN_COSINE_SCORE);
      const globalEmbedResults = rankByFusedSimilarity(globalCandidates, queryEmbedding, fusedQueryTokens, fetchLimit, MIN_COSINE_SCORE);

      projectSearchResults = projectEmbedResults.map(({ memory, score }) => ({
        memory,
        score,
        source: 'project' as const,
        related: [],
      }));

      globalSearchResults = globalEmbedResults.map(({ memory, score }) => ({
        memory,
        score,
        source: 'global' as const,
        related: [],
      }));

      searchMethod = 'semantic';
    } catch (error) {
      // #8: Fallback to keyword search on semantic failure instead of returning error
      const message = error instanceof Error ? error.message : 'Unknown error';
      process.stderr.write(`[cortex:recall] WARN: Semantic search failed (${message}) — falling back to keyword\n`);
      try {
        const projectKw = tieredKeywordSearch(projectDb, query, fetchLimit);
        const globalKw = tieredKeywordSearch(globalDb, query, fetchLimit);
        projectSearchResults = assignPositionScores(projectKw, 'project');
        globalSearchResults = assignPositionScores(globalKw, 'global');
        searchMethod = 'keyword';
      } catch (kwError) {
        const kwMessage = kwError instanceof Error ? kwError.message : 'Unknown error';
        return { success: false, error: { type: 'search_failed', message: kwMessage } };
      }
    }
  } else {
    // Keyword search via FTS5
    const reason = forceKeyword ? 'forced via --keyword flag' : 'Gemini unavailable';
    process.stderr.write(`[cortex:recall] INFO: Using keyword search (${reason})\n`);
    try {
      const projectKw = tieredKeywordSearch(projectDb, query, fetchLimit);
      const globalKw = tieredKeywordSearch(globalDb, query, fetchLimit);
      projectSearchResults = assignPositionScores(projectKw, 'project');
      globalSearchResults = assignPositionScores(globalKw, 'global');
      searchMethod = 'keyword';
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return Promise.resolve({
        success: false,
        error: { type: 'search_failed', message },
      });
    }
  }

  // Branch filter BEFORE merging/truncating to limit — filtering after the
  // cut would drop branch matches that ranked just below it and return
  // fewer than `limit` results even when more matches existed.
  if (options.branch) {
    projectSearchResults = [...filterByBranch(projectSearchResults, options.branch)];
    globalSearchResults = [...filterByBranch(globalSearchResults, options.branch)];
  }

  const mergedResults = mergeResults(
    projectSearchResults,
    globalSearchResults,
    limit
  );

  // Pre-fetch all edges once per DB (avoid per-result queries).
  // NOTE: Loads entire edge table into memory — acceptable for current scale,
  // but should be revisited if edge count exceeds ~10K per DB.
  const projectEdges = getAllEdges(projectDb);
  const globalEdgesCache = getAllEdges(globalDb);

  // For top results: follow source_of edges and get related memories
  const enrichedResults: SearchResult[] = [];

  for (const result of mergedResults) {
    const db = result.source === 'project' ? projectDb : globalDb;
    const cachedEdges = result.source === 'project' ? projectEdges : globalEdgesCache;

    // Follow source_of edges to get linked code blocks
    const linkedCode = followSourceOfEdges(db, result.memory);

    // Get related memories via graph traversal (depth 2)
    const related = getRelatedMemories(db, result.memory.id, cachedEdges);

    // Merge linked code and related (deduplicate by ID)
    const allRelated = new Map<string, Memory>();
    for (const mem of [...linkedCode, ...related]) {
      allRelated.set(mem.id, mem);
    }

    enrichedResults.push({
      ...result,
      related: Array.from(allRelated.values()),
    });
  }

  // Update access statistics for retrieved memories (FR-037).
  // Only the top results count as "accessed" — bumping every keyword match
  // resets last_accessed_at across the board, so anything matching frequent
  // query words would never decay (access-stat feedback loop).
  const statsEligible = enrichedResults.slice(0, ACCESS_STATS_TOP_N);
  const projectMemories = statsEligible
    .filter((r) => r.source === 'project')
    .map((r) => r.memory);
  const globalMemories = statsEligible
    .filter((r) => r.source === 'global')
    .map((r) => r.memory);

  if (projectMemories.length > 0) {
    updateAccessStats(projectDb, projectMemories);
  }
  if (globalMemories.length > 0) {
    updateAccessStats(globalDb, globalMemories);
  }

  return Promise.resolve({
    success: true,
    result: {
      results: enrichedResults,
      method: searchMethod,
    },
  });
}

/**
 * Format recall result as human-readable markdown
 * Pure function - formats data for output
 */
export function formatRecallResult(
  response: { success: true; result: RecallResult } | { success: false; error: RecallError }
): string {
  if (!response.success) {
    return formatRecallError(response.error);
  }

  const { results, method } = response.result;

  if (results.length === 0) {
    return `No results found (method: ${method})`;
  }

  const lines: string[] = [];
  lines.push(`Found ${results.length} result(s) using ${method} search:\n`);

  for (let i = 0; i < results.length; i++) {
    const { memory, score, source, related } = results[i];

    lines.push(`## Result ${i + 1} (score: ${score.toFixed(3)}, source: ${source})`);
    lines.push(`**Type:** ${memory.memory_type}`);
    lines.push(`**Priority:** ${memory.priority}${memory.pinned ? ' (pinned)' : ''}`);
    lines.push(`**Confidence:** ${memory.confidence.toFixed(2)}`);

    // Truncate content if too long
    const content = memory.content.length > 500
      ? memory.content.substring(0, 497) + '...'
      : memory.content;
    lines.push(`**Content:** ${content}`);

    if (memory.tags.length > 0) {
      lines.push(`**Tags:** ${memory.tags.join(', ')}`);
    }

    // Show limited related memories (max 5)
    if (related.length > 0) {
      lines.push(`**Related (${related.length}):**`);
      for (let j = 0; j < Math.min(5, related.length); j++) {
        const rel = related[j];
        const summary = rel.summary.length > 100
          ? rel.summary.substring(0, 97) + '...'
          : rel.summary;
        lines.push(`  - [${rel.memory_type}] ${summary}`);
      }
      if (related.length > 5) {
        lines.push(`  - ... and ${related.length - 5} more`);
      }
    }

    lines.push(''); // blank line between results
  }

  return lines.join('\n');
}

/**
 * Format recall error as human-readable string
 * Pure function
 */
export function formatRecallError(error: RecallError): string {
  switch (error.type) {
    case 'empty_query':
      return 'Query text is required and must not be empty.';
    case 'embedding_failed':
      return `Embedding failed: ${error.message}`;
    case 'search_failed':
      return `Search failed: ${error.message}`;
  }
}
