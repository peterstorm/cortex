/**
 * Tests for the eval adapters against real SQLite files in a temp project:
 * the snapshot must be frozen, and authoring-session memories must never
 * reach the injected context.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MemoryAdmission } from '../core/admission.js';
import type { SnapshotSources } from '../core/eval-run.js';
import { createMemory, type MemoryType } from '../core/types.js';
import { insertFact, insertMemory, openDatabase, upsertEntity } from '../infra/db.js';
import {
  countRefused,
  excludeSessions,
  noMemoryContext,
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

const takeSnapshot = (): SnapshotSources => snapshotMemory({ projectRoot: project, globalDbPath, snapshotDir });

/** What the run would inject for `question`, read from the snapshot and closed again. */
async function injected(sources: SnapshotSources, question: string, admitting: MemoryAdmission = admit) {
  const memory = openSnapshotContext({
    snapshotDir,
    sources,
    projectName: 'project',
    branch: 'main',
    asOf: new Date('2026-11-09T00:00:00Z'),
    admit: admitting,
  });
  try {
    return await memory.context(question);
  } finally {
    memory.close();
  }
}

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
    const sources = takeSnapshot();
    addMemory(projectDb(), 'later', 'Written after the snapshot about reclaw', 'work-session').close();

    expect((await injected(sources, 'what does reclaw run on?')).text).not.toContain('Written after the snapshot');
  });

  test('returns the databases it copied; a missing global database is recorded as null', () => {
    expect(takeSnapshot()).toEqual({ project: projectDb(), global: null });
  });

  test('records the global database when there is one, and its memories reach the context', async () => {
    addMemory(globalDbPath, 'g', 'A global memory about reclaw', 'work-session').close();
    const sources = takeSnapshot();
    expect(sources).toEqual({ project: projectDb(), global: globalDbPath });

    expect((await injected(sources, 'what about reclaw?')).text).toContain('A global memory about reclaw');
  });

  test('refuses to read a run whose global snapshot has gone missing, rather than measure less memory', async () => {
    addMemory(globalDbPath, 'g', 'A global memory about reclaw', 'work-session').close();
    const sources = takeSnapshot();
    rmSync(path.join(snapshotDir, 'global.db'));

    await expect(injected(sources, 'what about reclaw?')).rejects.toThrow(/snapshot of .*global\.db is missing/);
    expect(() => countRefused(snapshotDir, sources, admit)).toThrow(/start a new run/);
    // The project snapshot was not left open by the refusal: it can be removed and retaken.
    expect(() => takeSnapshot()).not.toThrow();
  });

  test('a run taken with no global database reads none, even if one appears in the snapshot directory later', async () => {
    const sources = takeSnapshot();
    addMemory(path.join(snapshotDir, 'global.db'), 'stray', 'A stray global memory about reclaw', 'work-session').close();

    expect((await injected(sources, 'what about reclaw?')).text).not.toContain('A stray global memory');
    expect(countRefused(snapshotDir, sources, () => false)).toBe(2);
  });

  test('can be retaken over a leftover snapshot from an aborted start', () => {
    takeSnapshot();
    expect(() => takeSnapshot()).not.toThrow();
  });

  test('refuses a project without a cortex database', () => {
    expect(() => snapshotMemory({ projectRoot: path.join(root, 'elsewhere'), globalDbPath, snapshotDir })).toThrow(/no cortex database/);
  });
});

describe('authoring-session exclusion', () => {
  let sources: SnapshotSources;
  beforeEach(() => {
    sources = takeSnapshot();
  });

  test('counts the memories it refuses', () => {
    expect(countRefused(snapshotDir, sources, admit)).toBe(1);
    expect(countRefused(snapshotDir, sources, () => true)).toBe(0);
  });

  test('the injected context carries real memories and facts, never the answer key', async () => {
    const { text } = await injected(sources, 'EVAL ANSWER KEY warmind served');
    expect(text).toContain('CORTEX_MEMORY_START');
    expect(text).toContain('Reclaw runs pi on claude-sonnet-5.5');
    expect(text).toContain('ds4-native');
    expect(text).not.toContain('ANSWER KEY');
    expect(text).not.toContain('warmind-1017-native');
  });

  test('without exclusion the same read would have leaked it', async () => {
    expect((await injected(sources, 'EVAL ANSWER KEY warmind served', () => true)).text).toContain(
      'warmind-1017-native',
    );
  });
});

describe('the recall path behind a context', () => {
  test('a question recall ran for says which path answered it', async () => {
    const { recall } = await injected(takeSnapshot(), 'what does reclaw run pi on today?');
    // Which of the two depends on whether this machine can load the embedder.
    expect(['semantic', 'keyword-fallback']).toContain(recall);
  });

  test('a question too short to recall for, and the no-memory baseline, say recall did not run', async () => {
    expect((await injected(takeSnapshot(), 'hi')).recall).toBe('not-run');
    expect(await noMemoryContext('what does reclaw run pi on today?')).toEqual({ text: '', recall: 'not-run' });
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
