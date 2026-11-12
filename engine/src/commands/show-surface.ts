/**
 * Show-surface command: the push surface a prompt is shown, for the branch
 * checked out now.
 *
 * The surface file beside a session is written for one branch, at session
 * start and after each session ends. A `git switch` in between leaves the
 * previous branch's surface on disk, and it would be shown, under the wrong
 * branch name, until the next session. So before a prompt is shown the
 * surface, its branch header is checked against the checked-out branch, and on
 * a mismatch the surface is reloaded first.
 *
 * The one implementation for both harnesses: Claude Code's UserPromptSubmit
 * hook reaches it through the show-surface.ts entry, and the pi extension
 * calls it in-process before each agent start. Each passes its own way of
 * running `load-surface` as the reload.
 *
 * Imperative shell: file and git reads here; the comparison is
 * surfaceIsForBranch in core/surface.ts, next to the renderer it must agree
 * with.
 */

import { readFileSync } from 'node:fs';
import { getSurfaceOutputPath } from '../config.js';
import { surfaceIsForBranch } from '../core/surface.js';
import { getCurrentBranch } from '../infra/git-context.js';

/**
 * Bring the surface beside `cwd` up to date for its checked-out branch: what
 * `load-surface <cwd>` does (serve that branch's cache, or regenerate). Must
 * not throw — a broken reload leaves the old surface to be shown.
 */
export type ReloadSurface = (cwd: string) => void;

/** What a prompt is shown. */
export type ShownSurface =
  /** No surface file: the project does not use cortex, or has nothing to show. */
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'shown'; text: string }>
  /** The file is there but could not be read; the caller reports it. */
  | Readonly<{ kind: 'unreadable'; path: string; error: string }>;

function readSurface(path: string): ShownSurface {
  try {
    return { kind: 'shown', text: readFileSync(path, 'utf8') };
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', path, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The surface beside `cwd`, reloaded first when it was written for a branch
 * other than the one checked out. Never throws.
 *
 * The branch is read only when there is a surface to compare, so a project
 * without cortex costs one failed file read.
 */
export function showSurface(cwd: string, reload: ReloadSurface): ShownSurface {
  const path = getSurfaceOutputPath(cwd);
  const current = readSurface(path);
  if (current.kind !== 'shown' || surfaceIsForBranch(current.text, getCurrentBranch(cwd))) {
    return current;
  }
  reload(cwd);
  return readSurface(path);
}
