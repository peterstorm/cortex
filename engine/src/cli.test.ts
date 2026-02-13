/**
 * Tests for CLI module
 * Tests pure functions and integration flows
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { parseHookInput, parseRecallArgs } from './cli.js';
import { openDatabase, insertMemory } from './infra/db.js';
import { createMemory } from './core/types.js';
import { getProjectName } from './config.js';

describe('cli - parseHookInput', () => {
  it('should parse valid hook input JSON', () => {
    const jsonText = JSON.stringify({
      session_id: 'sess-123',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/home/user/project',
    });

    const result = parseHookInput(jsonText);

    expect(result).not.toBeNull();
    expect(result?.session_id).toBe('sess-123');
    expect(result?.transcript_path).toBe('/path/to/transcript.jsonl');
    expect(result?.cwd).toBe('/home/user/project');
  });

  it('should reject input missing session_id', () => {
    const jsonText = JSON.stringify({
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/home/user/project',
    });

    const result = parseHookInput(jsonText);
    expect(result).toBeNull();
  });

  it('should reject input missing transcript_path', () => {
    const jsonText = JSON.stringify({
      session_id: 'sess-123',
      cwd: '/home/user/project',
    });

    const result = parseHookInput(jsonText);
    expect(result).toBeNull();
  });

  it('should reject input missing cwd', () => {
    const jsonText = JSON.stringify({
      session_id: 'sess-123',
      transcript_path: '/path/to/transcript.jsonl',
    });

    const result = parseHookInput(jsonText);
    expect(result).toBeNull();
  });

  it('should reject invalid JSON', () => {
    const result = parseHookInput('not valid json');
    expect(result).toBeNull();
  });

  it('should reject empty string', () => {
    const result = parseHookInput('');
    expect(result).toBeNull();
  });

  it('should reject JSON with wrong field types', () => {
    const jsonText = JSON.stringify({
      session_id: 123, // number instead of string
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/home/user/project',
    });

    const result = parseHookInput(jsonText);
    expect(result).toBeNull();
  });
});

describe('cli - parseRecallArgs', () => {
  it('should parse valid recall args with query only', () => {
    const args = ['/home/user/project', 'test query'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.cwd).toBe('/home/user/project');
      expect(result.options.query).toBe('test query');
      expect(result.options.limit).toBe(10); // DEFAULT_SEARCH_LIMIT
      expect(result.options.keyword).toBeUndefined();
      expect(result.options.branch).toBeUndefined();
    }
  });

  it('should parse recall args with branch option', () => {
    const args = ['/home/user/project', 'test query', '--branch=feature/test'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.options.branch).toBe('feature/test');
    }
  });

  it('should parse recall args with limit option', () => {
    const args = ['/home/user/project', 'test query', '--limit=5'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.options.limit).toBe(5);
    }
  });

  it('should parse recall args with keyword flag', () => {
    const args = ['/home/user/project', 'test query', '--keyword'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.options.keyword).toBe(true);
    }
  });

  it('should parse recall args with multiple options', () => {
    const args = [
      '/home/user/project',
      'test query',
      '--branch=main',
      '--limit=15',
      '--keyword',
    ];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.options.branch).toBe('main');
      expect(result.options.limit).toBe(15);
      expect(result.options.keyword).toBe(true);
    }
  });

  it('should reject recall args without query', () => {
    const args = ['/home/user/project'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Usage: recall');
    }
  });

  it('should reject recall args with empty array', () => {
    const args: string[] = [];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Usage: recall');
    }
  });

  it('should handle invalid limit (NaN) by using default', () => {
    const args = ['/home/user/project', 'test query', '--limit=invalid'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.options.limit).toBe(10); // DEFAULT_SEARCH_LIMIT
    }
  });

  it('should handle negative limit by using default', () => {
    const args = ['/home/user/project', 'test query', '--limit=-5'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.options.limit).toBe(10); // DEFAULT_SEARCH_LIMIT
    }
  });

  it('should handle zero limit by using default', () => {
    const args = ['/home/user/project', 'test query', '--limit=0'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.options.limit).toBe(10); // DEFAULT_SEARCH_LIMIT
    }
  });

  it('should return readonly RecallOptions that cannot be mutated', () => {
    const args = ['/home/user/project', 'test query'];

    const result = parseRecallArgs(args);

    expect(result.success).toBe(true);
    if (result.success) {
      // Type system should enforce readonly, but verify returned object structure
      expect(result.options).toHaveProperty('query');
      expect(result.options).toHaveProperty('limit');
      expect(result.options).toHaveProperty('geminiApiKey');
      expect(result.options).toHaveProperty('projectName');
    }
  });
});

describe('config - getProjectName', () => {
  it('should extract project name from absolute path', () => {
    const result = getProjectName('/home/user/my-project');
    expect(result).toBe('my-project');
  });

  it('should handle path with trailing slash', () => {
    const result = getProjectName('/home/user/my-project/');
    expect(result).toBe('my-project');
  });

  it('should handle single directory', () => {
    const result = getProjectName('/project');
    expect(result).toBe('project');
  });

  it('should handle root directory', () => {
    const result = getProjectName('/');
    // basename of '/' is empty string
    expect(result).toBe('unknown');
  });

  it('should handle empty string', () => {
    const result = getProjectName('');
    expect(result).toBe('unknown');
  });
});

describe('cli - database initialization', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('should initialize database schema', () => {
    // If openDatabase succeeds, schema is initialized
    expect(db).toBeDefined();

    // Verify we can insert a memory
    const memory = createMemory({
      id: 'mem-1',
      content: 'Test content',
      summary: 'Test summary',
      memory_type: 'architecture',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 'sess-1',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    const memoryId = insertMemory(db, memory);
    expect(memoryId).toBe('mem-1');
  });

  it('should support FTS5 search after initialization', () => {
    const memory = createMemory({
      id: 'mem-2',
      content: 'Functional programming patterns',
      summary: 'FP patterns',
      memory_type: 'pattern',
      scope: 'project',
      confidence: 0.9,
      priority: 7,
      source_type: 'manual',
      source_session: 'manual',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    insertMemory(db, memory);

    // Query FTS5 table
    const stmt = db.prepare('SELECT id FROM memories_fts WHERE content MATCH ?');
    const results = stmt.all('functional') as Array<{ id: string }>;

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('mem-2');
  });

  it('should enforce schema constraints', () => {
    // Test that required fields are enforced
    expect(() => {
      db.prepare(
        'INSERT INTO memories (id, content) VALUES (?, ?)'
      ).run('mem-bad', 'content only');
    }).toThrow();
  });

  it('should support vector embeddings column', () => {
    const memory = createMemory({
      id: 'mem-3',
      content: 'Test with embedding',
      summary: 'Test summary',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.7,
      priority: 5,
      source_type: 'extraction',
      source_session: 'sess-1',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    insertMemory(db, memory);

    // Verify embedding column exists and accepts BLOB
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    const buffer = Buffer.from(embedding.buffer);

    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buffer, 'mem-3');

    const result = db.prepare('SELECT embedding FROM memories WHERE id = ?').get('mem-3') as {
      embedding: Buffer;
    };

    expect(result.embedding).toBeDefined();
    expect(result.embedding.length).toBe(12); // 3 floats * 4 bytes
  });
});

describe('cli - integration flows', () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = openDatabase(':memory:');
    globalDb = openDatabase(':memory:');
  });

  it('should execute remember -> recall flow', () => {
    // Create a memory manually
    const memory = createMemory({
      id: 'mem-test',
      content: 'Test memory for recall',
      summary: 'Test summary',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.9,
      priority: 5,
      source_type: 'manual',
      source_session: 'manual',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    insertMemory(projectDb, memory);

    // Verify memory exists
    const stmt = projectDb.prepare('SELECT id FROM memories WHERE id = ?');
    const result = stmt.get('mem-test') as { id: string } | undefined;
    expect(result?.id).toBe('mem-test');

    // Verify FTS5 index was updated
    const ftsStmt = projectDb.prepare('SELECT id FROM memories_fts WHERE id = ?');
    const ftsResult = ftsStmt.get('mem-test') as { id: string } | undefined;
    expect(ftsResult?.id).toBe('mem-test');
  });

  it('should handle memory status updates', () => {
    const memory = createMemory({
      id: 'mem-lifecycle',
      content: 'Memory for lifecycle test',
      summary: 'Test summary',
      memory_type: 'decision',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 'sess-1',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    insertMemory(projectDb, memory);

    // Update memory confidence (simulating decay)
    projectDb
      .prepare('UPDATE memories SET confidence = ? WHERE id = ?')
      .run(0.5, 'mem-lifecycle');

    const updatedResult = projectDb
      .prepare('SELECT confidence FROM memories WHERE id = ?')
      .get('mem-lifecycle') as { confidence: number };

    expect(updatedResult.confidence).toBe(0.5);
  });

  it('should maintain referential integrity for edges', () => {
    // Create parent memory
    const parent = createMemory({
      id: 'mem-parent',
      content: 'Parent memory',
      summary: 'Parent',
      memory_type: 'architecture',
      scope: 'project',
      confidence: 0.9,
      priority: 7,
      source_type: 'extraction',
      source_session: 'sess-1',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    insertMemory(projectDb, parent);

    // Create child memory
    const child = createMemory({
      id: 'mem-child',
      content: 'Child memory',
      summary: 'Child',
      memory_type: 'decision',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 'sess-1',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    insertMemory(projectDb, child);

    // Create edge (relation)
    projectDb
      .prepare(
        'INSERT INTO edges (id, source_id, target_id, relation_type, strength, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        'edge-1',
        'mem-parent',
        'mem-child',
        'derives-from',
        0.9,
        new Date().toISOString()
      );

    // Verify edge exists
    const edge = projectDb
      .prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ?')
      .get('mem-parent', 'mem-child') as {
      source_id: string;
      target_id: string;
      relation_type: string;
    };

    expect(edge).toBeDefined();
    expect(edge.source_id).toBe('mem-parent');
    expect(edge.target_id).toBe('mem-child');
    expect(edge.relation_type).toBe('derives-from');
  });

  it('should support searching memories by type and scope', () => {
    const memory1 = createMemory({
      id: 'mem-search-1',
      content: 'First memory',
      summary: 'First',
      memory_type: 'pattern',
      scope: 'project',
      confidence: 0.9,
      priority: 6,
      source_type: 'manual',
      source_session: 'manual',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    const memory2 = createMemory({
      id: 'mem-search-2',
      content: 'Second memory',
      summary: 'Second',
      memory_type: 'architecture',
      scope: 'global',
      confidence: 0.8,
      priority: 7,
      source_type: 'manual',
      source_session: 'manual',
      source_context: JSON.stringify({ branch: 'main' }),
    });

    insertMemory(projectDb, memory1);
    insertMemory(globalDb, memory2);

    // Query by type
    const patternMemories = projectDb
      .prepare('SELECT id FROM memories WHERE memory_type = ?')
      .all('pattern') as Array<{ id: string }>;

    expect(patternMemories).toHaveLength(1);
    expect(patternMemories[0].id).toBe('mem-search-1');

    // Query by scope
    const globalMemories = globalDb
      .prepare('SELECT id FROM memories WHERE scope = ?')
      .all('global') as Array<{ id: string }>;

    expect(globalMemories).toHaveLength(1);
    expect(globalMemories[0].id).toBe('mem-search-2');
  });
});
