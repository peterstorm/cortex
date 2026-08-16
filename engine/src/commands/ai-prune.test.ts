/**
 * Tests for AI prune command.
 * Focus: code-level enforcement of the "never archive <3 days old" rule —
 * the rule lives in the LLM prompt too, but LLM output must never be
 * trusted to obey it.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { Memory } from '../core/types.js';
import { createMemory } from '../core/types.js';
import { openDatabase, insertMemory, getMemory } from '../infra/db.js';
import { AI_PRUNE_MIN_AGE_DAYS } from '../config.js';

// Mock the LLM boundary — each test sets the response via mockRunLlmPrompt
const mockRunLlmPrompt = vi.fn();
const mockIsClaudeLlmAvailable = vi.fn();
const mockResolveEndpoint = vi.fn();
vi.mock('../infra/claude-llm.js', () => ({
  isClaudeLlmAvailable: () => mockIsClaudeLlmAvailable(),
  runLlmPromptDirect: async (prompt: string, timeout: number, options: unknown) => ({
    text: await mockRunLlmPrompt(prompt, timeout, options),
    direct: false,
  }),
}));
vi.mock('../infra/llm-client.js', () => ({
  resolveOpenAiCompatEndpoint: () => mockResolveEndpoint(),
}));

import {
  runAiPrune,
  runAiPruneIfNeeded,
  isProtectedStableMemory,
  isTooYoungToArchive,
  shouldRunAiPrune,
  parsePruneResponse,
} from './ai-prune.js';

const tempDirs: string[] = [];

function makeTelemetryPath(): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cortex-ai-prune-test-'));
  tempDirs.push(dir);
  return nodePath.join(dir, 'telemetry.json');
}

function makeMemory(id: string, ageDays: number, overrides: Partial<Memory> = {}): Memory {
  const created = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  return createMemory({
    id,
    content: `content for ${id}`,
    summary: `summary for ${id}`,
    memory_type: 'context',
    scope: 'project',
    confidence: 0.6,
    priority: 5,
    source_type: 'extraction',
    source_session: 'sess',
    source_context: '{}',
    created_at: created,
    updated_at: created,
    last_accessed_at: created,
    ...overrides,
  });
}

afterAll(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('isTooYoungToArchive', () => {
  const now = new Date('2026-07-06T12:00:00Z');

  it('returns true for a memory created 1 day ago', () => {
    const createdAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    expect(isTooYoungToArchive(createdAt, now)).toBe(true);
  });

  it('returns false for a memory older than the minimum age', () => {
    const createdAt = new Date(now.getTime() - (AI_PRUNE_MIN_AGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(isTooYoungToArchive(createdAt, now)).toBe(false);
  });

  it('boundary: exactly at the minimum age is old enough', () => {
    const createdAt = new Date(now.getTime() - AI_PRUNE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(isTooYoungToArchive(createdAt, now)).toBe(false);
  });
});

describe('isProtectedStableMemory', () => {
  it.each(['architecture', 'decision'] as const)(
    'protects high-confidence %s memories at the 0.8 boundary',
    (memoryType) => {
      expect(isProtectedStableMemory({ memory_type: memoryType, confidence: 0.8 })).toBe(true);
      expect(isProtectedStableMemory({ memory_type: memoryType, confidence: 0.799 })).toBe(false);
    }
  );

  it('does not protect other memory types solely because confidence is high', () => {
    expect(isProtectedStableMemory({ memory_type: 'pattern', confidence: 1 })).toBe(false);
  });
});

describe('runAiPrune age guard (enforced in code, not just prompt)', () => {
  beforeEach(() => {
    mockRunLlmPrompt.mockReset();
    mockIsClaudeLlmAvailable.mockReset().mockReturnValue(true);
    mockResolveEndpoint.mockReset().mockReturnValue(null);
  });

  it('proceeds via the direct endpoint when no CLI is available (dual-transport gate)', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    mockIsClaudeLlmAvailable.mockReturnValue(false);
    mockResolveEndpoint.mockReturnValue({ baseUrl: 'http://llm.example/v1', apiKey: 'k', model: 'm' });

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    // The gate passed and the (mocked) direct transport was called;
    // with no memories the run completes as an empty ok.
    expect(mockRunLlmPrompt).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
  });

  it('fails with the dual-transport error when neither endpoint nor CLI exists', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    mockIsClaudeLlmAvailable.mockReturnValue(false);
    mockResolveEndpoint.mockReturnValue(null);

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(result.error).toMatch(/no LLM available/i);
  });

  it('does not archive a fresh memory even when the LLM names it', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();

    // 7 old memories + 1 fresh (1 day old) — clears AI_PRUNE_MIN_MEMORIES (8)
    for (let i = 0; i < 7; i++) {
      insertMemory(projectDb, makeMemory(`old-${i}`, 30));
    }
    insertMemory(projectDb, makeMemory('fresh-1', 1));

    // LLM (mis)behaves: names both a fresh memory and an old one
    mockRunLlmPrompt.mockResolvedValue(JSON.stringify({ candidates: [
      { id: 'fresh-1', reason: 'looks redundant' },
      { id: 'old-0', reason: 'stale session context' },
    ] }));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    // Fresh memory survives despite the LLM output
    expect(getMemory(projectDb, 'fresh-1')!.status).toBe('active');
    // Old memory archived normally, with archived_at set
    const archived = getMemory(projectDb, 'old-0');
    expect(archived!.status).toBe('archived');
    expect(archived!.archived_at).not.toBeNull();
    expect(result.archived).toBe(1);
    expect(result.reviewed).toBe(8);

    projectDb.close();
    globalDb.close();
  });

  it('still respects the pinned guard alongside the age guard', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();

    for (let i = 0; i < 7; i++) {
      insertMemory(projectDb, makeMemory(`old-${i}`, 30));
    }
    insertMemory(projectDb, makeMemory('pinned-1', 30, { pinned: true }));

    mockRunLlmPrompt.mockResolvedValue(JSON.stringify({ candidates: [
      { id: 'pinned-1', reason: 'redundant' },
    ] }));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(getMemory(projectDb, 'pinned-1')!.status).toBe('active');
    expect(result.archived).toBe(0);

    projectDb.close();
    globalDb.close();
  });

  it('keeps LLM-nominated high-confidence architecture and decision memories active in both databases', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();

    for (let i = 0; i < 5; i++) {
      insertMemory(projectDb, makeMemory(`ordinary-${i}`, 30));
    }
    insertMemory(projectDb, makeMemory('protected-architecture', 30, {
      memory_type: 'architecture',
      confidence: 0.8,
    }));
    insertMemory(globalDb, makeMemory('protected-decision', 30, {
      memory_type: 'decision',
      scope: 'global',
      confidence: 0.95,
    }));
    insertMemory(globalDb, makeMemory('ordinary-global', 30, {
      scope: 'global',
      confidence: 0.95,
    }));

    mockRunLlmPrompt.mockResolvedValue(JSON.stringify({ candidates: [
      { id: 'protected-architecture', reason: 'model ignored the stable-memory rule' },
      { id: 'protected-decision', reason: 'model ignored the stable-memory rule' },
      { id: 'ordinary-global', reason: 'stale context' },
    ] }));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(getMemory(projectDb, 'protected-architecture')!.status).toBe('active');
    expect(getMemory(globalDb, 'protected-decision')!.status).toBe('active');
    expect(getMemory(globalDb, 'ordinary-global')!.status).toBe('archived');
    expect(result.archived).toBe(1);
    expect(result.reviewed).toBe(8);

    projectDb.close();
    globalDb.close();
  });
});

describe('parsePruneResponse / shouldRunAiPrune (sanity)', () => {
  it('parses a valid object envelope', () => {
    const parsed = parsePruneResponse('{"candidates":[{"id":"abc","reason":"stale"}]}');
    expect(parsed).toEqual({
      kind: 'ok',
      candidates: [{ id: 'abc', reason: 'stale' }],
    });
  });

  it('distinguishes malformed output from a valid empty decision', () => {
    expect(parsePruneResponse('nonsense').kind).toBe('unparseable');
    expect(parsePruneResponse('{"candidates":[]}')).toEqual({ kind: 'ok', candidates: [] });
  });

  it('parses subprocess fallback output wrapped in markdown or prose', () => {
    expect(parsePruneResponse(
      'Result:\n```json\n{"candidates":[{"id":"abc","reason":"stale"}]}\n```\nDone.'
    )).toEqual({
      kind: 'ok',
      candidates: [{ id: 'abc', reason: 'stale' }],
    });
    expect(parsePruneResponse(
      'Candidates: {"candidates":[]} Explanation mentions } afterward.'
    )).toEqual({ kind: 'ok', candidates: [] });
  });

  it('rejects the old top-level array and partially invalid candidates', () => {
    expect(parsePruneResponse('[{"id":"abc","reason":"stale"}]').kind).toBe('unparseable');
    expect(parsePruneResponse('{"candidates":[{"id":"abc"}]}').kind).toBe('unparseable');
  });

});

describe('shouldRunAiPrune (watermark trigger)', () => {
  const NOW = new Date('2026-08-16T04:00:00.000Z');
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  it('first run: waits until the store is worth reviewing', () => {
    expect(shouldRunAiPrune(null, 0, 7, NOW)).toBe(false);
    expect(shouldRunAiPrune(null, 0, 8, NOW)).toBe(true);
  });

  it('treats a corrupted watermark timestamp as never-pruned (safe direction: review again)', () => {
    expect(shouldRunAiPrune('not-a-timestamp', 0, 8, NOW)).toBe(true);
    expect(shouldRunAiPrune('not-a-timestamp', 0, 3, NOW)).toBe(false);
  });

  it('does not run inside the minimum interval, even with plenty of new memories', () => {
    expect(shouldRunAiPrune(hoursAgo(2), 25, 400, NOW)).toBe(false);
  });

  it('runs once the watermark shows enough new memories since the last success', () => {
    expect(shouldRunAiPrune(daysAgo(1), 19, 400, NOW)).toBe(false);
    expect(shouldRunAiPrune(daysAgo(1), 20, 400, NOW)).toBe(true);
  });

  it('does not run merely because time passed when there is no new material', () => {
    expect(shouldRunAiPrune(daysAgo(3), 0, 400, NOW)).toBe(false);
    expect(shouldRunAiPrune(daysAgo(3), 5, 400, NOW)).toBe(false);
  });

  it('runs on the staleness floor even without new memories (boundary: exactly at the floor)', () => {
    expect(shouldRunAiPrune(daysAgo(6.99), 0, 400, NOW)).toBe(false);
    expect(shouldRunAiPrune(daysAgo(7), 0, 400, NOW)).toBe(true);
  });
});

describe('runAiPruneIfNeeded (watermark wiring)', () => {
  beforeEach(() => {
    mockRunLlmPrompt.mockReset();
    mockIsClaudeLlmAvailable.mockReset().mockReturnValue(true);
    mockResolveEndpoint.mockReset().mockReturnValue(null);
  });

  it('skips without an LLM call when nothing new arrived since the last successful prune', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    // Watermark one hour ago; all 20 active memories are older than it.
    fs.writeFileSync(telemetryPath, JSON.stringify({
      last_ai_prune_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));
    for (let index = 0; index < 20; index++) {
      insertMemory(projectDb, makeMemory(`quiet-${index}`, 10));
    }

    const result = await runAiPruneIfNeeded(projectDb, globalDb, telemetryPath);

    expect(result).toMatchObject({ archived: 0, reviewed: 0, skipped: true });
    expect(mockRunLlmPrompt).not.toHaveBeenCalled();
    projectDb.close();
    globalDb.close();
  });

  it('proceeds on first run once the store reaches the review floor', async () => {
    mockRunLlmPrompt.mockResolvedValue('{"candidates":[]}');
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath(); // no watermark yet
    for (let index = 0; index < 8; index++) {
      insertMemory(projectDb, makeMemory(`first-${index}`, 10));
    }

    const result = await runAiPruneIfNeeded(projectDb, globalDb, telemetryPath);

    expect(result).toMatchObject({ archived: 0, reviewed: 8 });
    expect(mockRunLlmPrompt).toHaveBeenCalledTimes(1);
    projectDb.close();
    globalDb.close();
  });
});

describe('AI prune failure telemetry', () => {
  beforeEach(() => {
    mockRunLlmPrompt.mockReset();
    mockIsClaudeLlmAvailable.mockReset().mockReturnValue(true);
    mockResolveEndpoint.mockReset().mockReturnValue(null);
  });

  it('does not mark a prune complete when every LLM batch fails', async () => {
    mockRunLlmPrompt.mockRejectedValue(new Error('provider unavailable'));
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    for (let index = 0; index < 20; index++) {
      insertMemory(projectDb, makeMemory(`failure-${index}`, 10));
    }

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(result).toMatchObject({ archived: 0, reviewed: 0 });
    expect(result.error).toContain('All 1 AI prune batches failed');
    expect(fs.existsSync(telemetryPath)).toBe(false);
    projectDb.close();
    globalDb.close();
  });

  it('uses an object JSON schema compatible with the pruning envelope', async () => {
    mockRunLlmPrompt.mockResolvedValue('{"candidates":[]}');
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    for (let index = 0; index < 8; index++) {
      insertMemory(projectDb, makeMemory(`schema-${index}`, 10));
    }

    await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(mockRunLlmPrompt).toHaveBeenCalledWith(
      expect.stringContaining('{"candidates": ['),
      expect.any(Number),
      expect.objectContaining({
        jsonSchema: expect.objectContaining({
          type: 'object',
          required: ['candidates'],
        }),
      }),
    );
    projectDb.close();
    globalDb.close();
  });

  it('invalidates cache but does not reset cadence when an earlier batch archives and a later batch fails', async () => {
    mockRunLlmPrompt
      .mockResolvedValueOnce('{"candidates":[{"id":"partial-0","reason":"obsolete"}]}')
      .mockRejectedValueOnce(new Error('second batch unavailable'));
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    const cwd = nodePath.dirname(telemetryPath);
    const cacheDir = nodePath.join(cwd, '.memory', 'surface-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(nodePath.join(cacheDir, 'stale.json'), '{"surface":"stale"}', 'utf8');
    for (let index = 0; index < 81; index++) {
      insertMemory(projectDb, makeMemory(`partial-${index}`, 10));
    }

    const result = await runAiPrune(projectDb, globalDb, telemetryPath, cwd);

    expect(result).toMatchObject({ archived: 1, reviewed: 80 });
    expect(result.error).toContain('1 of 2 AI prune batches failed');
    expect(getMemory(projectDb, 'partial-0')?.status).toBe('archived');
    expect(fs.readdirSync(cacheDir).filter((file) => file.endsWith('.json'))).toHaveLength(0);
    expect(fs.existsSync(telemetryPath)).toBe(false);
    projectDb.close();
    globalDb.close();
  });

  it('rejects a mixed valid and unknown ID batch before archiving any sibling', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    for (let index = 0; index < 8; index++) {
      insertMemory(projectDb, makeMemory(`semantic-${index}`, 10));
    }
    mockRunLlmPrompt.mockResolvedValue(JSON.stringify({ candidates: [
      { id: 'semantic-0', reason: 'obsolete' },
      { id: 'hallucinated-id', reason: 'model drift' },
    ] }));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(result).toMatchObject({ archived: 0, reviewed: 0 });
    expect(result.error).toContain('All 1 AI prune batches failed');
    expect(getMemory(projectDb, 'semantic-0')?.status).toBe('active');
    expect(fs.existsSync(telemetryPath)).toBe(false);
    projectDb.close();
    globalDb.close();
  });

  it('treats malformed output as a failed batch rather than an empty decision', async () => {
    mockRunLlmPrompt.mockResolvedValue('{"not_candidates":[]}');
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    for (let index = 0; index < 8; index++) {
      insertMemory(projectDb, makeMemory(`malformed-${index}`, 10));
    }

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(result).toMatchObject({ archived: 0, reviewed: 0 });
    expect(result.error).toContain('All 1 AI prune batches failed');
    expect(fs.existsSync(telemetryPath)).toBe(false);
    projectDb.close();
    globalDb.close();
  });
});

// ============================================================================
// Regression tests: findings 1b and 12 — ai-prune archive invalidates the
// surface cache and supersedes facts from archived memories
// ============================================================================

import {
  getCurrentFacts,
  insertEdge,
  insertFact,
  upsertEntity,
} from '../infra/db.js';

describe('ai-prune side effects (findings 1b, 12)', () => {
  beforeEach(() => {
    mockRunLlmPrompt.mockReset();
    mockIsClaudeLlmAvailable.mockReset().mockReturnValue(true);
    mockResolveEndpoint.mockReset().mockReturnValue(null);
  });

  it('invalidates the surface cache when memories are archived', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    const cwd = nodePath.dirname(telemetryPath);

    const cacheDir = nodePath.join(cwd, '.memory', 'surface-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(nodePath.join(cacheDir, 'stale.json'), '{"surface":"stale"}', 'utf8');

    for (let i = 0; i < 8; i++) {
      insertMemory(projectDb, makeMemory(`old-${i}`, 30));
    }
    mockRunLlmPrompt.mockResolvedValue(JSON.stringify({ candidates: [
      { id: 'old-0', reason: 'stale' },
    ] }));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath, cwd);

    expect(result.archived).toBe(1);
    expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))).toHaveLength(0);

    projectDb.close();
    globalDb.close();
  });

  it('does NOT invalidate the cache when nothing is archived', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    const cwd = nodePath.dirname(telemetryPath);

    const cacheDir = nodePath.join(cwd, '.memory', 'surface-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(nodePath.join(cacheDir, 'valid.json'), '{"surface":"valid"}', 'utf8');

    for (let i = 0; i < 8; i++) {
      insertMemory(projectDb, makeMemory(`old-${i}`, 30));
    }
    mockRunLlmPrompt.mockResolvedValue('{"candidates":[]}');

    const result = await runAiPrune(projectDb, globalDb, telemetryPath, cwd);

    expect(result.archived).toBe(0);
    expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))).toHaveLength(1);

    projectDb.close();
    globalDb.close();
  });

  it('archives a global memory and applies global side effects', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();
    const cwd = nodePath.dirname(telemetryPath);
    const cacheDir = nodePath.join(cwd, '.memory', 'surface-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(nodePath.join(cacheDir, 'global-stale.json'), '{"surface":"stale"}', 'utf8');

    for (let i = 0; i < 6; i++) {
      insertMemory(projectDb, makeMemory(`project-old-${i}`, 30));
    }
    insertMemory(globalDb, makeMemory('global-target', 30, { scope: 'global' }));
    insertMemory(globalDb, makeMemory('global-peer', 30, { scope: 'global' }));
    insertEdge(globalDb, {
      source_id: 'global-target',
      target_id: 'global-peer',
      relation_type: 'relates_to',
      strength: 0.8,
      bidirectional: true,
      status: 'active',
    });
    const entityId = upsertEntity(globalDb, 'GlobalTool', 'tool');
    insertFact(globalDb, {
      id: 'global-fact',
      entity_id: entityId,
      predicate: 'used by',
      object: 'all projects',
      source_memory_id: 'global-target',
      confidence: 0.9,
      valid_from: new Date().toISOString(),
      valid_to: null,
      created_at: new Date().toISOString(),
    });

    mockRunLlmPrompt.mockResolvedValue(JSON.stringify({ candidates: [
      { id: 'global-target', reason: 'obsolete global context' },
    ] }));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath, cwd);

    expect(result.archived).toBe(1);
    expect(getMemory(globalDb, 'global-target')).toMatchObject({
      status: 'archived',
      archived_at: expect.any(String),
    });
    expect(globalDb.query('SELECT status FROM edges').all()).toEqual([
      { status: 'archived' },
    ]);
    expect(getCurrentFacts(globalDb, entityId)).toHaveLength(0);
    expect(fs.readdirSync(cacheDir).filter((file) => file.endsWith('.json'))).toHaveLength(0);

    projectDb.close();
    globalDb.close();
  });

  it('rolls back the memory archive when a dependent edge update fails', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();

    try {
      for (let i = 0; i < 8; i++) {
        insertMemory(projectDb, makeMemory(`atomic-${i}`, 30));
      }
      insertEdge(projectDb, {
        source_id: 'atomic-0',
        target_id: 'atomic-1',
        relation_type: 'relates_to',
        strength: 0.8,
        bidirectional: true,
        status: 'active',
      });
      projectDb.exec(`
        CREATE TRIGGER fail_archive_edge
        BEFORE UPDATE OF status ON edges
        WHEN NEW.status = 'archived'
        BEGIN
          SELECT RAISE(ABORT, 'forced dependent archive failure');
        END;
      `);
      mockRunLlmPrompt.mockResolvedValue(JSON.stringify({ candidates: [
        { id: 'atomic-0', reason: 'obsolete' },
      ] }));

      await expect(runAiPrune(projectDb, globalDb, telemetryPath)).rejects.toThrow(
        'forced dependent archive failure'
      );
      expect(getMemory(projectDb, 'atomic-0')).toMatchObject({
        status: 'active',
        archived_at: null,
      });
      expect(projectDb.query('SELECT status FROM edges').all()).toEqual([
        { status: 'active' },
      ]);
    } finally {
      projectDb.close();
      globalDb.close();
    }
  });

  it('supersedes facts sourced from an archived memory (finding 12)', async () => {
    const projectDb = openDatabase(':memory:');
    const globalDb = openDatabase(':memory:');
    const telemetryPath = makeTelemetryPath();

    for (let i = 0; i < 8; i++) {
      insertMemory(projectDb, makeMemory(`old-${i}`, 30));
    }
    const entityId = upsertEntity(projectDb, 'RetiredService', 'tool');
    insertFact(projectDb, {
      id: 'ap-fact-1',
      entity_id: entityId,
      predicate: 'deployed at',
      object: 'production',
      source_memory_id: 'old-0',
      confidence: 0.9,
      valid_from: new Date().toISOString(),
      valid_to: null,
      created_at: new Date().toISOString(),
    });
    expect(getCurrentFacts(projectDb, entityId)).toHaveLength(1);

    mockRunLlmPrompt.mockResolvedValue(JSON.stringify({ candidates: [
      { id: 'old-0', reason: 'stale' },
    ] }));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(result.archived).toBe(1);
    expect(getCurrentFacts(projectDb, entityId)).toHaveLength(0);

    projectDb.close();
    globalDb.close();
  });
});
