/**
 * Tests for prompt-recall command
 * Uses in-memory SQLite for integration testing
 */

import { describe, test, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { openDatabase, insertMemory } from '../infra/db.js';
import { createMemory } from '../core/types.js';
import {
  extractKeywords,
  executePromptRecall,
  formatPromptRecall,
  STOP_WORDS,
  MIN_MEANINGFUL_TOKENS,
} from './prompt-recall.js';

// Helper: create in-memory test DBs
function setupTestDbs(): { projectDb: Database; globalDb: Database } {
  const projectDb = openDatabase(':memory:');
  const globalDb = openDatabase(':memory:');
  return { projectDb, globalDb };
}

// Helper: create test memory with sensible defaults
function createTestMemory(overrides: Partial<Parameters<typeof createMemory>[0]> = {}) {
  const now = new Date().toISOString();
  return createMemory({
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 9)}`,
    content: overrides.content ?? 'Test content',
    summary: overrides.summary ?? 'Test summary',
    memory_type: overrides.memory_type ?? 'decision',
    scope: overrides.scope ?? 'project',
    confidence: overrides.confidence ?? 0.8,
    priority: overrides.priority ?? 5,
    source_type: overrides.source_type ?? 'extraction',
    source_session: overrides.source_session ?? 'session-1',
    source_context: overrides.source_context ?? '{}',
    tags: overrides.tags ?? [],
    status: overrides.status ?? 'active',
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    last_accessed_at: overrides.last_accessed_at ?? now,
    access_count: overrides.access_count ?? 0,
    pinned: overrides.pinned ?? false,
  });
}

describe('extractKeywords', () => {
  test('filters stop words', () => {
    const result = extractKeywords('how does the extraction pipeline work');
    expect(result).not.toContain('how');
    expect(result).not.toContain('does');
    expect(result).not.toContain('the');
    expect(result).toContain('extraction');
    expect(result).toContain('pipeline');
    expect(result).toContain('work');
  });

  test('strips punctuation', () => {
    const result = extractKeywords('what is the API? endpoints! (routes)');
    expect(result).toContain('api');
    expect(result).toContain('endpoints');
    expect(result).toContain('routes');
    // Should not contain punctuation
    expect(result.some(t => /[?!()]/.test(t))).toBe(false);
  });

  test('lowercases all tokens', () => {
    const result = extractKeywords('TypeScript Extraction Pipeline');
    expect(result).toContain('typescript');
    expect(result).toContain('extraction');
    expect(result).toContain('pipeline');
  });

  test('deduplicates tokens', () => {
    const result = extractKeywords('pipeline pipeline pipeline extraction');
    const pipelineCount = result.filter(t => t === 'pipeline').length;
    expect(pipelineCount).toBe(1);
  });

  test('drops single-character tokens', () => {
    const result = extractKeywords('a b c extraction d pipeline');
    expect(result).not.toContain('b');
    expect(result).not.toContain('c');
    expect(result).not.toContain('d');
    expect(result).toContain('extraction');
    expect(result).toContain('pipeline');
  });

  test('returns empty for all stop words', () => {
    const result = extractKeywords('how do I use this');
    // All words are stop words or single chars
    expect(result.length).toBe(0);
  });

  test('preserves hyphenated compound words', () => {
    const result = extractKeywords('session-end extraction hook');
    expect(result).toContain('session-end');
  });
});

describe('executePromptRecall', () => {
  test('returns FTS5 results from project DB', () => {
    const { projectDb, globalDb } = setupTestDbs();

    const mem = createTestMemory({
      id: 'mem-1',
      content: 'Session extraction processes JSONL transcripts',
      summary: 'Session extraction: transcript processing pipeline',
      memory_type: 'pattern',
    });
    insertMemory(projectDb, mem);

    const results = executePromptRecall(projectDb, globalDb, {
      prompt: 'how does the extraction pipeline work',
      surfaceContent: '',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('mem-1');

    projectDb.close();
    globalDb.close();
  });

  test('returns FTS5 results from global DB', () => {
    const { projectDb, globalDb } = setupTestDbs();

    const mem = createTestMemory({
      id: 'global-1',
      content: 'TypeScript patterns for extraction modules',
      summary: 'TypeScript extraction patterns',
      scope: 'global',
    });
    insertMemory(globalDb, mem);

    const results = executePromptRecall(projectDb, globalDb, {
      prompt: 'typescript extraction patterns',
      surfaceContent: '',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('global-1');

    projectDb.close();
    globalDb.close();
  });

  test('deduplicates by ID across databases', () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Insert same-id memory in both DBs (unlikely but tests dedup logic)
    const mem = createTestMemory({
      id: 'shared-1',
      content: 'Shared extraction pipeline memory',
      summary: 'Shared extraction pipeline',
    });
    insertMemory(projectDb, mem);
    insertMemory(globalDb, mem);

    const results = executePromptRecall(projectDb, globalDb, {
      prompt: 'extraction pipeline shared',
      surfaceContent: '',
    });

    const ids = results.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    projectDb.close();
    globalDb.close();
  });

  test('deduplicates against surface content', () => {
    const { projectDb, globalDb } = setupTestDbs();

    const mem = createTestMemory({
      id: 'mem-surface',
      content: 'Extraction pipeline processes transcripts',
      summary: 'Extraction pipeline processes transcripts',
    });
    insertMemory(projectDb, mem);

    const results = executePromptRecall(projectDb, globalDb, {
      prompt: 'extraction pipeline transcripts',
      surfaceContent: 'Extraction pipeline processes transcripts',
    });

    expect(results.find(r => r.id === 'mem-surface')).toBeUndefined();

    projectDb.close();
    globalDb.close();
  });

  test('skips search when too few meaningful tokens', () => {
    const { projectDb, globalDb } = setupTestDbs();

    const mem = createTestMemory({
      id: 'mem-1',
      content: 'Important extraction content',
      summary: 'Extraction content',
    });
    insertMemory(projectDb, mem);

    // "how do I" → all stop words, too few meaningful tokens
    const results = executePromptRecall(projectDb, globalDb, {
      prompt: 'how do I use this',
      surfaceContent: '',
    });

    expect(results.length).toBe(0);

    projectDb.close();
    globalDb.close();
  });

  test('respects limit', () => {
    const { projectDb, globalDb } = setupTestDbs();

    // Insert 10 memories about extraction
    for (let i = 0; i < 10; i++) {
      const mem = createTestMemory({
        id: `mem-${i}`,
        content: `Extraction pipeline detail number ${i} with keywords`,
        summary: `Extraction detail ${i}`,
      });
      insertMemory(projectDb, mem);
    }

    const results = executePromptRecall(projectDb, globalDb, {
      prompt: 'extraction pipeline keywords details',
      surfaceContent: '',
      limit: 3,
    });

    expect(results.length).toBeLessThanOrEqual(3);

    projectDb.close();
    globalDb.close();
  });

  test('handles null databases gracefully', () => {
    const results = executePromptRecall(null, null, {
      prompt: 'extraction pipeline work',
      surfaceContent: '',
    });

    expect(results.length).toBe(0);
  });

  test('excludes non-active memories', () => {
    const { projectDb, globalDb } = setupTestDbs();

    const mem = createTestMemory({
      id: 'mem-archived',
      content: 'Archived extraction pipeline memory',
      summary: 'Archived extraction pipeline',
      status: 'archived',
    });
    insertMemory(projectDb, mem);

    const results = executePromptRecall(projectDb, globalDb, {
      prompt: 'extraction pipeline archived',
      surfaceContent: '',
    });

    expect(results.find(r => r.id === 'mem-archived')).toBeUndefined();

    projectDb.close();
    globalDb.close();
  });
});

describe('formatPromptRecall', () => {
  test('renders correct markdown with markers', () => {
    const memories = [
      createTestMemory({ memory_type: 'pattern', summary: 'Session extraction pipeline' }),
      createTestMemory({ memory_type: 'architecture', summary: 'Extract command with 100KB limit' }),
    ];

    const output = formatPromptRecall(memories);

    expect(output).toContain('<!-- CORTEX_RECALL_START -->');
    expect(output).toContain('<!-- CORTEX_RECALL_END -->');
    expect(output).toContain('## Prompt-Relevant Memories');
    expect(output).toContain('- [pattern] Session extraction pipeline');
    expect(output).toContain('- [architecture] Extract command with 100KB limit');
  });

  test('returns empty string for no results', () => {
    const output = formatPromptRecall([]);
    expect(output).toBe('');
  });

  test('returns empty string for empty array', () => {
    const output = formatPromptRecall([]);
    expect(output).toBe('');
  });
});
