import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  checkoutOf,
  directoriesUpTo,
  locateProject,
  markerCandidates,
  parseWorktreeList,
  type RepositoryProbe,
  type Worktree,
} from './project-location.js';

const repo = (...worktrees: [Worktree, ...Worktree[]]): RepositoryProbe => ({ kind: 'repository', worktrees });
const wt = (path: string, bare = false): Worktree => ({ path, bare });
const none = new Set<string>();

describe('parseWorktreeList', () => {
  it('reads every worktree, main first, and marks a bare one', () => {
    const porcelain = [
      'worktree /dev/loom',
      'HEAD 1111',
      'branch refs/heads/main',
      '',
      'worktree /dev/loom-security-audit',
      'HEAD 2222',
      'branch refs/heads/security-audit',
      '',
      'worktree /dev/loom-gone',
      'HEAD 3333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    expect(parseWorktreeList(porcelain)).toEqual(
      repo(wt('/dev/loom'), wt('/dev/loom-security-audit'), wt('/dev/loom-gone')),
    );
    expect(parseWorktreeList('worktree /srv/repo.git\nbare\n')).toEqual(repo(wt('/srv/repo.git', true)));
  });

  it('reads no output as no repository', () => {
    expect(parseWorktreeList('')).toEqual({ kind: 'not-a-repository' });
  });

  it('keeps a path with spaces whole', () => {
    expect(parseWorktreeList('worktree /home/u/my repo\nHEAD 1\n')).toEqual(repo(wt('/home/u/my repo')));
  });
});

describe('checkoutOf and directoriesUpTo', () => {
  it('picks the deepest worktree holding the directory, never a sibling with a shared prefix', () => {
    const worktrees = [wt('/dev/loom'), wt('/dev/loom/.worktrees/x'), wt('/dev/loom-x')];
    expect(checkoutOf('/dev/loom/.worktrees/x/engine', worktrees)).toBe('/dev/loom/.worktrees/x');
    expect(checkoutOf('/dev/loom-x/engine', worktrees)).toBe('/dev/loom-x');
    expect(checkoutOf('/elsewhere', worktrees)).toBeNull();
  });

  it('walks from a directory up to the top, both included', () => {
    expect(directoriesUpTo('/r/a/b', '/r')).toEqual(['/r/a/b', '/r/a', '/r']);
    expect(directoriesUpTo('/r', '/r')).toEqual(['/r']);
  });

  it('every directory it walks is within the top and contains the start (property)', () => {
    const segment = fc.stringMatching(/^[a-z]{1,4}$/);
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 4 }), fc.array(segment, { maxLength: 4 }), (topParts, below) => {
        const top = `/${['r', ...topParts].join('/')}`;
        const start = [top, ...below].join('/');
        const walked = directoriesUpTo(start, top);
        expect(walked[0]).toBe(start);
        expect(walked.at(-1)).toBe(top);
        expect(walked).toHaveLength(below.length + 1);
        for (const dir of walked) expect(start === dir || start.startsWith(`${dir}/`)).toBe(true);
      }),
    );
  });
});

describe('locateProject', () => {
  it('outside a repository, the directory is the project, as before', () => {
    expect(locateProject('/tmp/scratch', { kind: 'not-a-repository' }, none)).toEqual({
      cwd: '/tmp/scratch',
      root: '/tmp/scratch',
      name: 'scratch',
      scope: 'directory',
      strays: [],
    });
  });

  it('names a project after its root directory, and the filesystem root "unknown"', () => {
    expect(locateProject('/home/u/my-project', { kind: 'not-a-repository' }, none).name).toBe('my-project');
    expect(locateProject('/', { kind: 'not-a-repository' }, none).name).toBe('unknown');
  });

  it('a subdirectory of the main checkout shares the repository root, and its own DB is a stray', () => {
    const location = locateProject('/dev/loom/engine/src', repo(wt('/dev/loom')), none);
    expect(location).toMatchObject({ root: '/dev/loom', name: 'loom', scope: 'repository' });
    expect(location.strays).toEqual(['/dev/loom/engine/src', '/dev/loom/engine']);
  });

  it('a linked worktree uses the main worktree, under the repository name, not its own', () => {
    const probe = repo(wt('/dev/loom'), wt('/dev/loom-security-audit'), wt('/dev/loom-deterministic-next'));
    const location = locateProject('/dev/loom-security-audit/engine', probe, none);
    expect(location).toMatchObject({ cwd: '/dev/loom-security-audit/engine', root: '/dev/loom', name: 'loom' });
    expect(location.strays).toEqual([
      '/dev/loom-security-audit/engine',
      '/dev/loom-security-audit',
      '/dev/loom-deterministic-next',
    ]);
  });

  it('a standalone marker on the way up keeps that directory to itself', () => {
    const marked = new Set(['/dev/reclaw/workspace']);
    const location = locateProject('/dev/reclaw/workspace/chats', repo(wt('/dev/reclaw')), marked);
    expect(location).toMatchObject({ root: '/dev/reclaw/workspace', name: 'workspace', scope: 'standalone' });
    expect(location.strays).toEqual(['/dev/reclaw/workspace/chats']);
  });

  it('the repository root never merges a standalone directory or worktree', () => {
    const probe = repo(wt('/dev/reclaw'), wt('/dev/reclaw-bot'));
    const location = locateProject('/dev/reclaw', probe, new Set(['/dev/reclaw-bot']));
    expect(location).toMatchObject({ root: '/dev/reclaw', scope: 'repository', strays: [] });
  });

  it('each worktree of a bare repository keeps its own memory', () => {
    const probe = repo(wt('/srv/repo.git', true), wt('/srv/main'), wt('/srv/feature'));
    expect(locateProject('/srv/feature/src', probe, none)).toMatchObject({
      root: '/srv/feature',
      strays: ['/srv/feature/src'],
    });
  });

  it('every worktree and subdirectory of one repository lands on the same root, never in its own strays (property)', () => {
    const name = fc.stringMatching(/^[a-z]{1,5}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(name, { minLength: 1, maxLength: 4 }),
        fc.array(name, { maxLength: 3 }),
        fc.nat(),
        (worktreeNames, below, pick) => {
          const worktrees = worktreeNames.map((n) => wt(`/dev/${n}`)) as [Worktree, ...Worktree[]];
          const start = [worktrees[pick % worktrees.length].path, ...below].join('/');
          const location = locateProject(start, repo(...worktrees), none);
          expect(location.root).toBe(worktrees[0].path);
          expect(location.strays).not.toContain(location.root);
          expect(new Set(location.strays).size).toBe(location.strays.length);
        },
      ),
    );
  });
});

describe('markerCandidates', () => {
  it('lists the session up to its checkout, then every worktree top', () => {
    expect(markerCandidates('/dev/loom-x/a', repo(wt('/dev/loom'), wt('/dev/loom-x')))).toEqual([
      '/dev/loom-x/a',
      '/dev/loom-x',
      '/dev/loom',
    ]);
    expect(markerCandidates('/tmp/x', { kind: 'not-a-repository' })).toEqual([]);
  });
});
