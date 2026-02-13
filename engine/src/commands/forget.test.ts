/**
 * Tests for forget command
 * Uses in-memory SQLite for integration testing
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { openDatabase, insertMemory } from '../infra/db.js';
import { createMemory } from '../core/types.js';
import { forgetById, forgetByQuery, forgetByIds } from './forget.js';

describe('forget command', () => {
  let db: Database;

  beforeEach(() => {
    // Create fresh in-memory database for each test
    db = openDatabase(':memory:');
  });

  describe('forgetById', () => {
    test('archives memory by ID and returns archived status', () => {
      // Arrange: Insert test memory
      const memory = createMemory({
        id: 'mem-1',
        content: 'Test content',
        summary: 'Test summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        tags: ['test'],
        status: 'active',
      });
      insertMemory(db, memory);

      // Act: Archive memory
      const result = forgetById(db, 'mem-1');

      // Assert: Returns archived status
      expect(result).toEqual({
        status: 'archived',
        memoryId: 'mem-1',
        summary: 'Test summary',
      });

      // Verify memory status updated in DB
      const stmt = db.prepare('SELECT status FROM memories WHERE id = ?');
      const row = stmt.get('mem-1') as any;
      expect(row.status).toBe('archived');
    });

    test('returns not_found for non-existent memory', () => {
      // Act: Try to archive non-existent memory
      const result = forgetById(db, 'non-existent');

      // Assert: Returns not_found status
      expect(result).toEqual({
        status: 'not_found',
        memoryId: 'non-existent',
      });
    });

    test('can archive already archived memory (idempotent)', () => {
      // Arrange: Insert archived memory
      const memory = createMemory({
        id: 'mem-1',
        content: 'Test content',
        summary: 'Test summary',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'archived',
      });
      insertMemory(db, memory);

      // Act: Archive again
      const result = forgetById(db, 'mem-1');

      // Assert: Returns archived status (idempotent)
      expect(result).toEqual({
        status: 'archived',
        memoryId: 'mem-1',
        summary: 'Test summary',
      });
    });
  });

  describe('forgetByQuery', () => {
    test('returns candidates matching fuzzy query', () => {
      // Arrange: Insert test memories
      const mem1 = createMemory({
        id: 'mem-1',
        content: 'TypeScript patterns for functional programming',
        summary: 'FP patterns in TS',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
      });
      const mem2 = createMemory({
        id: 'mem-2',
        content: 'React TypeScript component patterns',
        summary: 'React TS patterns',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
      });
      insertMemory(db, mem1);
      insertMemory(db, mem2);

      // Act: Search for TypeScript patterns
      const result = forgetByQuery(db, 'TypeScript patterns', 10);

      // Assert: Returns candidates
      expect(result.status).toBe('candidates');
      if (result.status === 'candidates') {
        expect(result.memories).toHaveLength(2);
        expect(result.memories[0]).toMatchObject({
          id: expect.any(String),
          summary: expect.any(String),
          memory_type: 'pattern',
          scope: 'project',
        });
      }
    });

    test('excludes archived memories from candidates', () => {
      // Arrange: Insert active and archived memories
      const activeMemory = createMemory({
        id: 'mem-active',
        content: 'TypeScript patterns',
        summary: 'Active pattern',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
      });
      const archivedMemory = createMemory({
        id: 'mem-archived',
        content: 'TypeScript patterns',
        summary: 'Archived pattern',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'archived',
      });
      insertMemory(db, activeMemory);
      insertMemory(db, archivedMemory);

      // Act: Search for patterns
      const result = forgetByQuery(db, 'TypeScript patterns', 10);

      // Assert: Only active memory returned
      expect(result.status).toBe('candidates');
      if (result.status === 'candidates') {
        expect(result.memories).toHaveLength(1);
        expect(result.memories[0].id).toBe('mem-active');
        expect(result.memories[0].summary).toBe('Active pattern');
      }
    });

    test('returns empty candidates when no matches found', () => {
      // Arrange: Insert unrelated memory
      const memory = createMemory({
        id: 'mem-1',
        content: 'Unrelated content about databases',
        summary: 'Database patterns',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
      });
      insertMemory(db, memory);

      // Act: Search for TypeScript (no match)
      const result = forgetByQuery(db, 'TypeScript', 10);

      // Assert: Returns empty candidates
      expect(result.status).toBe('candidates');
      if (result.status === 'candidates') {
        expect(result.memories).toHaveLength(0);
      }
    });

    test('respects limit parameter', () => {
      // Arrange: Insert multiple memories
      for (let i = 1; i <= 5; i++) {
        const memory = createMemory({
          id: `mem-${i}`,
          content: `TypeScript pattern ${i}`,
          summary: `Pattern ${i}`,
          memory_type: 'pattern',
          scope: 'project',
          confidence: 0.9,
          priority: 8,
          source_type: 'extraction',
          source_session: 'session-1',
          source_context: '{}',
          status: 'active',
        });
        insertMemory(db, memory);
      }

      // Act: Search with limit=3
      const result = forgetByQuery(db, 'TypeScript', 3);

      // Assert: Returns at most 3 candidates
      expect(result.status).toBe('candidates');
      if (result.status === 'candidates') {
        expect(result.memories.length).toBeLessThanOrEqual(3);
      }
    });

    test('candidate includes all required fields', () => {
      // Arrange: Insert test memory
      const memory = createMemory({
        id: 'mem-1',
        content: 'TypeScript patterns',
        summary: 'FP patterns in TS',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
      });
      insertMemory(db, memory);

      // Act: Search
      const result = forgetByQuery(db, 'TypeScript', 10);

      // Assert: Candidate has all required fields
      expect(result.status).toBe('candidates');
      if (result.status === 'candidates') {
        expect(result.memories[0]).toEqual({
          id: 'mem-1',
          summary: 'FP patterns in TS',
          memory_type: 'pattern',
          scope: 'project',
          created_at: '2026-01-01T00:00:00.000Z',
        });
      }
    });
  });

  describe('forgetByIds', () => {
    test('archives multiple memories by IDs', () => {
      // Arrange: Insert test memories
      const mem1 = createMemory({
        id: 'mem-1',
        content: 'Content 1',
        summary: 'Summary 1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
      });
      const mem2 = createMemory({
        id: 'mem-2',
        content: 'Content 2',
        summary: 'Summary 2',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
      });
      insertMemory(db, mem1);
      insertMemory(db, mem2);

      // Act: Archive both memories
      const results = forgetByIds(db, ['mem-1', 'mem-2']);

      // Assert: Both archived
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        status: 'archived',
        memoryId: 'mem-1',
        summary: 'Summary 1',
      });
      expect(results[1]).toEqual({
        status: 'archived',
        memoryId: 'mem-2',
        summary: 'Summary 2',
      });

      // Verify both archived in DB
      const stmt = db.prepare('SELECT id, status FROM memories WHERE id IN (?, ?)');
      const rows = stmt.all('mem-1', 'mem-2') as any[];
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.status === 'archived')).toBe(true);
    });

    test('handles mix of existing and non-existing IDs', () => {
      // Arrange: Insert one memory
      const memory = createMemory({
        id: 'mem-1',
        content: 'Content 1',
        summary: 'Summary 1',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
      });
      insertMemory(db, memory);

      // Act: Try to archive existing + non-existing
      const results = forgetByIds(db, ['mem-1', 'non-existent']);

      // Assert: Returns results for both
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        status: 'archived',
        memoryId: 'mem-1',
        summary: 'Summary 1',
      });
      expect(results[1]).toEqual({
        status: 'not_found',
        memoryId: 'non-existent',
      });
    });

    test('handles empty ID array', () => {
      // Act: Archive empty array
      const results = forgetByIds(db, []);

      // Assert: Returns empty results
      expect(results).toHaveLength(0);
    });
  });

  describe('integration: forget workflow', () => {
    test('complete workflow: query -> confirm -> archive', () => {
      // Arrange: Insert test memories
      const mem1 = createMemory({
        id: 'mem-1',
        content: 'Old pattern no longer used',
        summary: 'Deprecated pattern',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: '{}',
        status: 'active',
      });
      insertMemory(db, mem1);

      // Step 1: Query for candidates
      const queryResult = forgetByQuery(db, 'Deprecated', 10);
      expect(queryResult.status).toBe('candidates');

      if (queryResult.status === 'candidates') {
        expect(queryResult.memories).toHaveLength(1);
        const candidate = queryResult.memories[0];

        // Step 2: User confirms, archive by ID
        const archiveResult = forgetById(db, candidate.id);
        expect(archiveResult.status).toBe('archived');

        // Step 3: Verify archived
        const verifyStmt = db.prepare('SELECT status FROM memories WHERE id = ?');
        const row = verifyStmt.get('mem-1') as any;
        expect(row.status).toBe('archived');

        // Step 4: Verify excluded from future queries
        const queryAgain = forgetByQuery(db, 'Deprecated', 10);
        expect(queryAgain.status).toBe('candidates');
        if (queryAgain.status === 'candidates') {
          expect(queryAgain.memories).toHaveLength(0);
        }
      }
    });
  });
});
