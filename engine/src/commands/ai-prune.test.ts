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
vi.mock('../infra/claude-llm.js', () => ({
  isClaudeLlmAvailable: () => true,
  runLlmPrompt: (prompt: string, timeout: number) => mockRunLlmPrompt(prompt, timeout),
}));

import { runAiPrune, isTooYoungToArchive, shouldRunAiPrune, parsePruneResponse } from './ai-prune.js';

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

describe('runAiPrune age guard (enforced in code, not just prompt)', () => {
  beforeEach(() => {
    mockRunLlmPrompt.mockReset();
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
    mockRunLlmPrompt.mockResolvedValue(JSON.stringify([
      { id: 'fresh-1', reason: 'looks redundant' },
      { id: 'old-0', reason: 'stale session context' },
    ]));

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

    mockRunLlmPrompt.mockResolvedValue(JSON.stringify([
      { id: 'pinned-1', reason: 'redundant' },
    ]));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(getMemory(projectDb, 'pinned-1')!.status).toBe('active');
    expect(result.archived).toBe(0);

    projectDb.close();
    globalDb.close();
  });
});

describe('parsePruneResponse / shouldRunAiPrune (sanity)', () => {
  it('parses a valid response', () => {
    const parsed = parsePruneResponse('[{"id": "abc", "reason": "stale"}]');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('abc');
  });

  it('returns empty for malformed output', () => {
    expect(parsePruneResponse('nonsense')).toHaveLength(0);
  });

  it('triggers on session interval', () => {
    expect(shouldRunAiPrune(5, 0, 5, 50)).toBe(true);
    expect(shouldRunAiPrune(1, 0, 5, 50)).toBe(false);
  });

  it('does not rerun every session merely because the store remains large', () => {
    expect(shouldRunAiPrune(1, 276, 5, 50, 276)).toBe(false);
  });

  it('retriggers after 25 percent memory growth', () => {
    expect(shouldRunAiPrune(1, 124, 5, 50, 100)).toBe(false);
    expect(shouldRunAiPrune(1, 125, 5, 50, 100)).toBe(true);
  });
});

describe('AI prune failure telemetry', () => {
  beforeEach(() => {
    mockRunLlmPrompt.mockReset();
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

import { upsertEntity, insertFact, getCurrentFacts } from '../infra/db.js';

describe('ai-prune side effects (findings 1b, 12)', () => {
  beforeEach(() => {
    mockRunLlmPrompt.mockReset();
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
    mockRunLlmPrompt.mockResolvedValue(JSON.stringify([
      { id: 'old-0', reason: 'stale' },
    ]));

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
    mockRunLlmPrompt.mockResolvedValue('[]');

    const result = await runAiPrune(projectDb, globalDb, telemetryPath, cwd);

    expect(result.archived).toBe(0);
    expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))).toHaveLength(1);

    projectDb.close();
    globalDb.close();
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

    mockRunLlmPrompt.mockResolvedValue(JSON.stringify([
      { id: 'old-0', reason: 'stale' },
    ]));

    const result = await runAiPrune(projectDb, globalDb, telemetryPath);

    expect(result.archived).toBe(1);
    expect(getCurrentFacts(projectDb, entityId)).toHaveLength(0);

    projectDb.close();
    globalDb.close();
  });
});
