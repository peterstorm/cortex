// Pure graph engine functions for memory relationships

import type { Edge, EdgeRelation } from './types.js';

// Traversal direction filter
export type TraversalDirection = 'outgoing' | 'incoming' | 'both';

// Traversal options
export type TraversalOptions = {
  readonly maxDepth?: number; // Default 2 (FR-066)
  readonly edgeTypes?: ReadonlyArray<EdgeRelation>; // Filter by type (FR-067)
  readonly direction?: TraversalDirection; // Filter by direction (FR-068)
  readonly minStrength?: number; // Filter by strength (FR-069)
};

// Traversal result with depth information
export type TraversalResult = {
  readonly memoryId: string;
  readonly depth: number;
  readonly path: ReadonlyArray<Edge>; // Path from start to this node
};

/**
 * Sanitize edge type aliases to canonical form (FR-063)
 *
 * Normalizes edge type strings to valid EdgeRelation values.
 * Returns null for invalid types.
 */
export function sanitizeEdgeType(raw: string): EdgeRelation | null {
  const normalized = raw.toLowerCase().trim();

  // Direct mappings
  const typeMap: Record<string, EdgeRelation> = {
    'relates_to': 'relates_to',
    'related': 'relates_to',
    'derived_from': 'derived_from',
    'derives': 'derived_from',
    'contradicts': 'contradicts',
    'contradict': 'contradicts',
    'exemplifies': 'exemplifies',
    'example': 'exemplifies',
    'refines': 'refines',
    'refine': 'refines',
    'supersedes': 'supersedes',
    'supersede': 'supersedes',
    'source_of': 'source_of',
    'source': 'source_of',
  };

  return Object.hasOwn(typeMap, normalized) ? typeMap[normalized] : null;
}

/**
 * Check if an edge is a duplicate (FR-063, FR-106)
 *
 * Two edges are duplicates if they have the same source, target, and relation type.
 */
export function isDuplicateEdge(existing: Edge, candidate: Edge): boolean {
  return (
    existing.source_id === candidate.source_id &&
    existing.target_id === candidate.target_id &&
    existing.relation_type === candidate.relation_type
  );
}

/**
 * Compute in-degree centrality for a single memory (FR-062, FR-066)
 *
 * Centrality is the count of incoming edges, normalized to [0, 1].
 * Returns 0 if memory has no incoming edges.
 *
 * Accepts optional precomputed map to avoid redundant computation
 * when called in a loop (see computeAllCentrality).
 */
export function computeCentrality(
  memoryId: string,
  edges: ReadonlyArray<Edge>,
  precomputed?: ReadonlyMap<string, number>
): number {
  const map = precomputed ?? computeAllCentrality(edges);
  return map.get(memoryId) ?? 0;
}

/**
 * Compute in-degree centrality for all memories (FR-062, FR-066)
 *
 * Centrality is the count of incoming edges, normalized to [0, 1].
 * Returns a map of memory ID to centrality score.
 */
export function computeAllCentrality(edges: ReadonlyArray<Edge>): Map<string, number> {
  const inDegree = new Map<string, number>();

  // Count incoming edges for each node
  for (const edge of edges) {
    const current = inDegree.get(edge.target_id) ?? 0;
    inDegree.set(edge.target_id, current + 1);
  }

  // Normalize to [0, 1] - safe for large graphs
  let maxDegree = 0;
  for (const degree of inDegree.values()) {
    if (degree > maxDegree) maxDegree = degree;
  }

  if (maxDegree === 0) {
    return new Map(); // No edges = all centrality is 0
  }

  const centrality = new Map<string, number>();
  for (const [memoryId, degree] of inDegree.entries()) {
    centrality.set(memoryId, degree / maxDegree);
  }

  return centrality;
}

/**
 * Traverse graph from start node using BFS (FR-066, FR-067, FR-068, FR-069, FR-070)
 *
 * Performs breadth-first traversal with configurable filters:
 * - maxDepth: Maximum hops from start (default 2)
 * - edgeTypes: Only follow edges of specified types
 * - direction: Follow outgoing, incoming, or both edges
 * - minStrength: Only follow edges with strength >= threshold
 *
 * Returns all reachable nodes with their depth and path from start.
 * Prevents infinite loops via visited set.
 */
export function traverseGraph(
  startId: string,
  edges: ReadonlyArray<Edge>,
  options: TraversalOptions = {}
): ReadonlyArray<TraversalResult> {
  const maxDepth = options.maxDepth ?? 2;
  const edgeTypes = options.edgeTypes ? new Set(options.edgeTypes) : null;
  const direction = options.direction ?? 'both';
  const minStrength = options.minStrength ?? 0;

  // Build adjacency lists for efficient traversal
  const outgoing = new Map<string, Array<Edge>>();
  const incoming = new Map<string, Array<Edge>>();

  for (const edge of edges) {
    // Apply filters
    if (edgeTypes && !edgeTypes.has(edge.relation_type)) continue;
    if (edge.strength < minStrength) continue;

    // Build adjacency lists
    if (!outgoing.has(edge.source_id)) {
      outgoing.set(edge.source_id, []);
    }
    outgoing.get(edge.source_id)!.push(edge);

    if (!incoming.has(edge.target_id)) {
      incoming.set(edge.target_id, []);
    }
    incoming.get(edge.target_id)!.push(edge);
  }

  // BFS with visited set to prevent cycles (FR-070)
  const visited = new Set<string>([startId]);
  const results: TraversalResult[] = [];
  const queue: Array<{ memoryId: string; depth: number; path: ReadonlyArray<Edge> }> = [
    { memoryId: startId, depth: 0, path: [] }
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Don't traverse beyond max depth
    if (current.depth >= maxDepth) continue;

    // Get neighbors based on direction
    const neighbors: Array<{ edge: Edge; nextId: string }> = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outEdges = outgoing.get(current.memoryId) ?? [];
      for (const edge of outEdges) {
        neighbors.push({ edge, nextId: edge.target_id });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const inEdges = incoming.get(current.memoryId) ?? [];
      for (const edge of inEdges) {
        neighbors.push({ edge, nextId: edge.source_id });
      }
    }

    // Visit each neighbor
    for (const { edge, nextId } of neighbors) {
      if (visited.has(nextId)) continue; // Prevent cycles

      visited.add(nextId);
      const newPath = [...current.path, edge];

      results.push({
        memoryId: nextId,
        depth: current.depth + 1,
        path: newPath,
      });

      queue.push({
        memoryId: nextId,
        depth: current.depth + 1,
        path: newPath,
      });
    }
  }

  return results;
}
