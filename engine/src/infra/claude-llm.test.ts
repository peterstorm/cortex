/**
 * Tests for edge classification pure functions (prompt building + response parsing).
 */

import { describe, it, expect } from 'vitest';
import {
  buildEdgeClassificationPrompt,
  parseEdgeClassificationResponse,
  type MemoryPair,
} from './claude-llm.js';

describe('buildEdgeClassificationPrompt', () => {
  it('builds prompt with pair descriptions', () => {
    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Source content',
          summary: 'Source summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Target content',
          summary: 'Target summary',
          memory_type: 'pattern',
        },
      },
    ];

    const result = buildEdgeClassificationPrompt(pairs);

    expect(result).toContain('Pair 1:');
    expect(result).toContain('Source [mem1]:');
    expect(result).toContain('Type: decision');
    expect(result).toContain('Summary: Source summary');
    expect(result).toContain('Content: Source content');
    expect(result).toContain('Target [mem2]:');
    expect(result).toContain('Type: pattern');
    expect(result).toContain('Summary: Target summary');
    expect(result).toContain('Content: Target content');
    expect(result).toContain('Edge Relation Types:');
    expect(result).toContain('relates_to');
    expect(result).toContain('derived_from');
  });
});

describe('parseEdgeClassificationResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
    ]);

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
    ]);
  });

  it('parses JSON in markdown code blocks', () => {
    const response = `
\`\`\`json
[
  { "source_id": "mem1", "target_id": "mem2", "relation_type": "refines", "strength": 0.9 }
]
\`\`\`
`;

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'refines', strength: 0.9 },
    ]);
  });

  it('returns empty array for invalid JSON', () => {
    const result = parseEdgeClassificationResponse('invalid json');
    expect(result).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    const result = parseEdgeClassificationResponse(JSON.stringify({ error: 'test' }));
    expect(result).toEqual([]);
  });

  it('filters invalid classifications', () => {
    const response = JSON.stringify([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
      { source_id: 'mem3', target_id: 'mem4', relation_type: 'invalid', strength: 0.7 },
      { source_id: 'mem5', target_id: 'mem6', relation_type: 'refines', strength: 1.5 },
    ]);

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
    ]);
  });

  it('validates all edge relation types', () => {
    const response = JSON.stringify([
      { source_id: '1', target_id: '2', relation_type: 'relates_to', strength: 0.8 },
      { source_id: '1', target_id: '3', relation_type: 'derived_from', strength: 0.8 },
      { source_id: '1', target_id: '4', relation_type: 'contradicts', strength: 0.8 },
      { source_id: '1', target_id: '5', relation_type: 'exemplifies', strength: 0.8 },
      { source_id: '1', target_id: '6', relation_type: 'refines', strength: 0.8 },
      { source_id: '1', target_id: '7', relation_type: 'supersedes', strength: 0.8 },
      { source_id: '1', target_id: '8', relation_type: 'source_of', strength: 0.8 },
    ]);

    const result = parseEdgeClassificationResponse(response);

    expect(result).toHaveLength(7);
    expect(result.map((r) => r.relation_type)).toEqual([
      'relates_to',
      'derived_from',
      'contradicts',
      'exemplifies',
      'refines',
      'supersedes',
      'source_of',
    ]);
  });
});
