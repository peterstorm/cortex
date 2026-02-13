import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  sanitizeEdgeType,
  isDuplicateEdge,
  computeCentrality,
  computeAllCentrality,
  traverseGraph,
} from './graph.js';
import type { Edge, EdgeRelation } from './types.js';

// Arbitraries for property-based testing
const edgeRelationArb = fc.constantFrom<EdgeRelation>(
  'relates_to',
  'derived_from',
  'contradicts',
  'exemplifies',
  'refines',
  'supersedes',
  'source_of'
);

const memoryIdArb = fc.stringMatching(/^mem-[0-9]+$/);

const edgeArb: fc.Arbitrary<Edge> = fc.record({
  id: fc.string(),
  source_id: memoryIdArb,
  target_id: memoryIdArb,
  relation_type: edgeRelationArb,
  strength: fc.double({ min: 0, max: 1 }),
  bidirectional: fc.boolean(),
  status: fc.constantFrom('active', 'suggested') as fc.Arbitrary<'active' | 'suggested'>,
  created_at: fc.constant(new Date().toISOString()),
});

// Helper to create edges with all canonical Edge fields
function edge(
  source: string,
  target: string,
  type: EdgeRelation = 'relates_to',
  strength: number = 1.0
): Edge {
  return {
    id: `edge-${source}-${target}`,
    source_id: source,
    target_id: target,
    relation_type: type,
    strength,
    bidirectional: false,
    status: 'active',
    created_at: new Date().toISOString(),
  };
}

describe('sanitizeEdgeType', () => {
  it('normalizes valid edge type aliases', () => {
    expect(sanitizeEdgeType('derives')).toBe('derived_from');
    expect(sanitizeEdgeType('contradict')).toBe('contradicts');
    expect(sanitizeEdgeType('related')).toBe('relates_to');
    expect(sanitizeEdgeType('example')).toBe('exemplifies');
    expect(sanitizeEdgeType('refine')).toBe('refines');
    expect(sanitizeEdgeType('supersede')).toBe('supersedes');
    expect(sanitizeEdgeType('source')).toBe('source_of');
  });

  it('returns canonical types unchanged', () => {
    expect(sanitizeEdgeType('relates_to')).toBe('relates_to');
    expect(sanitizeEdgeType('derived_from')).toBe('derived_from');
    expect(sanitizeEdgeType('contradicts')).toBe('contradicts');
    expect(sanitizeEdgeType('exemplifies')).toBe('exemplifies');
    expect(sanitizeEdgeType('refines')).toBe('refines');
    expect(sanitizeEdgeType('supersedes')).toBe('supersedes');
    expect(sanitizeEdgeType('source_of')).toBe('source_of');
  });

  it('handles case insensitivity', () => {
    expect(sanitizeEdgeType('DERIVES')).toBe('derived_from');
    expect(sanitizeEdgeType('Contradict')).toBe('contradicts');
    expect(sanitizeEdgeType('ReLaTeD')).toBe('relates_to');
  });

  it('handles whitespace', () => {
    expect(sanitizeEdgeType('  derives  ')).toBe('derived_from');
    expect(sanitizeEdgeType('\trelated\n')).toBe('relates_to');
  });

  it('returns null for invalid types', () => {
    expect(sanitizeEdgeType('invalid')).toBeNull();
    expect(sanitizeEdgeType('unknown')).toBeNull();
    expect(sanitizeEdgeType('')).toBeNull();
    expect(sanitizeEdgeType('   ')).toBeNull();
  });

  it('property: valid types always produce non-null output', () => {
    fc.assert(
      fc.property(edgeRelationArb, (relationType) => {
        const result = sanitizeEdgeType(relationType);
        expect(result).not.toBeNull();
        expect(result).toBe(relationType);
      })
    );
  });

  it('property: output is always canonical EdgeRelation or null', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = sanitizeEdgeType(input);
        if (result !== null) {
          expect(['relates_to', 'derived_from', 'contradicts', 'exemplifies', 'refines', 'supersedes', 'source_of']).toContain(result);
        }
      })
    );
  });
});

describe('isDuplicateEdge', () => {
  it('returns true for edges with same source, target, and type', () => {
    const e1 = edge('a', 'b', 'relates_to');
    const e2 = edge('a', 'b', 'relates_to');
    expect(isDuplicateEdge(e1, e2)).toBe(true);
  });

  it('returns false for edges with different source', () => {
    const e1 = edge('a', 'b', 'relates_to');
    const e2 = edge('c', 'b', 'relates_to');
    expect(isDuplicateEdge(e1, e2)).toBe(false);
  });

  it('returns false for edges with different target', () => {
    const e1 = edge('a', 'b', 'relates_to');
    const e2 = edge('a', 'c', 'relates_to');
    expect(isDuplicateEdge(e1, e2)).toBe(false);
  });

  it('returns false for edges with different type', () => {
    const e1 = edge('a', 'b', 'relates_to');
    const e2 = edge('a', 'b', 'contradicts');
    expect(isDuplicateEdge(e1, e2)).toBe(false);
  });

  it('ignores strength and bidirectional fields', () => {
    const e1: Edge = { ...edge('a', 'b'), strength: 0.5, bidirectional: false };
    const e2: Edge = { ...edge('a', 'b'), strength: 0.9, bidirectional: true };
    expect(isDuplicateEdge(e1, e2)).toBe(true);
  });

  it('property: duplicate check is reflexive', () => {
    fc.assert(
      fc.property(edgeArb, (e) => {
        expect(isDuplicateEdge(e, e)).toBe(true);
      })
    );
  });

  it('property: duplicate check is symmetric', () => {
    fc.assert(
      fc.property(edgeArb, edgeArb, (e1, e2) => {
        expect(isDuplicateEdge(e1, e2)).toBe(isDuplicateEdge(e2, e1));
      })
    );
  });

  it('property: changing source/target/type breaks duplication', () => {
    fc.assert(
      fc.property(edgeArb, memoryIdArb, (e, newId) => {
        fc.pre(newId !== e.source_id && newId !== e.target_id);
        const differentSource = { ...e, source_id: newId };
        const differentTarget = { ...e, target_id: newId };
        expect(isDuplicateEdge(e, differentSource)).toBe(false);
        expect(isDuplicateEdge(e, differentTarget)).toBe(false);
      })
    );
  });
});

describe('computeCentrality', () => {
  it('returns 0 for memory with no incoming edges', () => {
    const edges = [
      edge('a', 'b'),
      edge('c', 'b'),
    ];
    expect(computeCentrality('a', edges)).toBe(0);
    expect(computeCentrality('z', edges)).toBe(0);
  });

  it('computes normalized centrality for single memory', () => {
    const edges = [
      edge('a', 'b'),
      edge('c', 'b'),
      edge('d', 'e'),
    ];

    // b has 2 incoming edges (max), normalized to 1.0
    expect(computeCentrality('b', edges)).toBe(1.0);
    // e has 1 incoming edge, normalized to 0.5
    expect(computeCentrality('e', edges)).toBe(0.5);
    // a has no incoming edges
    expect(computeCentrality('a', edges)).toBe(0);
  });

  it('property: per-memory matches batch version', () => {
    fc.assert(
      fc.property(fc.array(edgeArb), memoryIdArb, (edges, memoryId) => {
        const single = computeCentrality(memoryId, edges);
        const all = computeAllCentrality(edges);
        const fromBatch = all.get(memoryId) ?? 0;
        expect(single).toBe(fromBatch);
      })
    );
  });
});

describe('computeAllCentrality', () => {
  it('returns empty map for empty edge list', () => {
    const centrality = computeAllCentrality([]);
    expect(centrality.size).toBe(0);
  });

  it('computes in-degree centrality for simple graph', () => {
    const edges = [
      edge('a', 'b'),
      edge('c', 'b'),
      edge('d', 'b'),
    ];
    const centrality = computeAllCentrality(edges);

    // b has 3 incoming edges (max), normalized to 1.0
    expect(centrality.get('b')).toBe(1.0);
    expect(centrality.get('a')).toBeUndefined();
    expect(centrality.get('c')).toBeUndefined();
    expect(centrality.get('d')).toBeUndefined();
  });

  it('normalizes centrality to [0, 1]', () => {
    const edges = [
      edge('a', 'b'),
      edge('c', 'b'),
      edge('d', 'e'),
    ];
    const centrality = computeAllCentrality(edges);

    // b has 2 incoming edges (max)
    // e has 1 incoming edge
    expect(centrality.get('b')).toBe(1.0);
    expect(centrality.get('e')).toBe(0.5);
  });

  it('handles multiple nodes with same in-degree', () => {
    const edges = [
      edge('a', 'b'),
      edge('c', 'd'),
    ];
    const centrality = computeAllCentrality(edges);

    // Both b and d have 1 incoming edge (max)
    expect(centrality.get('b')).toBe(1.0);
    expect(centrality.get('d')).toBe(1.0);
  });

  it('property: centrality is always >= 0', () => {
    fc.assert(
      fc.property(fc.array(edgeArb), (edges) => {
        const centrality = computeAllCentrality(edges);
        for (const score of centrality.values()) {
          expect(score).toBeGreaterThanOrEqual(0);
        }
      })
    );
  });

  it('property: centrality is always <= 1', () => {
    fc.assert(
      fc.property(fc.array(edgeArb), (edges) => {
        const centrality = computeAllCentrality(edges);
        for (const score of centrality.values()) {
          expect(score).toBeLessThanOrEqual(1);
        }
      })
    );
  });

  it('property: max centrality is 1.0 if any edges exist', () => {
    fc.assert(
      fc.property(fc.array(edgeArb, { minLength: 1 }), (edges) => {
        const centrality = computeAllCentrality(edges);
        const maxScore = Math.max(...Array.from(centrality.values()));
        expect(maxScore).toBe(1.0);
      })
    );
  });

  it('property: nodes not in target_id have centrality 0 (undefined)', () => {
    fc.assert(
      fc.property(fc.array(edgeArb), (edges) => {
        const centrality = computeAllCentrality(edges);
        const sources = new Set(edges.map(e => e.source_id));
        const targets = new Set(edges.map(e => e.target_id));

        for (const source of sources) {
          if (!targets.has(source)) {
            expect(centrality.get(source)).toBeUndefined();
          }
        }
      })
    );
  });
});

describe('traverseGraph', () => {
  it('returns empty array for isolated node', () => {
    const edges: Edge[] = [];
    const results = traverseGraph('a', edges);
    expect(results).toEqual([]);
  });

  it('traverses simple chain with depth tracking', () => {
    const edges = [
      edge('a', 'b'),
      edge('b', 'c'),
    ];
    const results = traverseGraph('a', edges);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ memoryId: 'b', depth: 1 });
    expect(results[1]).toMatchObject({ memoryId: 'c', depth: 2 });
  });

  it('respects maxDepth parameter', () => {
    const edges = [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'd'),
    ];

    const results1 = traverseGraph('a', edges, { maxDepth: 1 });
    expect(results1).toHaveLength(1);
    expect(results1[0].memoryId).toBe('b');

    const results2 = traverseGraph('a', edges, { maxDepth: 2 });
    expect(results2).toHaveLength(2);
    expect(results2.map(r => r.memoryId)).toEqual(['b', 'c']);
  });

  it('prevents infinite loops on cycles', () => {
    const edges = [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'a'), // Cycle back to start
    ];
    const results = traverseGraph('a', edges);

    // Should visit each node once despite cycle
    expect(results).toHaveLength(2);
    const ids = results.map(r => r.memoryId);
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });

  it('handles self-loops', () => {
    const edges = [
      edge('a', 'a'), // Self-loop
    ];
    const results = traverseGraph('a', edges);

    // Should not revisit 'a' (already in visited set)
    expect(results).toEqual([]);
  });

  it('filters by edge type', () => {
    const edges = [
      edge('a', 'b', 'relates_to'),
      edge('a', 'c', 'contradicts'),
      edge('b', 'd', 'relates_to'),
    ];

    const results = traverseGraph('a', edges, {
      edgeTypes: ['relates_to'],
    });

    // Should only follow relates_to edges
    expect(results).toHaveLength(2);
    expect(results.map(r => r.memoryId)).toEqual(['b', 'd']);
  });

  it('filters by direction: outgoing', () => {
    const edges = [
      edge('a', 'b'),
      edge('c', 'a'), // Incoming to a
      edge('b', 'd'),
    ];

    const results = traverseGraph('a', edges, { direction: 'outgoing' });

    // Should only follow outgoing edges from a
    expect(results).toHaveLength(2);
    expect(results.map(r => r.memoryId)).toEqual(['b', 'd']);
  });

  it('filters by direction: incoming', () => {
    const edges = [
      edge('a', 'b'),
      edge('c', 'a'), // Incoming to a
      edge('d', 'c'),
    ];

    const results = traverseGraph('a', edges, { direction: 'incoming' });

    // Should only follow incoming edges (traverse backward)
    expect(results).toHaveLength(2);
    expect(results.map(r => r.memoryId)).toEqual(['c', 'd']);
  });

  it('filters by direction: both', () => {
    const edges = [
      edge('a', 'b'), // Outgoing from a
      edge('c', 'a'), // Incoming to a
    ];

    const results = traverseGraph('a', edges, { direction: 'both' });

    // Should follow both directions
    expect(results).toHaveLength(2);
    const ids = results.map(r => r.memoryId);
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });

  it('filters by minimum strength', () => {
    const edges = [
      edge('a', 'b', 'relates_to', 0.9),
      edge('a', 'c', 'relates_to', 0.3),
      edge('b', 'd', 'relates_to', 0.8),
    ];

    const results = traverseGraph('a', edges, { minStrength: 0.5 });

    // Should only follow edges with strength >= 0.5
    expect(results).toHaveLength(2);
    expect(results.map(r => r.memoryId)).toEqual(['b', 'd']);
  });

  it('combines multiple filters', () => {
    const edges = [
      edge('a', 'b', 'relates_to', 0.9),
      edge('a', 'c', 'contradicts', 0.9),
      edge('b', 'd', 'relates_to', 0.3),
      edge('b', 'e', 'relates_to', 0.9),
    ];

    const results = traverseGraph('a', edges, {
      edgeTypes: ['relates_to'],
      minStrength: 0.5,
      maxDepth: 2,
    });

    // Should follow relates_to edges with strength >= 0.5
    expect(results).toHaveLength(2);
    expect(results.map(r => r.memoryId)).toEqual(['b', 'e']);
  });

  it('includes path information', () => {
    const edges = [
      edge('a', 'b'),
      edge('b', 'c'),
    ];

    const results = traverseGraph('a', edges);

    expect(results[0].path).toHaveLength(1);
    expect(results[0].path[0]).toMatchObject({
      source_id: 'a',
      target_id: 'b',
    });

    expect(results[1].path).toHaveLength(2);
    expect(results[1].path[0]).toMatchObject({
      source_id: 'a',
      target_id: 'b',
    });
    expect(results[1].path[1]).toMatchObject({
      source_id: 'b',
      target_id: 'c',
    });
  });

  it('property: depth never exceeds maxDepth', () => {
    fc.assert(
      fc.property(
        fc.array(edgeArb),
        memoryIdArb,
        fc.integer({ min: 0, max: 5 }),
        (edges, startId, maxDepth) => {
          const results = traverseGraph(startId, edges, { maxDepth });
          for (const result of results) {
            expect(result.depth).toBeLessThanOrEqual(maxDepth);
          }
        }
      )
    );
  });

  it('property: depth is positive for all results', () => {
    fc.assert(
      fc.property(fc.array(edgeArb), memoryIdArb, (edges, startId) => {
        const results = traverseGraph(startId, edges);
        for (const result of results) {
          expect(result.depth).toBeGreaterThan(0);
        }
      })
    );
  });

  it('property: no duplicate memory IDs in results', () => {
    fc.assert(
      fc.property(fc.array(edgeArb), memoryIdArb, (edges, startId) => {
        const results = traverseGraph(startId, edges);
        const ids = results.map(r => r.memoryId);
        const uniqueIds = new Set(ids);
        expect(ids.length).toBe(uniqueIds.size);
      })
    );
  });

  it('property: path length equals depth', () => {
    fc.assert(
      fc.property(fc.array(edgeArb), memoryIdArb, (edges, startId) => {
        const results = traverseGraph(startId, edges);
        for (const result of results) {
          expect(result.path.length).toBe(result.depth);
        }
      })
    );
  });

  it('property: startId never appears in results', () => {
    fc.assert(
      fc.property(fc.array(edgeArb), memoryIdArb, (edges, startId) => {
        const results = traverseGraph(startId, edges);
        const ids = results.map(r => r.memoryId);
        expect(ids).not.toContain(startId);
      })
    );
  });

  it('edge case: empty edge list with any start ID', () => {
    fc.assert(
      fc.property(memoryIdArb, (startId) => {
        const results = traverseGraph(startId, []);
        expect(results).toEqual([]);
      })
    );
  });

  it('edge case: maxDepth = 0', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const results = traverseGraph('a', edges, { maxDepth: 0 });
    expect(results).toEqual([]);
  });

  it('edge case: minStrength = 1.0', () => {
    const edges = [
      edge('a', 'b', 'relates_to', 0.99),
      edge('a', 'c', 'relates_to', 1.0),
    ];
    const results = traverseGraph('a', edges, { minStrength: 1.0 });
    expect(results).toHaveLength(1);
    expect(results[0].memoryId).toBe('c');
  });

  it('edge case: complex graph with multiple paths', () => {
    const edges = [
      edge('a', 'b'),
      edge('a', 'c'),
      edge('b', 'd'),
      edge('c', 'd'), // Multiple paths to d
    ];

    const results = traverseGraph('a', edges);

    // Should visit d only once (via first discovered path)
    const ids = results.map(r => r.memoryId);
    expect(ids.filter(id => id === 'd')).toHaveLength(1);
  });
});
