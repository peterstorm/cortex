/**
 * Loaded before every test file (bunfig.toml). Points the global database at
 * a throwaway file for the test process and every CLI it spawns, which
 * inherit the environment. With CORTEX_GLOBAL_DB set, the merge of the
 * per-harness databases never runs, so no test can read, write or move the
 * real ones under ~/.claude, ~/.pi or ~/.local/share.
 *
 * Tests of the merge itself call migrateGlobalDb and resolveGlobalDbPath with
 * explicit paths under their own temp directories.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cortex-test-global-'));
process.env.CORTEX_GLOBAL_DB = join(dir, 'global.db');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
