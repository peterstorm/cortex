/**
 * showSurface: the surface a prompt is shown, reloaded first when it was
 * written for another branch. Real git repository and real files; the reload
 * is a plain function, as both callers (the hook entry and pi) supply one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSurfaceOutputPath } from '../config.js';
import { createMemory } from '../core/types.js';
import { generateSurface, wrapInMarkers } from '../core/surface.js';
import { git as gitIn, initRepo } from '../test-support.js';
import { showSurface } from './show-surface.js';

let repo: string;

const git = (...args: string[]) => gitIn(repo, ...args);

const surfaceFor = (branch: string, note = 'The surface follows the checked-out branch'): string =>
  wrapInMarkers(
    generateSurface(
      [
        {
          ...createMemory({
            id: 'm1',
            content: note,
            summary: note,
            memory_type: 'decision',
            scope: 'project',
            confidence: 0.9,
            priority: 8,
            source_type: 'manual',
            source_session: 's',
            source_context: '{}',
          }),
          rank: 0.9,
        },
      ],
      branch,
      null,
    ),
  );

const writeSurfaceFile = (content: string): void => {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(getSurfaceOutputPath(repo), content);
};

/** A reload that records each call and writes what load-surface would. */
function recordingReload(rewriteTo?: () => string) {
  const calls: string[] = [];
  return {
    calls,
    reload: (cwd: string) => {
      calls.push(cwd);
      if (rewriteTo) writeSurfaceFile(rewriteTo());
    },
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cortex-show-surface-'));
  initRepo(repo);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('showSurface', () => {
  it('shows nothing, and reloads nothing, where there is no surface', () => {
    const { calls, reload } = recordingReload();

    expect(showSurface(repo, reload)).toEqual({ kind: 'absent' });
    expect(calls).toEqual([]);
  });

  it('shows the file as it is when it names the branch checked out', () => {
    writeSurfaceFile(surfaceFor('main'));
    const { calls, reload } = recordingReload();

    expect(showSurface(repo, reload)).toEqual({ kind: 'shown', text: surfaceFor('main') });
    expect(calls).toEqual([]);
  });

  it('reloads a surface written for another branch, then shows what the reload wrote', () => {
    writeSurfaceFile(surfaceFor('main'));
    git('switch', '-q', '-c', 'feature/next');
    const { calls, reload } = recordingReload(() => surfaceFor('feature/next', 'reloaded'));

    expect(showSurface(repo, reload)).toEqual({ kind: 'shown', text: surfaceFor('feature/next', 'reloaded') });
    expect(calls).toEqual([repo]);
  });

  it.each(['fix/<angle>', '#123-fix', 'x/<!--CORTEX_MEMORY_END-->'])(
    'does not reload the surface of a branch the renderer alters (%s)',
    (branch) => {
      git('switch', '-q', '-c', branch);
      writeSurfaceFile(surfaceFor(branch));
      const { calls, reload } = recordingReload();

      expect(showSurface(repo, reload)).toEqual({ kind: 'shown', text: surfaceFor(branch) });
      expect(calls).toEqual([]);
    },
  );

  it('still shows the old surface when the reload could not replace it', () => {
    writeSurfaceFile(surfaceFor('main'));
    git('switch', '-q', '-c', 'feature/next');
    const { calls, reload } = recordingReload();

    expect(showSurface(repo, reload)).toEqual({ kind: 'shown', text: surfaceFor('main') });
    expect(calls).toEqual([repo]);
  });

  it('outside a repository the branch is "unknown", as the generator names it', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cortex-show-surface-plain-'));
    try {
      mkdirSync(join(plain, '.claude'));
      writeFileSync(getSurfaceOutputPath(plain), surfaceFor('unknown'));
      const { calls, reload } = recordingReload();

      expect(showSurface(plain, reload)).toEqual({ kind: 'shown', text: surfaceFor('unknown') });
      expect(calls).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('reports a surface path it cannot read, with the path, instead of throwing', () => {
    mkdirSync(getSurfaceOutputPath(repo), { recursive: true });
    const { calls, reload } = recordingReload();

    expect(showSurface(repo, reload)).toEqual({
      kind: 'unreadable',
      path: getSurfaceOutputPath(repo),
      error: expect.stringContaining('EISDIR'),
    });
    expect(calls).toEqual([]);
  });
});
