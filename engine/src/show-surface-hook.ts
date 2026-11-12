/**
 * Process entry for Claude Code's UserPromptSubmit hook
 * (hooks/scripts/show-surface.sh): print the surface beside `<cwd>`, reloaded
 * first if it was written for another branch (commands/show-surface.ts).
 *
 *   bun show-surface-hook.ts <cwd>
 *
 * Its own entry rather than a cli.ts subcommand because it runs on every
 * prompt, and cli.ts imports the whole engine (SQLite, the embedding runtime)
 * before it dispatches: measured at about 105 ms per start against 40 ms for
 * this one. The reload is the one step that needs the database, so it runs
 * `cli.ts load-surface` as a child, and only when the branch changed.
 *
 * Exits 0 whatever happens: a prompt must never be blocked by its context.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { match } from 'ts-pattern';
import { showSurface, type ReloadSurface } from './commands/show-surface.js';

const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));

/**
 * The hook allows 15 s in all; a reload that has not finished in 10 leaves
 * the old surface to be shown rather than nothing.
 */
const RELOAD_TIMEOUT_MS = 10_000;

const reloadWithCli: ReloadSurface = (cwd) => {
  spawnSync(process.execPath, [CLI_PATH, 'load-surface', cwd], { stdio: 'ignore', timeout: RELOAD_TIMEOUT_MS });
};

if (import.meta.main) {
  const cwd = process.argv[2] ?? process.cwd();
  match(showSurface(cwd, reloadWithCli))
    .with({ kind: 'shown' }, ({ text }) => {
      process.stdout.write(text);
    })
    .with({ kind: 'unreadable' }, ({ path, error }) => {
      process.stderr.write(`[cortex] Failed to read memory surface ${path}: ${error}\n`);
    })
    .with({ kind: 'absent' }, () => undefined)
    .exhaustive();
}
