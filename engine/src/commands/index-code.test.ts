/**
 * Tests for index-code command
 *
 * Unit tests for pure functions + integration tests with in-memory SQLite
 */


import {
  parseIndexCodeArgs,
  extractLineRange,
  buildCodeSourceContext,
  buildProseMemory,
  buildCodeMemory,
  formatSuccessResult,
  formatErrorResult,
  executeIndexCode,
  type IndexCodeArgs,
} from './index-code.js';
import { openDatabase, getMemory, getEdgesForMemory } from '../infra/db.js';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Database } from 'bun:sqlite';

// ============================================================================
// PURE FUNCTION TESTS
// ============================================================================

describe('parseIndexCodeArgs', () => {
  test('parses minimal args (file path + summary)', () => {
    const result = parseIndexCodeArgs(
      ['/path/to/file.ts', 'This is a summary'],
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.args).toEqual({
      filePath: '/path/to/file.ts',
      summary: 'This is a summary',
      startLine: undefined,
      endLine: undefined,
      scope: 'project',
      tags: [],
      sessionId: 'session-123',
    });
  });

  test('parses with line range', () => {
    const result = parseIndexCodeArgs(
      ['/file.ts', 'Summary', '--start=10', '--end=20'],
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.args?.startLine).toBe(10);
    expect(result.args?.endLine).toBe(20);
  });

  test('parses with global scope', () => {
    const result = parseIndexCodeArgs(
      ['/file.ts', 'Summary', '--scope=global'],
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.args?.scope).toBe('global');
  });

  test('parses with tags', () => {
    const result = parseIndexCodeArgs(
      ['/file.ts', 'Summary', '--tags=typescript,async,api'],
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.args?.tags).toEqual(['typescript', 'async', 'api']);
  });

  test('parses all options together', () => {
    const result = parseIndexCodeArgs(
      [
        '/src/utils.ts',
        'Utility functions for data transformation',
        '--start=42',
        '--end=100',
        '--scope=global',
        '--tags=utils,fp',
      ],
      'session-xyz'
    );

    expect(result.success).toBe(true);
    expect(result.args).toEqual({
      filePath: '/src/utils.ts',
      summary: 'Utility functions for data transformation',
      startLine: 42,
      endLine: 100,
      scope: 'global',
      tags: ['utils', 'fp'],
      sessionId: 'session-xyz',
    });
  });

  test('rejects missing file path', () => {
    const result = parseIndexCodeArgs([], 'session-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('file path and summary are required');
  });

  test('rejects missing summary', () => {
    const result = parseIndexCodeArgs(['/file.ts'], 'session-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('file path and summary are required');
  });

  test('rejects empty file path', () => {
    const result = parseIndexCodeArgs(['', 'Summary'], 'session-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('file path must not be empty');
  });

  test('rejects empty summary', () => {
    const result = parseIndexCodeArgs(['/file.ts', ''], 'session-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('summary must not be empty');
  });

  test('rejects invalid start line', () => {
    const result = parseIndexCodeArgs(
      ['/file.ts', 'Summary', '--start=0'],
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('start line must be >= 1');
  });

  test('rejects invalid end line', () => {
    const result = parseIndexCodeArgs(
      ['/file.ts', 'Summary', '--end=-5'],
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('end line must be >= 1');
  });

  test('rejects start > end', () => {
    const result = parseIndexCodeArgs(
      ['/file.ts', 'Summary', '--start=100', '--end=50'],
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('start line');
    expect(result.error).toContain('must be <=');
  });

  test('rejects invalid scope', () => {
    const result = parseIndexCodeArgs(
      ['/file.ts', 'Summary', '--scope=invalid'],
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('scope must be');
  });

  test('rejects unknown option', () => {
    const result = parseIndexCodeArgs(
      ['/file.ts', 'Summary', '--unknown=value'],
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('unknown option');
  });
});

describe('extractLineRange', () => {
  const sampleCode = `line 1
line 2
line 3
line 4
line 5`;

  test('returns full content when no range specified', () => {
    const result = extractLineRange(sampleCode);
    expect(result).toBe(sampleCode);
  });

  test('extracts lines 2-4 (inclusive)', () => {
    const result = extractLineRange(sampleCode, 2, 4);
    expect(result).toBe('line 2\nline 3\nline 4');
  });

  test('extracts from start line to end when only start specified', () => {
    const result = extractLineRange(sampleCode, 3);
    expect(result).toBe('line 3\nline 4\nline 5');
  });

  test('extracts from beginning when only end specified', () => {
    const result = extractLineRange(sampleCode, undefined, 2);
    expect(result).toBe('line 1\nline 2');
  });

  test('handles single line extraction', () => {
    const result = extractLineRange(sampleCode, 3, 3);
    expect(result).toBe('line 3');
  });

  test('handles first line', () => {
    const result = extractLineRange(sampleCode, 1, 1);
    expect(result).toBe('line 1');
  });

  test('handles last line', () => {
    const result = extractLineRange(sampleCode, 5, 5);
    expect(result).toBe('line 5');
  });
});

describe('buildCodeSourceContext', () => {
  test('includes all metadata', () => {
    const result = buildCodeSourceContext(
      '/src/file.ts',
      10,
      20,
      'session-abc'
    );

    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      file_path: '/src/file.ts',
      start_line: 10,
      end_line: 20,
      session_id: 'session-abc',
    });
  });

  test('handles missing line range', () => {
    const result = buildCodeSourceContext('/src/file.ts', undefined, undefined, 'session-abc');

    const parsed = JSON.parse(result);
    expect(parsed.file_path).toBe('/src/file.ts');
    expect(parsed.start_line).toBeUndefined();
    expect(parsed.end_line).toBeUndefined();
  });

  test('handles missing session', () => {
    const result = buildCodeSourceContext('/src/file.ts');

    const parsed = JSON.parse(result);
    expect(parsed.file_path).toBe('/src/file.ts');
    expect(parsed.session_id).toBeUndefined();
  });
});

describe('buildProseMemory', () => {
  test('creates code_description memory with embedding', () => {
    const args: IndexCodeArgs = {
      filePath: '/src/utils.ts',
      summary: 'Pure utility functions',
      startLine: 10,
      endLine: 50,
      scope: 'global',
      tags: ['utils', 'fp'],
      sessionId: 'session-123',
    };

    const embedding = new Float64Array([0.1, 0.2, 0.3]);
    const memory = buildProseMemory(args, embedding, 'test-prose-id', '2026-01-01T00:00:00.000Z');

    expect(memory.memory_type).toBe('code_description');
    expect(memory.scope).toBe('global');
    expect(memory.content).toBe('Pure utility functions');
    expect(memory.summary).toBe('Pure utility functions');
    expect(memory.confidence).toBe(1.0);
    expect(memory.priority).toBe(7);
    expect(memory.source_type).toBe('code_index');
    expect(memory.tags).toEqual(['utils', 'fp']);
    expect(memory.embedding).toBe(embedding);
    expect(memory.local_embedding).toBeNull();
    expect(memory.status).toBe('active');

    const context = JSON.parse(memory.source_context);
    expect(context.file_path).toBe('/src/utils.ts');
    expect(context.start_line).toBe(10);
    expect(context.end_line).toBe(50);
  });

  test('queues embedding when null', () => {
    const args: IndexCodeArgs = {
      filePath: '/file.ts',
      summary: 'Summary',
      scope: 'project',
      tags: [],
      sessionId: 'session-123',
    };

    const memory = buildProseMemory(args, null, 'test-id', '2026-01-01T00:00:00.000Z');

    expect(memory.embedding).toBeNull();
    expect(memory.local_embedding).toBeNull();
  });

  test('truncates long summary', () => {
    const longSummary = 'a'.repeat(300);
    const args: IndexCodeArgs = {
      filePath: '/file.ts',
      summary: longSummary,
      scope: 'project',
      tags: [],
      sessionId: 'session-123',
    };

    const memory = buildProseMemory(args, null, 'test-id', '2026-01-01T00:00:00.000Z');

    expect(memory.content).toBe(longSummary);
    expect(memory.summary.length).toBe(200);
    expect(memory.summary.endsWith('...')).toBe(true);
  });
});

describe('buildCodeMemory', () => {
  test('creates code memory without embedding', () => {
    const args: IndexCodeArgs = {
      filePath: '/src/handler.ts',
      summary: 'HTTP request handler',
      startLine: 5,
      endLine: 30,
      scope: 'project',
      tags: ['http', 'api'],
      sessionId: 'session-456',
    };

    const codeContent = 'export function handler(req: Request) {\n  return Response.json({ ok: true });\n}';
    const memory = buildCodeMemory(args, codeContent, 'test-code-id', '2026-01-01T00:00:00.000Z');

    expect(memory.memory_type).toBe('code');
    expect(memory.scope).toBe('project');
    expect(memory.content).toBe(codeContent);
    expect(memory.confidence).toBe(1.0);
    expect(memory.priority).toBe(5);
    expect(memory.source_type).toBe('code_index');
    expect(memory.tags).toEqual(['http', 'api']);
    expect(memory.embedding).toBeNull(); // FR-053: no embedding for raw code
    expect(memory.local_embedding).toBeNull();
    expect(memory.status).toBe('active');

    const context = JSON.parse(memory.source_context);
    expect(context.file_path).toBe('/src/handler.ts');
  });

  test('generates summary from code', () => {
    const args: IndexCodeArgs = {
      filePath: '/file.ts',
      summary: 'Description',
      scope: 'project',
      tags: [],
      sessionId: 'session-123',
    };

    const shortCode = 'const x = 42;';
    const memory1 = buildCodeMemory(args, shortCode, 'id-1', '2026-01-01T00:00:00.000Z');
    expect(memory1.summary).toBe(shortCode);

    const longCode = 'a'.repeat(300);
    const memory2 = buildCodeMemory(args, longCode, 'id-2', '2026-01-01T00:00:00.000Z');
    expect(memory2.summary.length).toBe(200);
    expect(memory2.summary.endsWith('...')).toBe(true);
  });
});

describe('formatSuccessResult', () => {
  test('formats result with all fields', () => {
    const proseMemory = buildProseMemory(
      {
        filePath: '/src/file.ts',
        summary: 'Summary',
        scope: 'global',
        tags: [],
        sessionId: 'session-123',
      },
      null,
      'prose-id',
      '2026-01-01T00:00:00.000Z'
    );

    const codeMemory = buildCodeMemory(
      {
        filePath: '/src/file.ts',
        summary: 'Summary',
        scope: 'global',
        tags: [],
        sessionId: 'session-123',
      },
      'const x = 1;',
      'code-id',
      '2026-01-01T00:00:00.000Z'
    );

    const result = formatSuccessResult(proseMemory, codeMemory, '/src/file.ts', 2);

    expect(result.success).toBe(true);
    expect(result.prose_memory_id).toBe(proseMemory.id);
    expect(result.code_memory_id).toBe(codeMemory.id);
    expect(result.scope).toBe('global');
    expect(result.file_path).toBe('/src/file.ts');
    expect(result.superseded_count).toBe(2);
    expect(result.message).toContain('global scope');
    expect(result.message).toContain('2 old versions superseded');
  });
});

describe('formatErrorResult', () => {
  test('formats error', () => {
    const result = formatErrorResult('something went wrong');

    expect(result.success).toBe(false);
    expect(result.error).toBe('something went wrong');
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('executeIndexCode - integration', () => {
  let projectDb: Database;
  let globalDb: Database;
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    // Open in-memory databases
    projectDb = openDatabase(':memory:');
    globalDb = openDatabase(':memory:');

    // Create temp directory for test file
    tempDir = mkdtempSync(join(tmpdir(), 'cortex-test-'));

    // Write test file
    testFilePath = join(tempDir, 'test-file.ts');
    const testCode = `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}`;
    writeFileSync(testFilePath, testCode, 'utf-8');
  });

  afterEach(() => {
    try {
      unlinkSync(testFilePath);
    } catch {
      // ignore
    }
  });

  test('indexes code successfully without embedding', async () => {
    const result = await executeIndexCode(
      [testFilePath, 'Math utility functions'],
      'session-123',
      projectDb,
      globalDb,
      undefined, // no Voyage API key
      'test-project'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.prose_memory_id).toBeDefined();
    expect(result.code_memory_id).toBeDefined();
    expect(result.scope).toBe('project');
    expect(result.file_path).toBe(testFilePath);
    expect(result.superseded_count).toBe(0);
  });

  test('creates prose and code memories with correct types', async () => {
    const result = await executeIndexCode(
      [testFilePath, 'Math utility functions', '--tags=math,utils'],
      'session-123',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Query memories from database
    const proseMem = getMemory(projectDb, result.prose_memory_id);
    const codeMem = getMemory(projectDb, result.code_memory_id);

    expect(proseMem).not.toBeNull();
    expect(codeMem).not.toBeNull();

    expect(proseMem!.memory_type).toBe('code_description');
    expect(proseMem!.content).toBe('Math utility functions');
    expect(proseMem!.tags).toEqual(['math', 'utils']);

    expect(codeMem!.memory_type).toBe('code');
    expect(codeMem!.content).toContain('export function add');
    expect(codeMem!.content).toContain('export function multiply');
    expect(codeMem!.embedding).toBeNull(); // FR-053
    expect(codeMem!.local_embedding).toBeNull();
  });

  test('creates source_of edge from prose to code', async () => {
    const result = await executeIndexCode(
      [testFilePath, 'Math functions'],
      'session-123',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Query edges
    const edges = getEdgesForMemory(projectDb, result.prose_memory_id);

    expect(edges.length).toBe(1);
    expect(edges[0].source_id).toBe(result.prose_memory_id);
    expect(edges[0].target_id).toBe(result.code_memory_id);
    expect(edges[0].relation_type).toBe('source_of');
    expect(edges[0].strength).toBe(1.0);
  });

  test('extracts line range when specified', async () => {
    const result = await executeIndexCode(
      [testFilePath, 'Add function', '--start=1', '--end=3'],
      'session-123',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const codeMem = getMemory(projectDb, result.code_memory_id);

    expect(codeMem!.content).toContain('export function add');
    expect(codeMem!.content).not.toContain('multiply');

    const context = JSON.parse(codeMem!.source_context);
    expect(context.start_line).toBe(1);
    expect(context.end_line).toBe(3);
  });

  test('routes to global database when scope=global', async () => {
    const result = await executeIndexCode(
      [testFilePath, 'Math functions', '--scope=global'],
      'session-123',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.scope).toBe('global');

    // Should be in global DB, not project DB
    const proseInGlobal = getMemory(globalDb, result.prose_memory_id);
    const proseInProject = getMemory(projectDb, result.prose_memory_id);

    expect(proseInGlobal).not.toBeNull();
    expect(proseInProject).toBeNull();
  });

  test('supersedes old versions on re-indexing', async () => {
    // Index first version
    const result1 = await executeIndexCode(
      [testFilePath, 'First version'],
      'session-1',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result1.success).toBe(true);
    if (!result1.success) return;

    // Re-index same file
    const result2 = await executeIndexCode(
      [testFilePath, 'Second version (updated)'],
      'session-2',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result2.success).toBe(true);
    if (!result2.success) return;

    expect(result2.superseded_count).toBe(2); // 1 code + 1 prose

    // Check old code memory is superseded
    const oldCodeMem = getMemory(projectDb, result1.code_memory_id);
    expect(oldCodeMem!.status).toBe('superseded');

    // Check old prose memory is also superseded
    const oldProseMem = getMemory(projectDb, result1.prose_memory_id);
    expect(oldProseMem!.status).toBe('superseded');
  });

  test('creates supersedes edge on re-indexing', async () => {
    // Index first version
    const result1 = await executeIndexCode(
      [testFilePath, 'First version'],
      'session-1',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result1.success).toBe(true);
    if (!result1.success) return;

    // Re-index
    const result2 = await executeIndexCode(
      [testFilePath, 'Second version'],
      'session-2',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result2.success).toBe(true);
    if (!result2.success) return;

    // Check supersedes edge
    const edges = getEdgesForMemory(projectDb, result2.code_memory_id);

    const supersedesEdge = edges.find((e) => e.relation_type === 'supersedes');
    expect(supersedesEdge).toBeDefined();
    expect(supersedesEdge!.source_id).toBe(result2.code_memory_id);
    expect(supersedesEdge!.target_id).toBe(result1.code_memory_id);
  });

  test('returns error for non-existent file', async () => {
    const result = await executeIndexCode(
      ['/non/existent/file.ts', 'Summary'],
      'session-123',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toContain('failed to read file');
  });

  test('returns error for empty extracted code', async () => {
    // Create empty file
    const emptyFile = join(tempDir, 'empty.ts');
    writeFileSync(emptyFile, '', 'utf-8');

    const result = await executeIndexCode(
      [emptyFile, 'Empty file'],
      'session-123',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toContain('extracted code is empty');
  });

  test('returns error for invalid args', async () => {
    const result = await executeIndexCode(
      [], // missing args
      'session-123',
      projectDb,
      globalDb,
      undefined,
      'test-project'
    );

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toContain('file path and summary are required');
  });
});

// Property test: line extraction preserves monotonicity
describe('extractLineRange - properties', () => {
  test('cursor monotonicity: extracted range always contiguous', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');

    for (let start = 1; start <= 100; start += 10) {
      for (let end = start; end <= Math.min(start + 20, 100); end += 5) {
        const extracted = extractLineRange(content, start, end);
        const extractedLines = extracted.split('\n');

        // Should have exactly (end - start + 1) lines
        expect(extractedLines.length).toBe(end - start + 1);

        // First line should be the start line
        expect(extractedLines[0]).toBe(`line ${start}`);

        // Last line should be the end line
        expect(extractedLines[extractedLines.length - 1]).toBe(`line ${end}`);
      }
    }
  });
});

