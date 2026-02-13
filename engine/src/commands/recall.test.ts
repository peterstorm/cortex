/**
 * Tests for recall command
 * Uses in-memory SQLite and mocked Voyage API
 */


import { Database } from 'bun:sqlite';
import {
  executeRecall,
  formatRecallResult,
  formatRecallError,
  type RecallOptions,
  type RecallError,
} from './recall.js';
import { openDatabase, insertMemory, insertEdge } from '../infra/db.js';
import { createMemory, createEdge } from '../core/types.js';
import * as geminiEmbed from '../infra/gemini-embed.ts';

// Setup test databases
function setupTestDbs(): { projectDb: Database; globalDb: Database } {
  const projectDb = openDatabase(':memory:');
  const globalDb = openDatabase(':memory:');
  return { projectDb, globalDb };
}

// Helper: Create test memory
function createTestMemory(overrides: Partial<Parameters<typeof createMemory>[0]> = {}) {
  const now = new Date().toISOString();
  return createMemory({
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 9)}`,
    content: overrides.content ?? 'Test content',
    summary: overrides.summary ?? 'Test summary',
    memory_type: overrides.memory_type ?? 'decision',
    scope: overrides.scope ?? 'project',
    embedding: overrides.embedding ?? new Float64Array(768).fill(0.5),
    local_embedding: overrides.local_embedding ?? null,
    confidence: overrides.confidence ?? 0.8,
    priority: overrides.priority ?? 5,
    pinned: overrides.pinned ?? false,
    source_type: overrides.source_type ?? 'extraction',
    source_session: overrides.source_session ?? 'session-1',
    source_context: overrides.source_context ?? JSON.stringify({ branch: 'main' }),
    tags: overrides.tags ?? [],
    access_count: overrides.access_count ?? 0,
    last_accessed_at: overrides.last_accessed_at ?? now,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    status: overrides.status ?? 'active',
  });
}

describe('recall command', () => {
  let embedTextsSpy: any;
  let isGeminiAvailableSpy: any;

  beforeEach(() => {
    // Reset and recreate mocks for each test
    embedTextsSpy = vi.spyOn(geminiEmbed, 'embedTexts').mockImplementation(async (texts: readonly string[]) => {
      // Return mock embeddings (768 dimensions for gemini)
      return texts.map(() => new Float64Array(768).fill(0.5));
    });

    isGeminiAvailableSpy = vi.spyOn(geminiEmbed, 'isGeminiAvailable').mockImplementation((apiKey: string | undefined) => {
      return typeof apiKey === 'string' && apiKey.trim().length > 0;
    });
  });

  afterEach(() => {
    // Restore original implementations
    embedTextsSpy?.mockRestore();
    isGeminiAvailableSpy?.mockRestore();
  });

  test('semantic search with Gemini (project + global merge)', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Insert test memories
    const projectMem = createTestMemory({ scope: 'project', summary: 'Project decision' });
    const globalMem = createTestMemory({ scope: 'global', summary: 'Global pattern' });

    insertMemory(projectDb, projectMem);
    insertMemory(globalDb, globalMem);

    const options: RecallOptions = {
      query: 'test query',
      limit: 10,
      geminiApiKey: 'test-key',
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.result.method).toBe('semantic');
    expect(result.result.results.length).toBeGreaterThan(0);

    // Should have called Gemini API
    expect(geminiEmbed.embedTexts).toHaveBeenCalledTimes(1);
  });

  test('prefixes query with project name for aligned search (FR-039)', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    const mem = createTestMemory({ summary: 'Test memory' });
    insertMemory(projectDb, mem);

    const options: RecallOptions = {
      query: 'test query',
      geminiApiKey: 'test-key',
      projectName: 'my-project',
    };

    await executeRecall(projectDb, globalDb, options);

    // embedTexts should receive prefixed query
    expect(geminiEmbed.embedTexts).toHaveBeenCalledWith(
      ['[query] [project:my-project] test query'],
      'test-key'
    );
  });

  test('keyword search fallback (no Gemini key)', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Insert test memories
    const projectMem = createTestMemory({ content: 'Important decision about API design' });
    insertMemory(projectDb, projectMem);

    const options: RecallOptions = {
      query: 'API design',
      limit: 10,
      // No geminiApiKey
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.result.method).toBe('keyword');
    expect(result.result.results.length).toBeGreaterThan(0);

    // Should NOT have called Gemini API
    expect(geminiEmbed.embedTexts).not.toHaveBeenCalled();
  });

  test('keyword search with --keyword flag', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    const mem = createTestMemory({ content: 'Keyword search test' });
    insertMemory(projectDb, mem);

    const options: RecallOptions = {
      query: 'keyword',
      keyword: true, // Force keyword search
      geminiApiKey: 'test-key', // Even with key, should use keyword
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.result.method).toBe('keyword');
    expect(geminiEmbed.embedTexts).not.toHaveBeenCalled();
  });

  test('keyword search finds raw code content via FTS5 (US3-2)', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Insert code memory with JWT content but summary that doesn't mention jwt
    const codeMem = createTestMemory({
      memory_type: 'code',
      content: 'export function verifyAuth(token: string) {\n  return jwt.verify(token, secret);\n}',
      summary: 'Authentication verification function',
      embedding: null, // No embedding — forces keyword path
    });
    insertMemory(projectDb, codeMem);

    const options: RecallOptions = {
      query: 'jwt',
      // No geminiApiKey — forces keyword search
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.result.method).toBe('keyword');
    expect(result.result.results.length).toBeGreaterThan(0);

    const found = result.result.results.find((r) => r.memory.id === codeMem.id);
    expect(found).toBeDefined();
  });

  test('branch filter', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Insert memories on different branches
    const mainMem = createTestMemory({
      summary: 'Main branch memory',
      source_context: JSON.stringify({ branch: 'main' }),
    });
    const featureMem = createTestMemory({
      summary: 'Feature branch memory',
      source_context: JSON.stringify({ branch: 'feature/new' }),
    });

    insertMemory(projectDb, mainMem);
    insertMemory(projectDb, featureMem);

    const options: RecallOptions = {
      query: 'test',
      branch: 'main', // Filter for main branch
      geminiApiKey: 'test-key',
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Should only return main branch memory
    for (const searchResult of result.result.results) {
      const context = JSON.parse(searchResult.memory.source_context);
      expect(context.branch).toBe('main');
    }
  });

  test('follows source_of edges to get code blocks', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Create prose description and linked code block
    const proseMem = createTestMemory({
      memory_type: 'code_description',
      summary: 'Prose explanation',
    });
    const codeMem = createTestMemory({
      memory_type: 'code',
      summary: 'Raw code',
    });

    insertMemory(projectDb, proseMem);
    insertMemory(projectDb, codeMem);

    // Create source_of edge: prose -> code
    const edge = createEdge({
      id: 'edge-1',
      source_id: proseMem.id,
      target_id: codeMem.id,
      relation_type: 'source_of',
      strength: 1.0,
      bidirectional: false,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    insertEdge(projectDb, edge);

    const options: RecallOptions = {
      query: 'prose',
      geminiApiKey: 'test-key',
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Find the prose memory in results
    const proseResult = result.result.results.find(
      (r) => r.memory.id === proseMem.id
    );

    expect(proseResult).toBeDefined();
    if (!proseResult) return;

    // Should have related code block
    expect(proseResult.related.length).toBeGreaterThan(0);
    const relatedCode = proseResult.related.find((m) => m.id === codeMem.id);
    expect(relatedCode).toBeDefined();
  });

  test('follows graph edges for related memories (depth 2)', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Create chain: mem1 -> mem2 -> mem3
    const mem1 = createTestMemory({ summary: 'Memory 1' });
    const mem2 = createTestMemory({ summary: 'Memory 2' });
    const mem3 = createTestMemory({ summary: 'Memory 3' });

    insertMemory(projectDb, mem1);
    insertMemory(projectDb, mem2);
    insertMemory(projectDb, mem3);

    // Create edges
    insertEdge(projectDb, {
      source_id: mem1.id,
      target_id: mem2.id,
      relation_type: 'relates_to',
      strength: 0.8,
      bidirectional: true,
      status: 'active',
    });

    insertEdge(projectDb, {
      source_id: mem2.id,
      target_id: mem3.id,
      relation_type: 'relates_to',
      strength: 0.8,
      bidirectional: true,
      status: 'active',
    });

    const options: RecallOptions = {
      query: 'test',
      geminiApiKey: 'test-key',
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Find mem1 in results
    const mem1Result = result.result.results.find((r) => r.memory.id === mem1.id);
    expect(mem1Result).toBeDefined();

    if (!mem1Result) return;

    // Should have mem2 and mem3 in related (depth 2)
    const relatedIds = mem1Result.related.map((m) => m.id);
    expect(relatedIds).toContain(mem2.id);
    expect(relatedIds).toContain(mem3.id);
  });

  test('updates access stats (FR-037)', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    const mem = createTestMemory({ access_count: 0 });
    insertMemory(projectDb, mem);

    const options: RecallOptions = {
      query: 'test',
      geminiApiKey: 'test-key',
    };

    await executeRecall(projectDb, globalDb, options);

    // Verify access_count incremented
    const stmt = projectDb.prepare('SELECT access_count FROM memories WHERE id = ?');
    const row = stmt.get(mem.id) as any;

    expect(row.access_count).toBe(1);
  });

  test('empty query error', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    const options: RecallOptions = {
      query: '', // Empty query
      geminiApiKey: 'test-key',
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.type).toBe('empty_query');
  });

  test('merges and deduplicates project + global results', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Insert same memory in both DBs (simulates sync scenario)
    const mem = createTestMemory({ id: 'shared-mem', summary: 'Shared memory' });
    insertMemory(projectDb, mem);
    insertMemory(globalDb, mem);

    const options: RecallOptions = {
      query: 'shared',
      geminiApiKey: 'test-key',
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Should deduplicate - only one instance of shared-mem
    const sharedResults = result.result.results.filter(
      (r) => r.memory.id === 'shared-mem'
    );
    expect(sharedResults.length).toBe(1);
  });

  test('respects limit parameter', async () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Insert many memories
    for (let i = 0; i < 20; i++) {
      const mem = createTestMemory({ summary: `Memory ${i}` });
      insertMemory(projectDb, mem);
    }

    const options: RecallOptions = {
      query: 'memory',
      limit: 5, // Limit to 5 results
      geminiApiKey: 'test-key',
    };

    const result = await executeRecall(projectDb, globalDb, options);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.result.results.length).toBeLessThanOrEqual(5);
  });

  test('format recall result', () => {
    const mem = createTestMemory();
    const formatted = formatRecallResult({
      results: [
        {
          memory: mem,
          score: 0.95,
          source: 'project',
          related: [],
        },
      ],
      method: 'semantic',
    });

    expect(formatted).toContain('semantic');
    expect(formatted).toContain('project');
    expect(typeof formatted).toBe('string');
  });

  test('format recall errors', () => {
    const errors: RecallError[] = [
      { type: 'empty_query' },
      { type: 'embedding_failed', message: 'Network error' },
      { type: 'search_failed', message: 'DB error' },
    ];

    for (const error of errors) {
      const formatted = formatRecallError(error);
      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    }
  });
});