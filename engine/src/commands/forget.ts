/**
 * forget command - archive memories by ID or fuzzy query
 * Thin orchestrator following functional core / imperative shell pattern
 *
 * Implements:
 * - FR-093: Archive by ID
 * - FR-094: Archive by fuzzy query
 * - FR-095: Return candidates for confirmation (confirmation handled by calling skill)
 * - FR-096: Archived memories excluded from search (handled by status filtering in other commands)
 */

import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { getMemory, updateMemory, searchByKeyword, archiveEdgesForMemory, supersedeFactsForMemory } from '../infra/db.js';
import { invalidateSurfaceCache } from './generate.js';

// ============================================================================
// RESULT TYPES (discriminated unions)
// ============================================================================

/**
 * Result of forget operation (discriminated union)
 */
export type ForgetResult =
  | { status: 'archived'; memoryId: string; summary: string }
  | { status: 'not_found'; memoryId: string }
  | { status: 'candidates'; memories: readonly ForgetCandidate[] };

/**
 * Memory candidate for fuzzy query results
 */
export interface ForgetCandidate {
  readonly id: string;
  readonly summary: string;
  readonly memory_type: string;
  readonly created_at: string;
  readonly scope: string;
}

// ============================================================================
// FUNCTIONAL CORE (pure)
// ============================================================================

/**
 * Transform memory to forget candidate (pure)
 */
function memoryToCandidate(memory: Memory): ForgetCandidate {
  return {
    id: memory.id,
    summary: memory.summary,
    memory_type: memory.memory_type,
    created_at: memory.created_at,
    scope: memory.scope,
  };
}

/**
 * Filter active memories only (pure)
 */
function filterActive(memories: readonly Memory[]): readonly Memory[] {
  return memories.filter(m => m.status === 'active');
}

// ============================================================================
// IMPERATIVE SHELL (I/O)
// ============================================================================

/**
 * Archive memory by ID
 * I/O: Reads and writes to database
 *
 * @param db - Database instance
 * @param id - Memory ID to archive
 * @param cwd - Project root; when provided, the surface cache is invalidated
 *              so the archived memory can't be served from a stale cache
 * @returns ForgetResult indicating success or not found
 */
export function forgetById(db: Database, id: string, cwd?: string): ForgetResult {
  // Fetch memory (I/O)
  const memory = getMemory(db, id);

  if (!memory) {
    return { status: 'not_found', memoryId: id };
  }

  // Archive memory and soft-delete edges (I/O)
  // archived_at anchors the archive→prune grace period (FR-091)
  updateMemory(db, id, { status: 'archived', archived_at: new Date().toISOString() });
  archiveEdgesForMemory(db, id);

  // Supersede facts sourced from this memory — entity-query must stop
  // reporting knowledge whose source was just retracted (FR-096 spirit)
  supersedeFactsForMemory(db, id);

  // Invalidate cached surfaces: the visible memory set changed
  if (cwd !== undefined) {
    invalidateSurfaceCache(cwd);
  }

  return {
    status: 'archived',
    memoryId: id,
    summary: memory.summary,
  };
}

/**
 * Search for memories matching fuzzy query
 * I/O: Searches database via FTS5
 *
 * Returns candidates for user confirmation (confirmation handled by calling skill)
 *
 * @param db - Database instance
 * @param query - Fuzzy search query (keyword-based)
 * @param limit - Maximum number of candidates to return (default: 10)
 * @returns ForgetResult with candidates or empty list if no matches
 */
export function forgetByQuery(db: Database, query: string, limit: number = 10): ForgetResult {
  // Search via FTS5 (I/O)
  const results = searchByKeyword(db, query, limit);

  // Filter to active memories only (pure)
  const activeResults = filterActive(results);

  // Transform to candidates (pure)
  const candidates = activeResults.map(memoryToCandidate);

  return {
    status: 'candidates',
    memories: candidates,
  };
}

/**
 * Archive multiple memories by IDs
 * I/O: Reads and writes to database for each ID
 *
 * @param db - Database instance
 * @param ids - Array of memory IDs to archive
 * @returns Array of ForgetResult for each ID
 */
export function forgetByIds(db: Database, ids: readonly string[], cwd?: string): readonly ForgetResult[] {
  return ids.map(id => forgetById(db, id, cwd));
}
