/**
 * Traverse command - BFS graph traversal from memory ID
 * Orchestrates pure graph traversal with DB I/O
 */

import type { Database } from 'bun:sqlite';
import type { Memory, EdgeRelation } from '../core/types.js';
import { traverseGraph, type TraversalDirection } from '../core/graph.js';
import { getMemory, getAllEdges, getMemoriesByIds } from '../infra/db.js';
import { isEdgeRelation } from '../core/types.js';

// Command options (validated externally)
export type TraverseOptions = {
  readonly id: string; // Memory ID (required)
  readonly depth?: number; // Default 2
  readonly edgeTypes?: string; // Comma-separated edge types
  readonly direction?: string; // 'outgoing' | 'incoming' | 'both' (default 'both')
  readonly minStrength?: number; // Default 0
};

// Command result
export type TraverseResult = {
  readonly start: Memory;
  readonly results: { readonly [depth: number]: readonly Memory[] };
};

// Error result (discriminated union)
export type TraverseError =
  | { type: 'memory_not_found'; id: string }
  | { type: 'invalid_depth'; value: number }
  | { type: 'invalid_edge_type'; value: string }
  | { type: 'invalid_direction'; value: string }
  | { type: 'invalid_min_strength'; value: number };

/**
 * Parse and validate edge types from comma-separated string
 * Pure function - validates against EdgeRelation type
 * Returns result type instead of throwing
 */
function parseEdgeTypes(
  raw: string | undefined
): { ok: true; value: EdgeRelation[] | null } | { ok: false; error: string } {
  if (!raw || raw.trim() === '') {
    return { ok: true, value: null };
  }

  const types = raw.split(',').map(t => t.trim());
  const validated: EdgeRelation[] = [];

  for (const type of types) {
    if (!isEdgeRelation(type)) {
      return { ok: false, error: type };
    }
    validated.push(type);
  }

  return { ok: true, value: validated.length > 0 ? validated : null };
}

/**
 * Parse and validate traversal direction
 * Pure function - returns result type instead of throwing
 */
function parseDirection(
  raw: string | undefined
): { ok: true; value: TraversalDirection } | { ok: false; error: string } {
  const value = raw?.trim().toLowerCase();

  if (!value || value === 'both') {
    return { ok: true, value: 'both' };
  }

  if (value === 'outgoing' || value === 'incoming') {
    return { ok: true, value };
  }

  return { ok: false, error: raw ?? '' };
}

/**
 * Execute traverse command
 * Imperative shell - orchestrates I/O with pure graph logic
 *
 * @param db - Database instance
 * @param options - Command options
 * @returns Either error or result
 */
export function executeTraverse(
  db: Database,
  options: TraverseOptions
): { success: true; result: TraverseResult } | { success: false; error: TraverseError } {
  // Validate and parse options
  const depth = options.depth ?? 2;
  if (Number.isNaN(depth) || depth < 0 || depth > 10) {
    return {
      success: false,
      error: { type: 'invalid_depth', value: depth },
    };
  }

  const minStrength = options.minStrength ?? 0;
  if (Number.isNaN(minStrength) || minStrength < 0 || minStrength > 1) {
    return {
      success: false,
      error: { type: 'invalid_min_strength', value: minStrength },
    };
  }

  const edgeTypesResult = parseEdgeTypes(options.edgeTypes);
  if (!edgeTypesResult.ok) {
    return {
      success: false,
      error: { type: 'invalid_edge_type', value: edgeTypesResult.error },
    };
  }

  const directionResult = parseDirection(options.direction);
  if (!directionResult.ok) {
    return {
      success: false,
      error: { type: 'invalid_direction', value: directionResult.error },
    };
  }

  const edgeTypes = edgeTypesResult.value;
  const direction = directionResult.value;

  // I/O: Get start memory by ID
  const startMemory = getMemory(db, options.id);
  if (!startMemory) {
    return {
      success: false,
      error: { type: 'memory_not_found', id: options.id },
    };
  }

  // I/O: Get all edges from DB
  const allEdges = getAllEdges(db);

  // Pure: Traverse graph with BFS
  const traversalResults = traverseGraph(options.id, allEdges, {
    maxDepth: depth,
    edgeTypes: edgeTypes ?? undefined,
    direction,
    minStrength,
  });

  // I/O: Batch-fetch all discovered memories
  const memoryMap = new Map<string, Memory>();
  memoryMap.set(startMemory.id, startMemory);

  // Collect unique memory IDs that need to be fetched
  const idsToFetch = new Set<string>();
  for (const result of traversalResults) {
    if (!memoryMap.has(result.memoryId)) {
      idsToFetch.add(result.memoryId);
    }
  }

  // Batch fetch all memories in a single query
  if (idsToFetch.size > 0) {
    const memories = getMemoriesByIds(db, Array.from(idsToFetch));
    for (const memory of memories) {
      memoryMap.set(memory.id, memory);
    }
  }

  // Pure: Group results by depth
  const resultsByDepth: { [depth: number]: Memory[] } = {};

  for (const result of traversalResults) {
    const memory = memoryMap.get(result.memoryId);
    if (memory) {
      if (!resultsByDepth[result.depth]) {
        resultsByDepth[result.depth] = [];
      }
      resultsByDepth[result.depth].push(memory);
    }
  }

  return {
    success: true,
    result: {
      start: startMemory,
      results: resultsByDepth,
    },
  };
}

/**
 * Format traverse result as JSON string
 * Pure function - formats data for output
 */
export function formatTraverseResult(result: TraverseResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format traverse error as human-readable string
 * Pure function
 */
export function formatTraverseError(error: TraverseError): string {
  switch (error.type) {
    case 'memory_not_found':
      return `Memory not found: ${error.id}`;
    case 'invalid_depth':
      return `Invalid depth: ${error.value}. Must be between 0 and 10.`;
    case 'invalid_edge_type':
      return `Invalid edge type: ${error.value}. Must be comma-separated EdgeRelation values.`;
    case 'invalid_direction':
      return `Invalid direction: ${error.value}. Must be 'outgoing', 'incoming', or 'both'.`;
    case 'invalid_min_strength':
      return `Invalid min strength: ${error.value}. Must be between 0 and 1.`;
  }
}
