import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  createMemory,
  createEdge,
  createExtractionCheckpoint,
  createMemoryCandidate,
  isMemoryType,
  isEdgeRelation,
  isMemoryStatus,
  MEMORY_TYPES,
  EDGE_RELATIONS,
  MEMORY_STATUSES,
  type Memory,
  type Edge,
  type MemoryType,
  type EdgeRelation,
  type SimilarityAction,
} from './types.js';

describe('createMemory', () => {
  it('creates valid memory with all required fields', () => {
    const memory = createMemory({
      id: 'mem-1',
      content: 'Test content',
      summary: 'Test summary',
      memory_type: 'architecture',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'manual',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    expect(memory.id).toBe('mem-1');
    expect(memory.content).toBe('Test content');
    expect(memory.summary).toBe('Test summary');
    expect(memory.memory_type).toBe('architecture');
    expect(memory.scope).toBe('project');
    expect(memory.confidence).toBe(0.8);
    expect(memory.priority).toBe(5);
    expect(memory.source_type).toBe('manual');
    expect(memory.pinned).toBe(false);
    expect(memory.tags).toEqual([]);
    expect(memory.access_count).toBe(0);
    expect(memory.status).toBe('active');
    expect(memory.embedding).toBeNull();
    expect(memory.local_embedding).toBeNull();
  });

  it('creates memory with optional fields', () => {
    const embedding = new Float64Array([0.1, 0.2, 0.3]);
    const memory = createMemory({
      id: 'mem-2',
      content: 'Content',
      summary: 'Summary',
      memory_type: 'decision',
      scope: 'global',
      confidence: 0.9,
      priority: 8,
      source_type: 'extraction',
      source_session: 'session-2',
      source_context: '{}',
      tags: ['tag1', 'tag2'],
      pinned: true,
      embedding: embedding,
      access_count: 5,
      status: 'superseded',
    });

    expect(memory.tags).toEqual(['tag1', 'tag2']);
    expect(memory.pinned).toBe(true);
    expect(memory.embedding).toBe(embedding);
    expect(memory.access_count).toBe(5);
    expect(memory.status).toBe('superseded');
  });

  it('throws on confidence < 0', () => {
    expect(() =>
      createMemory({
        id: 'mem-3',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'pattern',
        scope: 'project',
        confidence: -0.1,
        priority: 5,
        source_type: 'manual',
        source_session: 'session-3',
        source_context: '{}',
      })
    ).toThrow('confidence must be in [0, 1]');
  });

  it('throws on confidence > 1', () => {
    expect(() =>
      createMemory({
        id: 'mem-4',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'gotcha',
        scope: 'project',
        confidence: 1.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session-4',
        source_context: '{}',
      })
    ).toThrow('confidence must be in [0, 1]');
  });

  it('throws on priority < 1', () => {
    expect(() =>
      createMemory({
        id: 'mem-5',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'context',
        scope: 'project',
        confidence: 0.5,
        priority: 0,
        source_type: 'manual',
        source_session: 'session-5',
        source_context: '{}',
      })
    ).toThrow('priority must be in [1, 10]');
  });

  it('throws on priority > 10', () => {
    expect(() =>
      createMemory({
        id: 'mem-6',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'progress',
        scope: 'project',
        confidence: 0.5,
        priority: 11,
        source_type: 'manual',
        source_session: 'session-6',
        source_context: '{}',
      })
    ).toThrow('priority must be in [1, 10]');
  });

  it('throws on invalid memory_type', () => {
    expect(() =>
      createMemory({
        id: 'mem-7',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'invalid' as MemoryType,
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session-7',
        source_context: '{}',
      })
    ).toThrow('invalid memory_type');
  });

  it('throws on invalid status', () => {
    expect(() =>
      createMemory({
        id: 'mem-8',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'code_description',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session-8',
        source_context: '{}',
        status: 'invalid' as any,
      })
    ).toThrow('invalid status');
  });

  it('accepts all valid memory types', () => {
    MEMORY_TYPES.forEach((type) => {
      const memory = createMemory({
        id: `mem-${type}`,
        content: 'Content',
        summary: 'Summary',
        memory_type: type,
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      });
      expect(memory.memory_type).toBe(type);
    });
  });

  it('accepts all valid statuses', () => {
    MEMORY_STATUSES.forEach((status) => {
      const memory = createMemory({
        id: `mem-${status}`,
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
        status,
      });
      expect(memory.status).toBe(status);
    });
  });

  it('sets timestamps automatically', () => {
    const before = new Date().toISOString();
    const memory = createMemory({
      id: 'mem-9',
      content: 'Content',
      summary: 'Summary',
      memory_type: 'code',
      scope: 'project',
      confidence: 0.5,
      priority: 5,
      source_type: 'code_index',
      source_session: 'session',
      source_context: '{}',
    });
    const after = new Date().toISOString();

    expect(memory.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(memory.created_at >= before).toBe(true);
    expect(memory.created_at <= after).toBe(true);
    expect(memory.updated_at).toBe(memory.created_at);
    expect(memory.last_accessed_at).toBe(memory.created_at);
  });

  it('throws on empty id', () => {
    expect(() =>
      createMemory({
        id: '',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      })
    ).toThrow('id must not be empty');
  });

  it('throws on whitespace-only id', () => {
    expect(() =>
      createMemory({
        id: '   ',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      })
    ).toThrow('id must not be empty');
  });

  it('throws on empty content', () => {
    expect(() =>
      createMemory({
        id: 'mem-1',
        content: '',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      })
    ).toThrow('content must not be empty');
  });

  it('throws on whitespace-only content', () => {
    expect(() =>
      createMemory({
        id: 'mem-1',
        content: '   ',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      })
    ).toThrow('content must not be empty');
  });

  it('throws on empty summary', () => {
    expect(() =>
      createMemory({
        id: 'mem-1',
        content: 'Content',
        summary: '',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      })
    ).toThrow('summary must not be empty');
  });

  it('throws on whitespace-only summary', () => {
    expect(() =>
      createMemory({
        id: 'mem-1',
        content: 'Content',
        summary: '   ',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      })
    ).toThrow('summary must not be empty');
  });

  it('throws on empty source_session', () => {
    expect(() =>
      createMemory({
        id: 'mem-1',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: '',
        source_context: '{}',
      })
    ).toThrow('source_session must not be empty');
  });

  it('throws on whitespace-only source_session', () => {
    expect(() =>
      createMemory({
        id: 'mem-1',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: 5,
        source_type: 'manual',
        source_session: '   ',
        source_context: '{}',
      })
    ).toThrow('source_session must not be empty');
  });

  it('throws on NaN confidence', () => {
    expect(() =>
      createMemory({
        id: 'mem-1',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: NaN,
        priority: 5,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      })
    ).toThrow('confidence must be in [0, 1]');
  });

  it('throws on NaN priority', () => {
    expect(() =>
      createMemory({
        id: 'mem-1',
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: NaN,
        source_type: 'manual',
        source_session: 'session',
        source_context: '{}',
      })
    ).toThrow('priority must be in [1, 10]');
  });

  it('trims whitespace from id, content, summary, and source_session', () => {
    const memory = createMemory({
      id: '  mem-1  ',
      content: '  Content  ',
      summary: '  Summary  ',
      memory_type: 'architecture',
      scope: 'project',
      confidence: 0.5,
      priority: 5,
      source_type: 'manual',
      source_session: '  session  ',
      source_context: '{}',
    });

    expect(memory.id).toBe('mem-1');
    expect(memory.content).toBe('Content');
    expect(memory.summary).toBe('Summary');
    expect(memory.source_session).toBe('session');
  });
});

describe('createEdge', () => {
  it('creates valid edge with all required fields', () => {
    const edge = createEdge({
      id: 'edge-1',
      source_id: 'mem-1',
      target_id: 'mem-2',
      relation_type: 'relates_to',
      strength: 0.7,
    });

    expect(edge.id).toBe('edge-1');
    expect(edge.source_id).toBe('mem-1');
    expect(edge.target_id).toBe('mem-2');
    expect(edge.relation_type).toBe('relates_to');
    expect(edge.strength).toBe(0.7);
    expect(edge.bidirectional).toBe(false);
    expect(edge.status).toBe('active');
  });

  it('creates edge with optional fields', () => {
    const edge = createEdge({
      id: 'edge-2',
      source_id: 'mem-3',
      target_id: 'mem-4',
      relation_type: 'supersedes',
      strength: 1.0,
      bidirectional: true,
      status: 'suggested',
      created_at: '2024-01-01T00:00:00Z',
    });

    expect(edge.bidirectional).toBe(true);
    expect(edge.status).toBe('suggested');
    expect(edge.created_at).toBe('2024-01-01T00:00:00Z');
  });

  it('throws on strength < 0', () => {
    expect(() =>
      createEdge({
        id: 'edge-3',
        source_id: 'mem-5',
        target_id: 'mem-6',
        relation_type: 'derived_from',
        strength: -0.1,
      })
    ).toThrow('strength must be in [0, 1]');
  });

  it('throws on strength > 1', () => {
    expect(() =>
      createEdge({
        id: 'edge-4',
        source_id: 'mem-7',
        target_id: 'mem-8',
        relation_type: 'contradicts',
        strength: 1.5,
      })
    ).toThrow('strength must be in [0, 1]');
  });

  it('throws on invalid relation_type', () => {
    expect(() =>
      createEdge({
        id: 'edge-5',
        source_id: 'mem-9',
        target_id: 'mem-10',
        relation_type: 'invalid' as EdgeRelation,
        strength: 0.5,
      })
    ).toThrow('invalid relation_type');
  });

  it('accepts all valid edge relations', () => {
    EDGE_RELATIONS.forEach((relation) => {
      const edge = createEdge({
        id: `edge-${relation}`,
        source_id: 'mem-a',
        target_id: 'mem-b',
        relation_type: relation,
        strength: 0.5,
      });
      expect(edge.relation_type).toBe(relation);
    });
  });

  it('sets created_at timestamp automatically', () => {
    const before = new Date().toISOString();
    const edge = createEdge({
      id: 'edge-6',
      source_id: 'mem-11',
      target_id: 'mem-12',
      relation_type: 'exemplifies',
      strength: 0.8,
    });
    const after = new Date().toISOString();

    expect(edge.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(edge.created_at >= before).toBe(true);
    expect(edge.created_at <= after).toBe(true);
  });

  it('throws on self-referencing edge', () => {
    expect(() =>
      createEdge({
        id: 'edge-7',
        source_id: 'mem-1',
        target_id: 'mem-1',
        relation_type: 'relates_to',
        strength: 0.5,
      })
    ).toThrow('source_id and target_id must not be equal');
  });

  it('throws on NaN strength', () => {
    expect(() =>
      createEdge({
        id: 'edge-8',
        source_id: 'mem-1',
        target_id: 'mem-2',
        relation_type: 'relates_to',
        strength: NaN,
      })
    ).toThrow('strength must be in [0, 1]');
  });
});

describe('createExtractionCheckpoint', () => {
  it('creates valid checkpoint with all required fields', () => {
    const checkpoint = createExtractionCheckpoint({
      id: 'ckpt-1',
      session_id: 'session-1',
      cursor_position: 100,
    });

    expect(checkpoint.id).toBe('ckpt-1');
    expect(checkpoint.session_id).toBe('session-1');
    expect(checkpoint.cursor_position).toBe(100);
    expect(checkpoint.extracted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates checkpoint with optional extracted_at', () => {
    const checkpoint = createExtractionCheckpoint({
      id: 'ckpt-2',
      session_id: 'session-2',
      cursor_position: 200,
      extracted_at: '2024-01-01T12:00:00Z',
    });

    expect(checkpoint.extracted_at).toBe('2024-01-01T12:00:00Z');
  });

  it('throws on negative cursor_position', () => {
    expect(() =>
      createExtractionCheckpoint({
        id: 'ckpt-3',
        session_id: 'session-3',
        cursor_position: -1,
      })
    ).toThrow('cursor_position must be >= 0');
  });

  it('accepts cursor_position of 0', () => {
    const checkpoint = createExtractionCheckpoint({
      id: 'ckpt-4',
      session_id: 'session-4',
      cursor_position: 0,
    });

    expect(checkpoint.cursor_position).toBe(0);
  });

  it('sets extracted_at timestamp automatically', () => {
    const before = new Date().toISOString();
    const checkpoint = createExtractionCheckpoint({
      id: 'ckpt-5',
      session_id: 'session-5',
      cursor_position: 50,
    });
    const after = new Date().toISOString();

    expect(checkpoint.extracted_at >= before).toBe(true);
    expect(checkpoint.extracted_at <= after).toBe(true);
  });

  it('throws on NaN cursor_position', () => {
    expect(() =>
      createExtractionCheckpoint({
        id: 'ckpt-6',
        session_id: 'session-6',
        cursor_position: NaN,
      })
    ).toThrow('cursor_position must be >= 0');
  });
});

describe('createMemoryCandidate', () => {
  it('creates valid candidate with all required fields', () => {
    const candidate = createMemoryCandidate({
      content: 'Test content',
      summary: 'Test summary',
      memory_type: 'pattern',
      scope: 'project',
      confidence: 0.75,
      priority: 6,
    });

    expect(candidate.content).toBe('Test content');
    expect(candidate.summary).toBe('Test summary');
    expect(candidate.memory_type).toBe('pattern');
    expect(candidate.scope).toBe('project');
    expect(candidate.confidence).toBe(0.75);
    expect(candidate.priority).toBe(6);
    expect(candidate.tags).toEqual([]);
  });

  it('creates candidate with tags', () => {
    const candidate = createMemoryCandidate({
      content: 'Content',
      summary: 'Summary',
      memory_type: 'gotcha',
      scope: 'global',
      confidence: 0.9,
      priority: 9,
      tags: ['important', 'verified'],
    });

    expect(candidate.tags).toEqual(['important', 'verified']);
  });

  it('throws on confidence < 0', () => {
    expect(() =>
      createMemoryCandidate({
        content: 'Content',
        summary: 'Summary',
        memory_type: 'context',
        scope: 'project',
        confidence: -0.1,
        priority: 5,
      })
    ).toThrow('confidence must be in [0, 1]');
  });

  it('throws on confidence > 1', () => {
    expect(() =>
      createMemoryCandidate({
        content: 'Content',
        summary: 'Summary',
        memory_type: 'progress',
        scope: 'project',
        confidence: 1.1,
        priority: 5,
      })
    ).toThrow('confidence must be in [0, 1]');
  });

  it('throws on priority < 1', () => {
    expect(() =>
      createMemoryCandidate({
        content: 'Content',
        summary: 'Summary',
        memory_type: 'code_description',
        scope: 'project',
        confidence: 0.5,
        priority: 0,
      })
    ).toThrow('priority must be in [1, 10]');
  });

  it('throws on priority > 10', () => {
    expect(() =>
      createMemoryCandidate({
        content: 'Content',
        summary: 'Summary',
        memory_type: 'code',
        scope: 'project',
        confidence: 0.5,
        priority: 11,
      })
    ).toThrow('priority must be in [1, 10]');
  });

  it('throws on invalid memory_type', () => {
    expect(() =>
      createMemoryCandidate({
        content: 'Content',
        summary: 'Summary',
        memory_type: 'invalid' as MemoryType,
        scope: 'project',
        confidence: 0.5,
        priority: 5,
      })
    ).toThrow('invalid memory_type');
  });

  it('throws on NaN confidence', () => {
    expect(() =>
      createMemoryCandidate({
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: NaN,
        priority: 5,
      })
    ).toThrow('confidence must be in [0, 1]');
  });

  it('throws on NaN priority', () => {
    expect(() =>
      createMemoryCandidate({
        content: 'Content',
        summary: 'Summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.5,
        priority: NaN,
      })
    ).toThrow('priority must be in [1, 10]');
  });
});

describe('type guards', () => {
  describe('isMemoryType', () => {
    it('returns true for valid memory types', () => {
      MEMORY_TYPES.forEach((type) => {
        expect(isMemoryType(type)).toBe(true);
      });
    });

    it('returns false for invalid strings', () => {
      expect(isMemoryType('invalid')).toBe(false);
      expect(isMemoryType('ARCHITECTURE')).toBe(false);
      expect(isMemoryType('')).toBe(false);
    });

    it('returns false for non-strings', () => {
      expect(isMemoryType(123)).toBe(false);
      expect(isMemoryType(null)).toBe(false);
      expect(isMemoryType(undefined)).toBe(false);
      expect(isMemoryType({})).toBe(false);
      expect(isMemoryType([])).toBe(false);
    });
  });

  describe('isEdgeRelation', () => {
    it('returns true for valid edge relations', () => {
      EDGE_RELATIONS.forEach((relation) => {
        expect(isEdgeRelation(relation)).toBe(true);
      });
    });

    it('returns false for invalid strings', () => {
      expect(isEdgeRelation('invalid')).toBe(false);
      expect(isEdgeRelation('RELATES_TO')).toBe(false);
      expect(isEdgeRelation('')).toBe(false);
    });

    it('returns false for non-strings', () => {
      expect(isEdgeRelation(123)).toBe(false);
      expect(isEdgeRelation(null)).toBe(false);
      expect(isEdgeRelation(undefined)).toBe(false);
      expect(isEdgeRelation({})).toBe(false);
    });
  });

  describe('isMemoryStatus', () => {
    it('returns true for valid memory statuses', () => {
      MEMORY_STATUSES.forEach((status) => {
        expect(isMemoryStatus(status)).toBe(true);
      });
    });

    it('returns false for invalid strings', () => {
      expect(isMemoryStatus('invalid')).toBe(false);
      expect(isMemoryStatus('ACTIVE')).toBe(false);
      expect(isMemoryStatus('')).toBe(false);
    });

    it('returns false for non-strings', () => {
      expect(isMemoryStatus(123)).toBe(false);
      expect(isMemoryStatus(null)).toBe(false);
      expect(isMemoryStatus(undefined)).toBe(false);
    });
  });
});

describe('SimilarityAction discriminated union', () => {
  it('supports ignore action', () => {
    const action: SimilarityAction = { action: 'ignore' };
    expect(action.action).toBe('ignore');
  });

  it('supports relate action with strength', () => {
    const action: SimilarityAction = { action: 'relate', strength: 0.3 };
    expect(action.action).toBe('relate');
    if (action.action === 'relate') {
      expect(action.strength).toBe(0.3);
    }
  });

  it('supports suggest action with strength', () => {
    const action: SimilarityAction = { action: 'suggest', strength: 0.45 };
    expect(action.action).toBe('suggest');
    if (action.action === 'suggest') {
      expect(action.strength).toBe(0.45);
    }
  });

  it('supports consolidate action', () => {
    const action: SimilarityAction = { action: 'consolidate' };
    expect(action.action).toBe('consolidate');
  });
});

// Property-based tests with fast-check
describe('property tests', () => {
  describe('createMemory invariants', () => {
    it('confidence always in [0, 1]', () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1, noNaN: true }),
          fc.integer({ min: 1, max: 10 }),
          (confidence, priority) => {
            const memory = createMemory({
              id: 'test',
              content: 'test',
              summary: 'test',
              memory_type: 'architecture',
              scope: 'project',
              confidence,
              priority,
              source_type: 'manual',
              source_session: 'session',
              source_context: '{}',
            });
            expect(memory.confidence).toBeGreaterThanOrEqual(0);
            expect(memory.confidence).toBeLessThanOrEqual(1);
          }
        )
      );
    });

    it('priority always in [1, 10]', () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1, noNaN: true }),
          fc.integer({ min: 1, max: 10 }),
          (confidence, priority) => {
            const memory = createMemory({
              id: 'test',
              content: 'test',
              summary: 'test',
              memory_type: 'decision',
              scope: 'project',
              confidence,
              priority,
              source_type: 'manual',
              source_session: 'session',
              source_context: '{}',
            });
            expect(memory.priority).toBeGreaterThanOrEqual(1);
            expect(memory.priority).toBeLessThanOrEqual(10);
          }
        )
      );
    });

    it('defaults apply consistently', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...MEMORY_TYPES),
          fc.float({ min: 0, max: 1, noNaN: true }),
          fc.integer({ min: 1, max: 10 }),
          (memoryType, confidence, priority) => {
            const memory = createMemory({
              id: 'test',
              content: 'test',
              summary: 'test',
              memory_type: memoryType,
              scope: 'project',
              confidence,
              priority,
              source_type: 'manual',
              source_session: 'session',
              source_context: '{}',
            });
            expect(memory.pinned).toBe(false);
            expect(memory.tags).toEqual([]);
            expect(memory.access_count).toBe(0);
            expect(memory.status).toBe('active');
            expect(memory.embedding).toBeNull();
            expect(memory.local_embedding).toBeNull();
          }
        )
      );
    });
  });

  describe('createEdge invariants', () => {
    it('strength always in [0, 1]', () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1, noNaN: true }),
          fc.constantFrom(...EDGE_RELATIONS),
          (strength, relationType) => {
            const edge = createEdge({
              id: 'test',
              source_id: 'a',
              target_id: 'b',
              relation_type: relationType,
              strength,
            });
            expect(edge.strength).toBeGreaterThanOrEqual(0);
            expect(edge.strength).toBeLessThanOrEqual(1);
          }
        )
      );
    });

    it('defaults apply consistently', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...EDGE_RELATIONS),
          fc.float({ min: 0, max: 1, noNaN: true }),
          (relationType, strength) => {
            const edge = createEdge({
              id: 'test',
              source_id: 'a',
              target_id: 'b',
              relation_type: relationType,
              strength,
            });
            expect(edge.bidirectional).toBe(false);
            expect(edge.status).toBe('active');
          }
        )
      );
    });
  });

  describe('createExtractionCheckpoint invariants', () => {
    it('cursor_position always >= 0', () => {
      fc.assert(
        fc.property(fc.nat(), (cursorPos) => {
          const checkpoint = createExtractionCheckpoint({
            id: 'test',
            session_id: 'session',
            cursor_position: cursorPos,
          });
          expect(checkpoint.cursor_position).toBeGreaterThanOrEqual(0);
        })
      );
    });
  });

  describe('createMemoryCandidate invariants', () => {
    it('confidence in [0, 1] and priority in [1, 10]', () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1, noNaN: true }),
          fc.integer({ min: 1, max: 10 }),
          fc.constantFrom(...MEMORY_TYPES),
          (confidence, priority, memoryType) => {
            const candidate = createMemoryCandidate({
              content: 'test',
              summary: 'test',
              memory_type: memoryType,
              scope: 'project',
              confidence,
              priority,
            });
            expect(candidate.confidence).toBeGreaterThanOrEqual(0);
            expect(candidate.confidence).toBeLessThanOrEqual(1);
            expect(candidate.priority).toBeGreaterThanOrEqual(1);
            expect(candidate.priority).toBeLessThanOrEqual(10);
          }
        )
      );
    });
  });
});
