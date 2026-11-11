/**
 * Where a session's project memory lives.
 *
 * A project is a repository, not a directory. Every worktree of a repository,
 * and every subdirectory a session might start in, shares one memory
 * database: the one in the repository's main worktree. Branches never split
 * memory — the branch is a ranking signal on each memory, not a separate
 * store.
 *
 * Three cases:
 * - **directory** — not inside a git repository: the directory itself, as
 *   before repositories were recognised.
 * - **repository** — the main worktree of the repository the session is in.
 * - **standalone** — the nearest directory, between the session and its
 *   checkout's top, holding a `.memory/standalone` marker. Its memory stays
 *   its own: a bot's workspace inside a repository must not mix its
 *   conversations into the memory of the people developing that repository.
 *
 * Pure functional core — no I/O. The shell gathers the git worktree list and
 * which candidate directories hold a marker, then calls locateProject.
 */

import { basename, dirname } from 'node:path';

/** One entry of `git worktree list --porcelain`. The first entry is the main worktree. */
export type Worktree = Readonly<{ path: string; bare: boolean }>;

/** What git says about the directory a session runs in. */
export type RepositoryProbe =
  | Readonly<{ kind: 'not-a-repository' }>
  | Readonly<{ kind: 'repository'; worktrees: readonly [Worktree, ...Worktree[]] }>;

export type ProjectScope = 'directory' | 'repository' | 'standalone';

export type ProjectLocation = Readonly<{
  /** Where the session runs: its surface file and its branch. */
  cwd: string;
  /** Where the project's memory lives: `<root>/.memory/`. */
  root: string;
  /** The project's name: the root directory's name. */
  name: string;
  scope: ProjectScope;
  /**
   * Directories whose own `.memory/cortex.db` belongs to this project and is
   * merged into the root's: subdirectories between the session and the root
   * a session once started in, and the repository's other worktrees.
   */
  strays: readonly string[];
}>;

// ============================================================================
// PARSING
// ============================================================================

/**
 * Parse `git worktree list --porcelain`: blocks separated by blank lines,
 * each starting `worktree <path>`, with a bare `bare` line for a bare
 * repository. No entry at all reads as no repository.
 */
export function parseWorktreeList(porcelain: string): RepositoryProbe {
  const worktrees = porcelain
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').map((line) => line.trim()))
    .flatMap((lines): Worktree[] => {
      const head = lines.find((line) => line.startsWith('worktree '));
      return head === undefined
        ? []
        : [{ path: head.slice('worktree '.length), bare: lines.includes('bare') }];
    });
  const [main, ...rest] = worktrees;
  return main === undefined ? { kind: 'not-a-repository' } : { kind: 'repository', worktrees: [main, ...rest] };
}

// ============================================================================
// LOCATION
// ============================================================================

const isWithin = (dir: string, ancestor: string): boolean =>
  dir === ancestor || dir.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`);

/**
 * The worktree checkout holding `cwd`: the deepest worktree path that is
 * `cwd` or one of its ancestors (worktrees may nest inside the main one).
 */
export function checkoutOf(cwd: string, worktrees: readonly Worktree[]): string | null {
  return (
    worktrees
      .filter((w) => !w.bare && isWithin(cwd, w.path))
      .map((w) => w.path)
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/** `dir`, its parent, and so on up to and including `top`. `dir` must be within `top`. */
export function directoriesUpTo(dir: string, top: string): readonly string[] {
  const dirs: string[] = [dir];
  for (let current = dir; current !== top && isWithin(current, top); ) {
    const parent = dirname(current);
    if (parent === current) break;
    dirs.push(parent);
    current = parent;
  }
  return dirs;
}

/**
 * The directories whose standalone marker the shell must check: every
 * directory from the session up to its checkout's top, and every other
 * worktree's top.
 */
export function markerCandidates(cwd: string, probe: RepositoryProbe): readonly string[] {
  if (probe.kind === 'not-a-repository') return [];
  const checkout = checkoutOf(cwd, probe.worktrees) ?? cwd;
  const worktreeTops = probe.worktrees.filter((w) => !w.bare).map((w) => w.path);
  return unique([...directoriesUpTo(cwd, checkout), ...worktreeTops]);
}

/**
 * Locate a session's project memory. `standalone` holds the candidate
 * directories (see markerCandidates) that carry a `.memory/standalone` marker.
 */
export function locateProject(
  cwd: string,
  probe: RepositoryProbe,
  standalone: ReadonlySet<string>,
): ProjectLocation {
  const at = (root: string, scope: ProjectScope, strays: readonly string[]): ProjectLocation => ({
    cwd,
    root,
    name: basename(root) || 'unknown',
    scope,
    strays: unique(strays).filter((dir) => dir !== root),
  });

  if (probe.kind === 'not-a-repository') return at(cwd, 'directory', []);

  const [main] = probe.worktrees;
  const checkout = checkoutOf(cwd, probe.worktrees) ?? cwd;
  const upward = directoriesUpTo(cwd, checkout);

  const marked = upward.findIndex((dir) => standalone.has(dir));
  if (marked !== -1) return at(upward[marked], 'standalone', upward.slice(0, marked));

  // A bare repository has no main checkout to hold memory, so each of its
  // worktrees keeps its own.
  if (main.bare) return at(checkout, 'repository', upward);

  const otherWorktrees = probe.worktrees
    .filter((w) => !w.bare && w.path !== main.path && !standalone.has(w.path))
    .map((w) => w.path);
  return at(main.path, 'repository', [...upward, ...otherWorktrees]);
}

function unique(items: readonly string[]): readonly string[] {
  return [...new Set(items)];
}
