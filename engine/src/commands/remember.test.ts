import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseRememberArgs,
  buildMemoryFromArgs,
  formatSuccessResult,
  formatErrorResult,
  executeRemember,
  findDuplicate,
  type RememberArgs,
} from './remember.js';
import { openDatabase, getMemory, insertMemory } from '../infra/db.js';
import { createMemory } from '../core/types.js';
import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';

describe('Remember Command', () => {
  // ============================================================================
  // FUNCTIONAL CORE TESTS - Pure functions, no mocks needed
  // ============================================================================

  describe('parseRememberArgs', () => {
    const sessionId = 'test-session-123';

    it('parses minimal args with defaults', async () => {
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

    it('parses all options', async () => {
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

    it('trims whitespace from tags', async () => {
      const result = parseRememberArgs(
        ['content', '--tags=  tag1  , tag2  ,  tag3  '],
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.args?.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('filters empty tags', async () => {
      const result = parseRememberArgs(
        ['content', '--tags=tag1,,tag2,  ,tag3'],
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.args?.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('rejects empty content', async () => {
      const result = parseRememberArgs([''], sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('content must not be empty');
    });

    it('rejects whitespace-only content', async () => {
      const result = parseRememberArgs(['   '], sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('content must not be empty');
    });

    it('rejects missing content', async () => {
      const result = parseRememberArgs([], sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('content is required');
    });

    it('rejects invalid memory type', async () => {
      const result = parseRememberArgs(
        ['content', '--type=invalid'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid memory type');
      expect(result.error).toContain('invalid');
    });

    it('rejects priority below 1', async () => {
      const result = parseRememberArgs(
        ['content', '--priority=0'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('priority must be between 1-10');
    });

    it('rejects priority above 10', async () => {
      const result = parseRememberArgs(
        ['content', '--priority=11'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('priority must be between 1-10');
    });

    it('rejects non-numeric priority', async () => {
      const result = parseRememberArgs(
        ['content', '--priority=high'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('priority must be between 1-10');
    });

    it('rejects invalid scope', async () => {
      const result = parseRememberArgs(
        ['content', '--scope=invalid'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("scope must be 'project' or 'global'");
    });

    it('rejects unknown option', async () => {
      const result = parseRememberArgs(
        ['content', '--unknown=value'],
        sessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('unknown option: --unknown=value');
    });

    it('accepts all valid memory types', async () => {
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
    it('builds valid Memory with all fields', async () => {
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

    it('generates summary from long content', async () => {
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

    it('uses full content as summary when under 200 chars', async () => {
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

    it('generates unique IDs for multiple calls', async () => {
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

    it('sets confidence to 1.0 for explicit memories', async () => {
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
    it('formats success result with all details', async () => {
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

    it('formats success result without pinned flag', async () => {
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
    it('formats error result', async () => {
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

    it('creates memory in project database with defaults', async () => {
      const result = await executeRemember(
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

    it('creates memory in global database when scope=global', async () => {
      const result = await executeRemember(
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

    it('creates memory with all options', async () => {
      const result = await executeRemember(
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

    it('returns error for invalid args', async () => {
      const result = await executeRemember(
        ['content', '--type=invalid'],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('invalid memory type');
    });

    it('returns error for empty content', async () => {
      const result = await executeRemember(
        [''],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('content must not be empty');
    });

    it('returns error for missing content', async () => {
      const result = await executeRemember(
        [],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('content is required');
    });

    it('queues embeddings for backfill (null embeddings)', async () => {
      const result = await executeRemember(
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

    it('sets source_type to manual', async () => {
      const result = await executeRemember(
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

    it('stores session_id in source fields', async () => {
      const result = await executeRemember(
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

    it('creates active status memory', async () => {
      const result = await executeRemember(
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

  describe('executeRemember — cosine dedup via injectable embedFn', () => {
    let projectDb: Database;
    let globalDb: Database;
    const sessionId = 'test-session-embed';
    const now = new Date().toISOString();

    // Paraphrased pair: same meaning, mostly different vocabulary — Jaccard
    // alone stays below the dedup threshold, only cosine catches it.
    const existingContent = 'Always run the migration script before deploying to production';
    const paraphrasedContent = 'Execute DB migrations first whenever shipping a release';

    function insertExistingWithEmbedding(embedding: Float32Array): void {
      const existing = createMemory({
        id: 'existing-mem-1',
        content: existingContent,
        summary: existingContent,
        memory_type: 'gotcha',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 'older-session',
        source_context: '{}',
        local_embedding: embedding,
        last_accessed_at: now,
        created_at: now,
        updated_at: now,
      });
      insertMemory(projectDb, existing);
    }

    beforeEach(() => {
      projectDb = openDatabase(':memory:');
      globalDb = openDatabase(':memory:');
    });

    it('catches a paraphrased duplicate via the cosine path (Jaccard alone would not)', async () => {
      insertExistingWithEmbedding(new Float32Array([0.8, 0.1, 0.05, 0.05]));

      // Sanity: Jaccard-only dedup does NOT flag the paraphrase
      const jaccardOnly = findDuplicate(paraphrasedContent, paraphrasedContent, [
        createMemory({
          id: 'jaccard-check',
          content: existingContent,
          summary: existingContent,
          memory_type: 'gotcha',
          scope: 'project',
          confidence: 0.9,
          priority: 5,
          source_type: 'extraction',
          source_session: 's',
          source_context: '{}',
        }),
      ]);
      expect(jaccardOnly).toBeNull();

      // Near-identical vector for the paraphrase -> cosine ~1 >= threshold
      const embedFn = async () => new Float32Array([0.79, 0.11, 0.05, 0.05]);

      const result = await executeRemember(
        [paraphrasedContent],
        sessionId,
        projectDb,
        globalDb,
        { embedFn, projectName: 'test-project' }
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('near-duplicate');
      expect(result.error).toContain(existingContent);
    });

    it('without embedFn the same paraphrase is inserted (Jaccard-only path)', async () => {
      insertExistingWithEmbedding(new Float32Array([0.8, 0.1, 0.05, 0.05]));

      const result = await executeRemember(
        [paraphrasedContent],
        sessionId,
        projectDb,
        globalDb
      );

      expect(result.success).toBe(true);
    });

    it('degrades gracefully to Jaccard-only when embedFn throws', async () => {
      insertExistingWithEmbedding(new Float32Array([0.8, 0.1, 0.05, 0.05]));

      const embedFn = async (): Promise<Float32Array> => {
        throw new Error('ONNX runtime unavailable');
      };

      const result = await executeRemember(
        [paraphrasedContent],
        sessionId,
        projectDb,
        globalDb,
        { embedFn, projectName: 'test-project' }
      );

      // No crash — falls back to Jaccard, which does not flag the paraphrase
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(getMemory(projectDb, result.memory_id)).not.toBeNull();
    });

    it('still detects exact duplicates via Jaccard when embedFn throws', async () => {
      insertExistingWithEmbedding(new Float32Array([0.8, 0.1, 0.05, 0.05]));

      const embedFn = async (): Promise<Float32Array> => {
        throw new Error('embedder down');
      };

      const result = await executeRemember(
        [existingContent], // verbatim duplicate
        sessionId,
        projectDb,
        globalDb,
        { embedFn, projectName: 'test-project' }
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('near-duplicate');
    });
  });

  describe('findDuplicate', () => {
    const now = new Date().toISOString();

    function makeMemory(overrides: Partial<Memory>): Memory {
      return createMemory({
        id: 'test-id',
        content: 'default content',
        summary: 'default content',
        memory_type: 'context',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        pinned: false,
        source_type: 'extraction',
        source_session: 'sess',
        source_context: '{}',
        tags: [],
        embedding: null,
        local_embedding: null,
        access_count: 0,
        last_accessed_at: now,
        created_at: now,
        updated_at: now,
        status: 'active',
        ...overrides,
      });
    }

    it('detects exact duplicate content', async () => {
      const existing = [makeMemory({
        summary: 'Use Redux for state management',
        content: 'Use Redux for state management in the application',
      })];

      const result = findDuplicate(
        'Use Redux for state management in the application',
        'Use Redux for state management in the application',
        existing
      );

      expect(result).not.toBeNull();
    });

    it('symmetric tokenization: matches when content equals existing', async () => {
      // Regression test for the asymmetric tokenization bug
      const content = 'Prefer functional patterns over OOP in all modules';
      const existing = [makeMemory({
        summary: content,
        content: content,
      })];

      const result = findDuplicate(content, content, existing);
      expect(result).not.toBeNull();
    });

    it('returns null for unrelated content', async () => {
      const existing = [makeMemory({
        summary: 'Database optimization techniques for PostgreSQL',
        content: 'Database optimization techniques for PostgreSQL queries',
      })];

      const result = findDuplicate(
        'CSS grid layout patterns for responsive design',
        'CSS grid layout patterns for responsive design',
        existing
      );

      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// Regression test: finding 1b — remember invalidates the surface cache
// ============================================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

describe('remember surface cache invalidation (finding 1b)', () => {
  it('invalidates cached surfaces after a successful insert', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cortex-remember-regress-'));
    try {
      const cacheDir = nodePath.join(tempDir, '.memory', 'surface-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(nodePath.join(cacheDir, 'stale.json'), '{"surface":"stale"}', 'utf8');

      const result = await executeRemember(
        ['Fresh explicit memory about connection pooling'],
        'session-1',
        projectDb,
        globalDb,
        { cwd: tempDir }
      );

      expect(result.success).toBe(true);
      expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))).toHaveLength(0);
    } finally {
      projectDb.close();
      globalDb.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not invalidate when the insert is rejected as duplicate', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cortex-remember-regress-'));
    try {
      const cacheDir = nodePath.join(tempDir, '.memory', 'surface-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(nodePath.join(cacheDir, 'valid.json'), '{"surface":"valid"}', 'utf8');

      // Insert once, then insert the exact same content again → dedup rejects
      await executeRemember(['Identical content for dedup'], 's', projectDb, globalDb, {});
      const dup = await executeRemember(
        ['Identical content for dedup'],
        's',
        projectDb,
        globalDb,
        { cwd: tempDir }
      );

      expect(dup.success).toBe(false);
      expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))).toHaveLength(1);
    } finally {
      projectDb.close();
      globalDb.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
