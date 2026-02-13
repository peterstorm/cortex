/**
 * Tests for traverse command
 * Uses in-memory SQLite for integration testing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { openDatabase, insertMemory, insertEdge } from '../infra/db.js';
import { createMemory, createEdge } from '../core/types.js';
import { executeTraverse, formatTraverseResult, formatTraverseError } from './traverse.js';

describe('traverse command', () => {
  let db: Database;

  beforeEach(() => {
    // Create fresh in-memory database for each test
    db = openDatabase(':memory:');
  });

  describe('executeTraverse', () => {
    it('should return error if memory not found', () => {
      const result = executeTraverse(db, { id: 'non-existent' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe('memory_not_found');
        expect(result.error.id).toBe('non-existent');
      }
    });

    it('should return error for invalid depth', () => {
      const result = executeTraverse(db, { id: 'any', depth: -1 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe('invalid_depth');
        expect(result.error.value).toBe(-1);
      }
    });

    it('should return error for invalid edge type', () => {
      const result = executeTraverse(db, { id: 'any', edgeTypes: 'invalid_type' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe('invalid_edge_type');
      }
    });

    it('should return error for invalid direction', () => {
      const result = executeTraverse(db, { id: 'any', direction: 'sideways' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe('invalid_direction');
        expect(result.error.value).toBe('sideways');
      }
    });

    it('should return error for invalid min strength', () => {
      const result = executeTraverse(db, { id: 'any', minStrength: 1.5 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe('invalid_min_strength');
        expect(result.error.value).toBe(1.5);
      }
    });

    it('should return start memory with empty results if no edges', () => {
      // Insert single memory with no edges
      const memory = createMemory({
        id: 'm1',
        content: 'Test memory',
        summary: 'Test',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });
      insertMemory(db, memory);

      const result = executeTraverse(db, { id: 'm1' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.start.id).toBe('m1');
        expect(Object.keys(result.result.results)).toHaveLength(0);
      }
    });

    it('should traverse depth 1 with single outgoing edge', () => {
      // Create two memories with edge m1 -> m2
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);

      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', depth: 1 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.start.id).toBe('m1');
        expect(result.result.results[1]).toHaveLength(1);
        expect(result.result.results[1][0].id).toBe('m2');
      }
    });

    it('should traverse depth 2 with chain m1 -> m2 -> m3', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m3 = createMemory({
        id: 'm3',
        content: 'Memory 3',
        summary: 'M3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 3,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);
      insertMemory(db, m3);

      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      insertEdge(db, {
        source_id: 'm2',
        target_id: 'm3',
        relation_type: 'derived_from',
        strength: 0.9,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', depth: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.start.id).toBe('m1');
        expect(result.result.results[1]).toHaveLength(1);
        expect(result.result.results[1][0].id).toBe('m2');
        expect(result.result.results[2]).toHaveLength(1);
        expect(result.result.results[2][0].id).toBe('m3');
      }
    });

    it('should respect depth limit and stop at depth 1', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m3 = createMemory({
        id: 'm3',
        content: 'Memory 3',
        summary: 'M3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 3,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);
      insertMemory(db, m3);

      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      insertEdge(db, {
        source_id: 'm2',
        target_id: 'm3',
        relation_type: 'derived_from',
        strength: 0.9,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', depth: 1 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.start.id).toBe('m1');
        expect(result.result.results[1]).toHaveLength(1);
        expect(result.result.results[1][0].id).toBe('m2');
        expect(result.result.results[2]).toBeUndefined(); // Should not reach depth 2
      }
    });

    it('should filter by edge type', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m3 = createMemory({
        id: 'm3',
        content: 'Memory 3',
        summary: 'M3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 3,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);
      insertMemory(db, m3);

      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm3',
        relation_type: 'derived_from',
        strength: 0.9,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', edgeTypes: 'derived_from' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.results[1]).toHaveLength(1);
        expect(result.result.results[1][0].id).toBe('m3'); // Only m3 via derived_from
      }
    });

    it('should filter by multiple edge types', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m3 = createMemory({
        id: 'm3',
        content: 'Memory 3',
        summary: 'M3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 3,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m4 = createMemory({
        id: 'm4',
        content: 'Memory 4',
        summary: 'M4',
        memory_type: 'gotcha',
        scope: 'project',
        confidence: 0.6,
        priority: 2,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);
      insertMemory(db, m3);
      insertMemory(db, m4);

      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm3',
        relation_type: 'derived_from',
        strength: 0.9,
        bidirectional: false,
        status: 'active',
      });

      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm4',
        relation_type: 'supersedes',
        strength: 0.7,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', edgeTypes: 'relates_to,derived_from' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.results[1]).toHaveLength(2);
        const ids = result.result.results[1].map(m => m.id).sort();
        expect(ids).toEqual(['m2', 'm3']);
      }
    });

    it('should filter by direction: outgoing only', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m3 = createMemory({
        id: 'm3',
        content: 'Memory 3',
        summary: 'M3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 3,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);
      insertMemory(db, m3);

      // m1 -> m2 (outgoing from m1)
      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      // m3 -> m1 (incoming to m1)
      insertEdge(db, {
        source_id: 'm3',
        target_id: 'm1',
        relation_type: 'derived_from',
        strength: 0.9,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', direction: 'outgoing' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.results[1]).toHaveLength(1);
        expect(result.result.results[1][0].id).toBe('m2'); // Only outgoing edge
      }
    });

    it('should filter by direction: incoming only', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m3 = createMemory({
        id: 'm3',
        content: 'Memory 3',
        summary: 'M3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 3,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);
      insertMemory(db, m3);

      // m1 -> m2 (outgoing from m1)
      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      // m3 -> m1 (incoming to m1)
      insertEdge(db, {
        source_id: 'm3',
        target_id: 'm1',
        relation_type: 'derived_from',
        strength: 0.9,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', direction: 'incoming' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.results[1]).toHaveLength(1);
        expect(result.result.results[1][0].id).toBe('m3'); // Only incoming edge
      }
    });

    it('should filter by direction: both (default)', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m3 = createMemory({
        id: 'm3',
        content: 'Memory 3',
        summary: 'M3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 3,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);
      insertMemory(db, m3);

      // m1 -> m2 (outgoing from m1)
      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      // m3 -> m1 (incoming to m1)
      insertEdge(db, {
        source_id: 'm3',
        target_id: 'm1',
        relation_type: 'derived_from',
        strength: 0.9,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1' }); // No direction specified

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.results[1]).toHaveLength(2);
        const ids = result.result.results[1].map(m => m.id).sort();
        expect(ids).toEqual(['m2', 'm3']);
      }
    });

    it('should filter by minimum strength', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m3 = createMemory({
        id: 'm3',
        content: 'Memory 3',
        summary: 'M3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 3,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);
      insertMemory(db, m3);

      // Strong edge
      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.9,
        bidirectional: false,
        status: 'active',
      });

      // Weak edge
      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm3',
        relation_type: 'relates_to',
        strength: 0.3,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', minStrength: 0.5 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.results[1]).toHaveLength(1);
        expect(result.result.results[1][0].id).toBe('m2'); // Only strong edge
      }
    });

    it('should prevent cycles in traversal', () => {
      const m1 = createMemory({
        id: 'm1',
        content: 'Memory 1',
        summary: 'M1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const m2 = createMemory({
        id: 'm2',
        content: 'Memory 2',
        summary: 'M2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 4,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      insertMemory(db, m1);
      insertMemory(db, m2);

      // Create cycle: m1 -> m2 -> m1
      insertEdge(db, {
        source_id: 'm1',
        target_id: 'm2',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      insertEdge(db, {
        source_id: 'm2',
        target_id: 'm1',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      const result = executeTraverse(db, { id: 'm1', depth: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        // Should visit m2 at depth 1, but not revisit m1 at depth 2
        expect(result.result.results[1]).toHaveLength(1);
        expect(result.result.results[1][0].id).toBe('m2');
        expect(result.result.results[2]).toBeUndefined(); // Cycle prevented
      }
    });
  });

  describe('formatTraverseResult', () => {
    it('should format result as JSON', () => {
      const memory = createMemory({
        id: 'm1',
        content: 'Test',
        summary: 'Test',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'manual',
        source_session: 'test',
        source_context: '{}',
      });

      const result = {
        start: memory,
        results: {},
      };

      const formatted = formatTraverseResult(result);
      expect(formatted).toContain('"id": "m1"');
      expect(formatted).toContain('"results": {}');
    });
  });

  describe('formatTraverseError', () => {
    it('should format memory_not_found error', () => {
      const error = { type: 'memory_not_found' as const, id: 'm1' };
      const formatted = formatTraverseError(error);
      expect(formatted).toBe('Memory not found: m1');
    });

    it('should format invalid_depth error', () => {
      const error = { type: 'invalid_depth' as const, value: -1 };
      const formatted = formatTraverseError(error);
      expect(formatted).toContain('Invalid depth');
      expect(formatted).toContain('-1');
    });

    it('should format invalid_edge_type error', () => {
      const error = { type: 'invalid_edge_type' as const, value: 'invalid' };
      const formatted = formatTraverseError(error);
      expect(formatted).toContain('Invalid edge type');
    });

    it('should format invalid_direction error', () => {
      const error = { type: 'invalid_direction' as const, value: 'sideways' };
      const formatted = formatTraverseError(error);
      expect(formatted).toContain('Invalid direction');
    });

    it('should format invalid_min_strength error', () => {
      const error = { type: 'invalid_min_strength' as const, value: 1.5 };
      const formatted = formatTraverseError(error);
      expect(formatted).toContain('Invalid min strength');
    });
  });
});
