/**
 * Tests for the eval adapters against real SQLite files in a temp project:
 * the snapshot must be frozen, and authoring-session memories must never
 * reach the injected context.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemory, type MemoryType } from '../core/types.js';
import { insertFact, insertMemory, openDatabase, upsertEntity } from '../infra/db.js';
import {
  countRefused,
  excludeSessions,
  openSnapshotContext,
  resolveEvalEndpoint,
  snapshotMemory,
} from './eval-adapters.js';

let root: string;
let project: string;
let snapshotDir: string;
let globalDbPath: string;

function addMemory(dbPath: string, id: string, summary: string, session: string, type: MemoryType = 'decision') {
  const db = openDatabase(dbPath);
  try {
    insertMemory(
      db,
      createMemory({
        id,
        content: summary,
        summary,
        memory_type: type,
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: session,
        source_context: '{}',
        tags: [],
        status: 'active',
      }),
    );
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function addFact(dbPath: string, entity: string, object: string, sourceMemoryId: string) {
  const db = openDatabase(dbPath);
  try {
    insertFact(db, {
      id: `fact-${sourceMemoryId}`,
      entity_id: upsertEntity(db, entity, 'tool'),
      predicate: 'serves',
      object,
      source_memory_id: sourceMemoryId,
      confidence: 0.7,
      valid_from: '2026-11-01T00:00:00.000Z',
      valid_to: null,
      created_at: '2026-11-01T00:00:00.000Z',
    });
  } finally {
    db.close();
  }
}

const projectDb = () => path.join(project, '.memory', 'cortex.db');
const admit = excludeSessions(new Set(['author-session']));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cortex-eval-adapters-'));
  project = path.join(root, 'project');
  snapshotDir = path.join(root, 'snapshot');
  mkdirSync(path.join(project, '.memory'), { recursive: true });
  // The caller resolves the global DB; tests keep it in the temp dir, never the real one.
  globalDbPath = path.join(root, 'global.db');

  addMemory(projectDb(), 'real', 'Reclaw runs pi on claude-sonnet-5.5', 'work-session').close();
  addMemory(projectDb(), 'leak', 'EVAL ANSWER KEY: warmind-1017-native is served', 'author-session').close();
  addFact(projectDb(), 'ds4-native', 'deepseek-v4-flash', 'real');
  addFact(projectDb(), 'maya', 'warmind-1017-native', 'leak');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('snapshotMemory', () => {
  test('freezes the memory a run reads: later writes do not reach it', async () => {
    snapshotMemory({ projectRoot: project, globalDbPath, snapshotDir });
    addMemory(projectDb(), 'later', 'Written after the snapshot about reclaw', 'work-session').close();

    const memory = openSnapshotContext({
      snapshotDir,
      projectName: 'project',
      branch: 'main',
      asOf: new Date('2026-11-09T00:00:00Z'),
      admit,
    });
    try {
      expect(await memory.context('what does reclaw run on?')).not.toContain('Written after the snapshot');
    } finally {
      memory.close();
    }
  });

  test('returns the databases it copied; a missing global database is recorded as null', () => {
    expect(snapshotMemory({ projectRoot: project, globalDbPath, snapshotDir })).toEqual({ project: projectDb(), global: null });
  });

  test('records the global database when there is one, and its memories reach the context', async () => {
    addMemory(globalDbPath, 'g', 'A global memory about reclaw', 'work-session').close();
    expect(snapshotMemory({ projectRoot: project, globalDbPath, snapshotDir })).toEqual({ project: projectDb(), global: globalDbPath });

    const memory = openSnapshotContext({
      snapshotDir,
      projectName: 'project',
      branch: 'main',
      asOf: new Date('2026-11-09T00:00:00Z'),
      admit,
    });
    try {
      expect(await memory.context('what about reclaw?')).toContain('A global memory about reclaw');
    } finally {
      memory.close();
    }
  });

  test('can be retaken over a leftover snapshot from an aborted start', () => {
    snapshotMemory({ projectRoot: project, globalDbPath, snapshotDir });
    expect(() => snapshotMemory({ projectRoot: project, globalDbPath, snapshotDir })).not.toThrow();
  });

  test('refuses a project without a cortex database', () => {
    expect(() => snapshotMemory({ projectRoot: path.join(root, 'elsewhere'), globalDbPath, snapshotDir })).toThrow(/no cortex database/);
  });
});

describe('authoring-session exclusion', () => {
  beforeEach(() => snapshotMemory({ projectRoot: project, globalDbPath, snapshotDir }));

  test('counts the memories it refuses', () => {
    expect(countRefused(snapshotDir, admit)).toBe(1);
    expect(countRefused(snapshotDir, () => true)).toBe(0);
  });

  test('the injected context carries real memories and facts, never the answer key', async () => {
    const memory = openSnapshotContext({
      snapshotDir,
      projectName: 'project',
      branch: 'main',
      asOf: new Date('2026-11-09T00:00:00Z'),
      admit,
    });
    try {
      const context = await memory.context('EVAL ANSWER KEY warmind served');
      expect(context).toContain('CORTEX_MEMORY_START');
      expect(context).toContain('Reclaw runs pi on claude-sonnet-5.5');
      expect(context).toContain('ds4-native');
      expect(context).not.toContain('ANSWER KEY');
      expect(context).not.toContain('warmind-1017-native');
    } finally {
      memory.close();
    }
  });

  test('without exclusion the same read would have leaked it', async () => {
    const memory = openSnapshotContext({
      snapshotDir,
      projectName: 'project',
      branch: 'main',
      asOf: new Date('2026-11-09T00:00:00Z'),
      admit: () => true,
    });
    try {
      expect(await memory.context('EVAL ANSWER KEY warmind served')).toContain('warmind-1017-native');
    } finally {
      memory.close();
    }
  });
});

describe('resolveEvalEndpoint', () => {
  test('an explicit role endpoint wins', () => {
    expect(
      resolveEvalEndpoint('judge', {
        CORTEX_EVAL_JUDGE_API_URL: 'http://judge.local/v1/',
        CORTEX_EVAL_JUDGE_API_KEY: 'k',
        CORTEX_EVAL_JUDGE_MODEL: 'glm',
      }),
    ).toEqual({ kind: 'ok', endpoint: { baseUrl: 'http://judge.local/v1', apiKey: 'k', model: 'glm' } });
  });

  test('a partial role endpoint is an error, not a silent fallback', () => {
    const resolved = resolveEvalEndpoint('answer', { CORTEX_EVAL_ANSWER_MODEL: 'glm' });
    expect(resolved).toEqual({
      kind: 'err',
      message: 'set all of CORTEX_EVAL_ANSWER_API_URL, CORTEX_EVAL_ANSWER_API_KEY, CORTEX_EVAL_ANSWER_MODEL, or none of them',
    });
  });
});
