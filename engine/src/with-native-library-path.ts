/**
 * Run a command with onnxruntime's libstdc++ on the loader path.
 *
 * `bun cli.ts` re-execs itself through ensureNativeLibraryPath, so every CLI
 * entry point embeds on NixOS. `bun test` has no such step: a test that imports
 * `@huggingface/transformers` loads sharp and onnxruntime at module load and
 * dies with `libstdc++.so.6: cannot open shared object file` before it can
 * check whether the model is available. Wrapping the test runner in this
 * launcher applies the same plan (planNativeLibraryPath) to it.
 *
 * Usage: bun src/with-native-library-path.ts <command> [args...]
 *
 * Unlike ensureNativeLibraryPath it sets no re-exec guard: the command is a new
 * program, not a second copy of this one, and the guard would otherwise leak
 * into every process the command starts. Stdio and the exit status pass through.
 */

import { spawnSync } from 'node:child_process';
import { planNativeLibraryPath } from './infra/native-library-path.js';

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write('usage: with-native-library-path.ts <command> [args...]\n');
  process.exit(2);
}

const plan = planNativeLibraryPath();
const child = spawnSync(command, args, {
  stdio: 'inherit',
  env: plan.kind === 're-exec' ? { ...process.env, LD_LIBRARY_PATH: plan.libraryPath } : process.env,
});
if (child.error !== undefined) {
  process.stderr.write(`with-native-library-path: could not run ${command}: ${child.error.message}\n`);
}
process.exit(child.status ?? 1);
