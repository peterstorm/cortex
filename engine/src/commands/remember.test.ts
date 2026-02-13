import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseRememberArgs,
  buildMemoryFromArgs,
  formatSuccessResult,
  formatErrorResult,
  executeRemember,
  type RememberArgs,
} from './remember.js';
import { openDatabase } from '../infra/db.js';
import { getMemory } from '../infra/db.js';
import type { Database } from 'bun:sqlite';

describe('Remember Command', () => {
  // ============================================================================
  // FUNCTIONAL CORE TESTS - Pure functions, no mocks needed
  // ============================================================================

  describe('parseRememberArgs', () => {
    const sessionId = 'test-session-123';

    it('parses minimal args with defaults', () => {
      const result = parseRememberArgs(['test content'], sessionId);

      expect(result.success).toBe(true);
      expect(result.args).toEqual({
        content: 'test content',
        type: 'context',
        priority: 5,
        scope: 'project',
        pinned: false,
        tags: [],
        sessionId,
      });
    });

    it('parses all options', () => {
      const result = parseRememberArgs(
        [
          'important decision about architecture',
          '--type=decision',
          '--priority=9',
          '--scope=global',
          '--pinned',
          '--tags=architecture,database,critical',
        ],
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.args).toEqual({
        content: 'important decision about architecture',
        type: 'decision',
        priority: 9,
        scope: 'global',
        pinned: true,
        tags: ['architecture', 'database', 'critical'],
        sessionId,
      });
    });

    it('trims whitespace from tags', () => {
      const result = parseRememberArgs(
        ['content', '--tags=  tag1  , tag2  ,  tag3  '],
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.args?.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('filters empty tags', () => {
      const result = parseRememberArgs(
        ['content', '--tags=tag1,,tag2,  ,tag3'],
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.args?.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('rejects empty content', () => {
      const result = parseRememberArgs([''], sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('content must not be empty');
    });

    it('rejects whitespace-only content', () => {
      const result = parseRememberArgs(['   '], sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('content must not be empty');
    });

    it('rejects missing content', () => {
      const result = parseRememberArgs([], sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('content is required');
    });

    it('rejects invalid memory type', () => {
      const result = parseRememberArgs(
        ['content', '--type=invalid'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid memory type');
      expect(result.error).toContain('invalid');
    });

    it('rejects priority below 1', () => {
      const result = parseRememberArgs(
        ['content', '--priority=0'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('priority must be between 1-10');
    });

    it('rejects priority above 10', () => {
      const result = parseRememberArgs(
        ['content', '--priority=11'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('priority must be between 1-10');
    });

    it('rejects non-numeric priority', () => {
      const result = parseRememberArgs(
        ['content', '--priority=high'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('priority must be between 1-10');
    });

    it('rejects invalid scope', () => {
      const result = parseRememberArgs(
        ['content', '--scope=invalid'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("scope must be 'project' or 'global'");
    });

    it('rejects unknown option', () => {
      const result = parseRememberArgs(
        ['content', '--unknown=value'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('unknown option: --unknown=value');
    });

    it('accepts all valid memory types', () => {
      const types = [
        'architecture',
        'decision',
        'pattern',
        'gotcha',
        'context',
        'progress',
        'code_description',
        'code',
      ] as const;

      for (const type of types) {
        const result = parseRememberArgs(
          ['content', `--type=${type}`],
          sessionId
        );

        expect(result.success).toBe(true);
        expect(result.args?.type).toBe(type);
      }
    });
  });

  describe('buildMemoryFromArgs', () => {
    it('builds valid Memory with all fields', () => {
      const args: RememberArgs = {
        content: 'test memory content',
        type: 'decision',
        priority: 8,
        scope: 'global',
        pinned: true,
        tags: ['tag1', 'tag2'],
        sessionId: 'session-123',
      };

      const memory = buildMemoryFromArgs(args);

      // Validate structure
      expect(memory.id).toBeTruthy();
      expect(memory.content).toBe('test memory content');
      expect(memory.summary).toBe('test memory content');
      expect(memory.memory_type).toBe('decision');
      expect(memory.scope).toBe('global');
      expect(memory.confidence).toBe(1.0);
      expect(memory.priority).toBe(8);
      expect(memory.pinned).toBe(true);
      expect(memory.source_type).toBe('manual');
      expect(memory.source_session).toBe('session-123');
      expect(memory.tags).toEqual(['tag1', 'tag2']);
      expect(memory.status).toBe('active');

      // Embeddings should be null (queued for backfill per FR-045)
      expect(memory.embedding).toBeNull();
      expect(memory.local_embedding).toBeNull();

      // Timestamps should be valid ISO8601
      expect(() => new Date(memory.created_at)).not.toThrow();
      expect(() => new Date(memory.updated_at)).not.toThrow();
      expect(() => new Date(memory.last_accessed_at)).not.toThrow();

      // Source context should be valid JSON
      const sourceContext = JSON.parse(memory.source_context);
      expect(sourceContext.source).toBe('manual');
      expect(sourceContext.session_id).toBe('session-123');
    });

    it('generates summary from long content', () => {
      const longContent = 'a'.repeat(250);
      const args: RememberArgs = {
        content: longContent,
        type: 'context',
        priority: 5,
        scope: 'project',
        pinned: false,
        tags: [],
        sessionId: 'session-123',
      };

      const memory = buildMemoryFromArgs(args);

      expect(memory.summary.length).toBe(200);
      expect(memory.summary).toBe('a'.repeat(197) + '...');
      expect(memory.content).toBe(longContent);
    });

    it('uses full content as summary when under 200 chars', () => {
      const shortContent = 'short content';
      const args: RememberArgs = {
        content: shortContent,
        type: 'context',
        priority: 5,
        scope: 'project',
        pinned: false,
        tags: [],
        sessionId: 'session-123',
      };

      const memory = buildMemoryFromArgs(args);

      expect(memory.summary).toBe(shortContent);
      expect(memory.content).toBe(shortContent);
    });

    it('generates unique IDs for multiple calls', () => {
      const args: RememberArgs = {
        content: 'test',
        type: 'context',
        priority: 5,
        scope: 'project',
        pinned: false,
        tags: [],
        sessionId: 'session-123',
      };

      const mem1 = buildMemoryFromArgs(args);
      const mem2 = buildMemoryFromArgs(args);

      expect(mem1.id).not.toBe(mem2.id);
    });

    it('sets confidence to 1.0 for explicit memories', () => {
      const args: RememberArgs = {
        content: 'test',
        type: 'context',
        priority: 5,
        scope: 'project',
        pinned: false,
        tags: [],
        sessionId: 'session-123',
      };

      const memory = buildMemoryFromArgs(args);

      expect(memory.confidence).toBe(1.0);
    });
  });

  describe('formatSuccessResult', () => {
    it('formats success result with all details', () => {
      const memory = buildMemoryFromArgs({
        content: 'test',
        type: 'decision',
        priority: 8,
        scope: 'global',
        pinned: true,
        tags: [],
        sessionId: 'session-123',
      });

      const result = formatSuccessResult(memory);

      expect(result.success).toBe(true);
      expect(result.memory_id).toBe(memory.id);
      expect(result.scope).toBe('global');
      expect(result.message).toContain('global scope');
      expect(result.message).toContain('priority 8');
      expect(result.message).toContain('pinned');
    });

    it('formats success result without pinned flag', () => {
      const memory = buildMemoryFromArgs({
        content: 'test',
        type: 'context',
        priority: 5,
        scope: 'project',
        pinned: false,
        tags: [],
        sessionId: 'session-123',
      });

      const result = formatSuccessResult(memory);

      expect(result.success).toBe(true);
      expect(result.message).toContain('project scope');
      expect(result.message).toContain('priority 5');
      expect(result.message).not.toContain('pinned');
    });
  });

  describe('formatErrorResult', () => {
    it('formats error result', () => {
      const result = formatErrorResult('test error message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('test error message');
    });
  });

  // ============================================================================
  // IMPERATIVE SHELL TESTS - Integration with database
  // ============================================================================

  describe('executeRemember', () => {
    let projectDb: Database;
    let globalDb: Database;
    const sessionId = 'test-session-123';

    beforeEach(() => {
      projectDb = openDatabase(':memory:');
      globalDb = openDatabase(':memory:');
    });

    it('creates memory in project database with defaults', () => {
      const result = executeRemember(
        ['test content'],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Verify memory was inserted
      const memory = getMemory(projectDb, result.memory_id);
      expect(memory).toBeTruthy();
      expect(memory?.content).toBe('test content');
      expect(memory?.memory_type).toBe('context');
      expect(memory?.priority).toBe(5);
      expect(memory?.scope).toBe('project');
      expect(memory?.pinned).toBe(false);
      expect(memory?.embedding).toBeNull();
      expect(memory?.local_embedding).toBeNull();
    });

    it('creates memory in global database when scope=global', () => {
      const result = executeRemember(
        ['global memory', '--scope=global'],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Verify memory was NOT inserted in project DB
      const projectMemory = getMemory(projectDb, result.memory_id);
      expect(projectMemory).toBeNull();

      // Verify memory WAS inserted in global DB
      const globalMemory = getMemory(globalDb, result.memory_id);
      expect(globalMemory).toBeTruthy();
      expect(globalMemory?.content).toBe('global memory');
      expect(globalMemory?.scope).toBe('global');
    });

    it('creates memory with all options', () => {
      const result = executeRemember(
        [
          'important decision',
          '--type=decision',
          '--priority=9',
          '--scope=global',
          '--pinned',
          '--tags=critical,architecture',
        ],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const memory = getMemory(globalDb, result.memory_id);
      expect(memory).toBeTruthy();
      expect(memory?.content).toBe('important decision');
      expect(memory?.memory_type).toBe('decision');
      expect(memory?.priority).toBe(9);
      expect(memory?.scope).toBe('global');
      expect(memory?.pinned).toBe(true);
      expect(memory?.tags).toEqual(['critical', 'architecture']);
    });

    it('returns error for invalid args', () => {
      const result = executeRemember(
        ['content', '--type=invalid'],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('invalid memory type');
    });

    it('returns error for empty content', () => {
      const result = executeRemember(
        [''],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('content must not be empty');
    });

    it('returns error for missing content', () => {
      const result = executeRemember(
        [],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('content is required');
    });

    it('queues embeddings for backfill (null embeddings)', () => {
      const result = executeRemember(
        ['test content'],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const memory = getMemory(projectDb, result.memory_id);
      expect(memory).toBeTruthy();

      // FR-045: Embeddings queued (null) for backfill
      expect(memory?.embedding).toBeNull();
      expect(memory?.local_embedding).toBeNull();
    });

    it('sets source_type to manual', () => {
      const result = executeRemember(
        ['test content'],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const memory = getMemory(projectDb, result.memory_id);
      expect(memory?.source_type).toBe('manual');
    });

    it('stores session_id in source fields', () => {
      const result = executeRemember(
        ['test content'],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const memory = getMemory(projectDb, result.memory_id);
      expect(memory?.source_session).toBe(sessionId);

      const sourceContext = JSON.parse(memory?.source_context ?? '{}');
      expect(sourceContext.session_id).toBe(sessionId);
    });

    it('creates active status memory', () => {
      const result = executeRemember(
        ['test content'],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const memory = getMemory(projectDb, result.memory_id);
      expect(memory?.status).toBe('active');
    });
  });
});
