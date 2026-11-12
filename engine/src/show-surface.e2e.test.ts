/**
 * End to end through the real UserPromptSubmit shim (hooks/scripts/
 * show-surface.sh) and the real CLI: the surface a prompt is shown always
 * names the branch that is checked out.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory } from './core/types.js';
import { insertMemory, openDatabase } from './infra/db.js';
import { git as gitIn, initRepo, runCli } from './test-support.js';

const SHIM = fileURLToPath(new URL('../../hooks/scripts/show-surface.sh', import.meta.url));

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;

const git = (...args: string[]) => gitIn(repo, ...args);

/** What the hook prints for a prompt submitted in `cwd`. */
function shown(cwd: string): string {
  const result = spawnSync('bash', [SHIM], { cwd, env, encoding: 'utf8' });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return result.stdout;
}

const surfaceFile = () => path.join(repo, '.claude', 'cortex-memory.local.md');

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cortex-show-surface-'));
  repo = path.join(root, 'repo');
  env = { ...process.env, HOME: path.join(root, 'home') };
  mkdirSync(path.join(repo, '.memory'), { recursive: true });
  initRepo(repo);

  const db = openDatabase(path.join(repo, '.memory', 'cortex.db'));
  insertMemory(
    db,
    createMemory({
      id: 'm1',
      content: 'The surface follows the checked-out branch',
      summary: 'The surface follows the checked-out branch',
      memory_type: 'decision',
      scope: 'project',
      confidence: 0.9,
      priority: 8,
      source_type: 'manual',
      source_session: 's',
      source_context: '{}',
    }),
  );
  db.close();

  const generated = runCli(['generate', repo], { env });
  expect({ status: generated.status, stderr: generated.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
}, 120_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('show-surface hook', () => {
  test('on the branch the surface was written for, prints the file as it is', () => {
    const onDisk = readFileSync(surfaceFile(), 'utf8');
    expect(onDisk).toContain('**Branch:** main');
    expect(shown(repo)).toBe(onDisk);
  });

  test('after a branch switch, reloads the surface for the new branch before printing it', () => {
    git('switch', '-q', '-c', 'feature/next');

    const output = shown(repo);

    expect(output).toContain('**Branch:** feature/next');
    expect(output).not.toContain('**Branch:** main');
    expect(output).toContain('The surface follows the checked-out branch');
    expect(readFileSync(surfaceFile(), 'utf8')).toBe(output);
  }, 120_000);

  test('keeps what the user wrote outside the markers when it reloads', () => {
    writeFileSync(surfaceFile(), `my own notes\n\n${readFileSync(surfaceFile(), 'utf8')}`);
    git('switch', '-q', 'main');

    const output = shown(repo);

    expect(output).toContain('my own notes');
    expect(output).toContain('**Branch:** main');
  }, 120_000);

  test('does not reload, prompt after prompt, the surface of a branch whose name the renderer escapes', () => {
    git('switch', '-q', '-c', 'fix/<angle>');
    const first = shown(repo);
    expect(first).toContain('**Branch:** fix/&lt;angle>');

    // A line inside the cortex block: any reload rewrites the block and drops it.
    const marked = first.replace('<!-- CORTEX_MEMORY_START -->\n', '<!-- CORTEX_MEMORY_START -->\nnot reloaded\n');
    expect(marked).not.toBe(first);
    writeFileSync(surfaceFile(), marked);

    expect(shown(repo)).toBe(marked);
    expect(shown(repo)).toBe(marked);
  }, 120_000);

  test('prints nothing, and creates nothing, where there is no surface', () => {
    const bare = path.join(root, 'bare');
    mkdirSync(bare);
    expect(shown(bare)).toBe('');
    expect(spawnSync('ls', ['-A', bare], { encoding: 'utf8' }).stdout).toBe('');
  });
});
