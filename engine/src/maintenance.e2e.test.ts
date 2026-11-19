/**
 * The real `maintenance` and `dedupe` commands. Maintenance must not classify
 * edges with an LLM; dedupe supersedes restatements in both databases.
 *
 * Typed-edge classification used to run here after every session. On 139,123
 * recorded pairs it left 99.6% as plain `relates_to`, and only `traverse`
 * reads the type, so it was taken out of maintenance; `semantic-edges` is an
 * explicit command now. The LLM endpoint below is a closed port, so a
 * regression fails this test instead of spending real quota.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectDbPath } from './config.js';
import { createMemory } from './core/types.js';
import { getAllEdges, insertEdge, insertMemory, openDatabase } from './infra/db.js';
import { runCli } from './test-support.js';

const NO_LLM = {
  CORTEX_LLM_API_URL: 'http://127.0.0.1:9/v1',
  CORTEX_LLM_API_KEY: 'unused',
  CORTEX_LLM_MODEL: 'unused',
  // One failed direct call suppresses the CLI fallback, so nothing real is asked.
  CORTEX_LLM_MAX_DIRECT_FAILURES: '1',
};

const memory = (
  id: string,
  summary: string,
  extra: Readonly<{ vector?: Float32Array; createdAt?: string; scope?: 'project' | 'global' }> = {}
) =>
  createMemory({
    id,
    content: summary,
    summary,
    memory_type: 'decision',
    scope: extra.scope ?? 'project',
    confidence: 0.9,
    priority: 7,
    source_type: 'extraction',
    source_session: 's',
    source_context: '{}',
    local_embedding: extra.vector ?? null,
    created_at: extra.createdAt,
  });

/** A project with its own global database, so each test sees only its seeds. */
const freshProject = (): Readonly<{ dir: string; globalDbPath: string }> => {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-maintenance-'));
  mkdirSync(join(dir, '.memory'), { recursive: true });
  return { dir, globalDbPath: join(dir, 'global.db') };
};

const withDb = <T>(path: string, use: (db: ReturnType<typeof openDatabase>) => T): T => {
  const db = openDatabase(path);
  try {
    return use(db);
  } finally {
    db.close();
  }
};

describe('maintenance', () => {
  it('leaves similarity edges unclassified and asks no LLM about them', () => {
    const { dir } = freshProject();
    withDb(getProjectDbPath(dir), (seeded) => {
      insertMemory(seeded, memory('m-a', 'Surface ranks memories by edge in-degree'));
      insertMemory(seeded, memory('m-b', 'Prompt recall reads no edges'));
      insertEdge(seeded, {
        source_id: 'm-a',
        target_id: 'm-b',
        relation_type: 'relates_to',
        strength: 0.6,
        bidirectional: true,
        status: 'active',
      });
    });

    const result = runCli(['maintenance', dir], { env: NO_LLM });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Semantic edges');
    expect(result.stderr).not.toContain('semantic-edges');
    withDb(getProjectDbPath(dir), (after) => {
      expect(getAllEdges(after).map((e) => [e.relation_type, e.classified_at, e.last_failed_at])).toEqual([
        ['relates_to', null, null],
      ]);
    });
  });
});

describe('dedupe (restatement cleanup)', () => {
  // Stored vectors stand in for the model: insertMemory tags them with the
  // current model, and dedupe only reads them — no model load, no LLM.
  const at = (degrees: number): Float32Array => {
    const r = (degrees * Math.PI) / 180;
    const v = new Float32Array(512);
    v[0] = Math.cos(r);
    v[1] = Math.sin(r);
    return v;
  };
  const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

  /** One restatement pair in each database, plus a distinct fact in the project. */
  const seedRestatements = (): Readonly<{ dir: string; env: NodeJS.ProcessEnv }> => {
    const { dir, globalDbPath } = freshProject();
    withDb(getProjectDbPath(dir), (db) => {
      insertMemory(db, memory('p-old', 'Deploys run the release script', { vector: at(0), createdAt: day(0) }));
      insertMemory(db, memory('p-new', 'Run the release script to deploy', { vector: at(3), createdAt: day(1) }));
      insertMemory(db, memory('p-other', 'Surface ranks by in-degree', { vector: at(70), createdAt: day(0) }));
    });
    withDb(globalDbPath, (db) => {
      insertMemory(db, memory('g-old', 'Prefer pure functions', { vector: at(0), createdAt: day(0), scope: 'global' }));
      insertMemory(db, memory('g-new', 'Pure functions are preferred', { vector: at(2), createdAt: day(1), scope: 'global' }));
    });
    return { dir, env: { ...NO_LLM, CORTEX_GLOBAL_DB: globalDbPath } };
  };

  /** Every memory's status, active or not, by id. */
  const statuses = (path: string): Record<string, string> =>
    withDb(path, (db) =>
      Object.fromEntries(
        (db.prepare('SELECT id, status FROM memories').all() as { id: string; status: string }[]).map((row) => [row.id, row.status])
      )
    );

  it('--dry-run reports the plan for both databases and writes nothing', () => {
    const { dir, env } = seedRestatements();

    const result = runCli(['dedupe', dir, '--dry-run'], { env });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dedupe would supersede 2 restatement(s) (project 1, global 1)');
    expect(result.stdout).toContain('supersede p-old');
    expect(result.stdout).toContain('supersede g-old');
    expect(statuses(getProjectDbPath(dir))).toEqual({ 'p-old': 'active', 'p-new': 'active', 'p-other': 'active' });
  });

  it('supersedes the older restatement in each database, and a second run finds nothing', () => {
    const { dir, env } = seedRestatements();

    const first = runCli(['dedupe', dir], { env });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Dedupe superseded 2 restatement(s) (project 1, global 1)');
    expect(statuses(getProjectDbPath(dir))).toEqual({ 'p-old': 'superseded', 'p-new': 'active', 'p-other': 'active' });
    expect(statuses(String(env.CORTEX_GLOBAL_DB))).toEqual({ 'g-old': 'superseded', 'g-new': 'active' });

    const second = runCli(['dedupe', dir], { env });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('Dedupe superseded 0 restatement(s) (project 0, global 0)');
  });

  it('runs as a maintenance step', () => {
    const { dir, env } = seedRestatements();

    const result = runCli(['maintenance', dir], { env });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dedupe superseded 2 restatement(s)');
    expect(statuses(getProjectDbPath(dir))['p-old']).toBe('superseded');
  });
});
