/**
 * Loaded before every test file (bunfig.toml). Gives each test file a
 * throwaway directory and points two things at it, for the test process and
 * every CLI it spawns with the inherited environment:
 *
 * - The global database (CORTEX_GLOBAL_DB). With it set, the merge of the
 *   per-harness databases never runs, so no test can read, write or move the
 *   real ones under ~/.claude, ~/.pi or ~/.local/share.
 * - The temp directory (TMPDIR, which os.tmpdir() reads on every call). Every
 *   mkdtemp a test makes lands inside the throwaway directory, so removing
 *   that one directory removes them all, whether or not the test that made
 *   them cleans up after itself.
 *
 * Removed in afterAll: with `bun test --isolate` a file's `exit` listeners do
 * not run, and relying on them left a directory in /tmp per test file per run.
 * The `exit` listener stays for a run that dies before afterAll.
 *
 * Tests of the merge itself call migrateGlobalDb and resolveGlobalDbPath with
 * explicit paths under their own temp directories.
 */

import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cortex-test-'));
process.env.CORTEX_GLOBAL_DB = join(dir, 'global.db');
process.env.TMPDIR = dir;

const removeDir = (): void => rmSync(dir, { recursive: true, force: true });
afterAll(removeDir);
process.on('exit', removeDir);
