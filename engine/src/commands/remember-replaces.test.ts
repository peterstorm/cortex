/**
 * `remember --replaces=<tag>`: the new memory supersedes every other active
 * memory carrying the tag in its own database (pinned ones included), carries
 * the tag itself, and is not duplicate-checked against what it replaces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'bun:sqlite';
import { executeRemember, parseRememberArgs, type RememberResult, type RememberError } from './remember.js';
import { createMemory, type MemoryScope, type MemoryStatus } from '../core/types.js';
import { openDatabase, insertMemory, getMemory, getAllEdges } from '../infra/db.js';

const DEPLOY_STEPS = 'Deploy by running the release script, then tagging the commit';

const seedTagged = (
  db: Database,
  id: string,
  extra: Readonly<{
    tags?: readonly string[];
    pinned?: boolean;
    priority?: number;
    status?: MemoryStatus;
    scope?: MemoryScope;
  }> = {}
): void => {
  insertMemory(
    db,
    createMemory({
      id,
      content: `${DEPLOY_STEPS} (${id})`,
      summary: `${DEPLOY_STEPS} (${id})`,
      memory_type: 'decision',
      scope: extra.scope ?? 'project',
      confidence: 1,
      priority: extra.priority ?? 5,
      pinned: extra.pinned ?? false,
      source_type: 'manual',
      source_session: 'older',
      source_context: '{}',
      tags: extra.tags ?? ['deploy'],
      status: extra.status ?? 'active',
    })
  );
};

const succeeded = (result: RememberResult | RememberError): RememberResult => {
  if (!result.success) throw new Error(`remember failed: ${result.error}`);
  return result;
};

describe('parseRememberArgs --replaces', () => {
  const parse = (...flags: string[]) => parseRememberArgs(['new version', ...flags], 'sess');

  it('adds the replaced tag to the new memory', () => {
    const parsed = parse('--tags=ops', '--replaces=deploy');
    expect(parsed).toMatchObject({ success: true, args: { replaces: 'deploy', tags: ['ops', 'deploy'] } });
  });

  it('does not repeat a tag already given in --tags', () => {
    const parsed = parse('--replaces=deploy', '--tags=deploy,ops');
    expect(parsed).toMatchObject({ success: true, args: { tags: ['deploy', 'ops'] } });
  });

  it('defaults to replacing nothing', () => {
    expect(parse()).toMatchObject({ success: true, args: { replaces: null } });
  });

  it.each([
    ['--replaces=', 'needs a tag'],
    ['--replaces=a,b', 'comma'],
    ['--replaces=two words', 'whitespace'],
  ])('refuses %j at the CLI boundary', (flag, message) => {
    const parsed = parse(flag);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error).toContain(message);
  });
});

describe('executeRemember --replaces', () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = openDatabase(':memory:');
    globalDb = openDatabase(':memory:');
  });

  afterEach(() => {
    projectDb.close();
    globalDb.close();
  });

  it('supersedes every other active tagged memory in the target database, pinned included', async () => {
    seedTagged(projectDb, 'v1');
    seedTagged(projectDb, 'v1-pinned', { pinned: true });
    seedTagged(projectDb, 'v0-archived', { status: 'archived' });
    seedTagged(projectDb, 'unrelated', { tags: ['ops'] });
    seedTagged(globalDb, 'global-v1', { scope: 'global' });

    const result = succeeded(
      await executeRemember([`${DEPLOY_STEPS}, now with a canary`, '--replaces=deploy'], 's', projectDb, globalDb)
    );

    expect([...result.superseded].sort()).toEqual(['v1', 'v1-pinned']);
    expect(getMemory(projectDb, 'v1')?.status).toBe('superseded');
    expect(getMemory(projectDb, 'v1-pinned')?.status).toBe('superseded');
    expect(getMemory(projectDb, 'v0-archived')?.status).toBe('archived');
    expect(getMemory(projectDb, 'unrelated')?.status).toBe('active');
    expect(getMemory(globalDb, 'global-v1')?.status).toBe('active');

    const created = getMemory(projectDb, result.memory_id);
    expect(created?.tags).toContain('deploy');
    expect(created?.status).toBe('active');

    const supersedes = getAllEdges(projectDb).filter((e) => e.relation_type === 'supersedes');
    expect(supersedes.map((e) => [e.source_id, e.target_id]).sort()).toEqual(
      [[result.memory_id, 'v1'], [result.memory_id, 'v1-pinned']].sort()
    );
  });

  it('carries the pin and the highest priority forward to the replacement', async () => {
    seedTagged(projectDb, 'v1-pinned', { pinned: true, priority: 9 });
    seedTagged(projectDb, 'v1-plain', { priority: 3 });

    const result = succeeded(await executeRemember(['deploy v2', '--replaces=deploy'], 's', projectDb, globalDb));

    const created = getMemory(projectDb, result.memory_id);
    expect(created).toMatchObject({ pinned: true, priority: 9, status: 'active' });
    expect(result.message).toContain('priority 9, pinned');
  });

  it('leaves an unpinned replacement unpinned at its own priority when nothing it replaces outranks it', async () => {
    seedTagged(projectDb, 'v1', { priority: 3 });

    const result = succeeded(
      await executeRemember(['deploy v2', '--replaces=deploy', '--priority=6'], 's', projectDb, globalDb)
    );

    expect(getMemory(projectDb, result.memory_id)).toMatchObject({ pinned: false, priority: 6 });
  });

  it('replaces in the global database when the new memory is global', async () => {
    seedTagged(projectDb, 'project-v1');
    seedTagged(globalDb, 'global-v1', { scope: 'global' });

    const result = succeeded(
      await executeRemember(['global v2', '--scope=global', '--replaces=deploy'], 's', projectDb, globalDb)
    );

    expect(result.superseded).toEqual(['global-v1']);
    expect(getMemory(globalDb, 'global-v1')?.status).toBe('superseded');
    expect(getMemory(projectDb, 'project-v1')?.status).toBe('active');
  });

  it('skips the duplicate check: a near-identical new version is stored, not refused', async () => {
    seedTagged(projectDb, 'v1');
    const restated = `${DEPLOY_STEPS} (v1)`;

    const refused = await executeRemember([restated], 's', projectDb, globalDb);
    expect(refused.success).toBe(false);

    const result = succeeded(await executeRemember([restated, '--replaces=deploy'], 's', projectDb, globalDb));
    expect(result.superseded).toEqual(['v1']);
  });

  it('each new version supersedes the previous one', async () => {
    const v2 = succeeded(await executeRemember(['deploy v2', '--replaces=deploy'], 's', projectDb, globalDb));
    expect(v2.superseded).toEqual([]);

    const v3 = succeeded(await executeRemember(['deploy v3', '--replaces=deploy'], 's', projectDb, globalDb));
    expect(v3.superseded).toEqual([v2.memory_id]);
    expect(getMemory(projectDb, v2.memory_id)?.status).toBe('superseded');
  });

  it('reports nothing superseded without the flag', async () => {
    seedTagged(projectDb, 'v1');
    const result = succeeded(await executeRemember(['something else entirely', '--tags=deploy'], 's', projectDb, globalDb));
    expect(result.superseded).toEqual([]);
    expect(getMemory(projectDb, 'v1')?.status).toBe('active');
  });

  it('rejects an invalid tag without writing', async () => {
    seedTagged(projectDb, 'v1');
    const result = await executeRemember(['v2', '--replaces=a,b'], 's', projectDb, globalDb);
    expect(result.success).toBe(false);
    expect(getMemory(projectDb, 'v1')?.status).toBe('active');
  });
});
