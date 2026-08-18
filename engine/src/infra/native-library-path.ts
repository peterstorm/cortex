/**
 * Make onnxruntime's native library loadable before anything tries to load it.
 *
 * Local embedding is cortex's ONLY embedding provider, and it reaches
 * onnxruntime-node through transformers.js. That native module links against
 * libstdc++, which on a normal distribution sits on the default loader path and
 * on NixOS does not: it lives in a `/nix/store/...-gcc-<version>-lib/lib`
 * output that nothing puts on `LD_LIBRARY_PATH` for a process the user did not
 * launch from a dev shell. The failure is `ERR_DLOPEN_FAILED: libstdc++.so.6:
 * cannot open shared object file`, and because callers degrade to Jaccard-only
 * similarity when the model will not load, it costs vectors rather than
 * crashing — the quiet kind of broken.
 *
 * The two hook scripts already probed the store in bash. That covered the hook
 * path and nothing else: every documented direct invocation — `/remember`,
 * `/recall`, a manual `bun cli.ts backfill` — ran without the variable and
 * embedded nothing. The rule belongs where every entry point shares it.
 *
 * Why a re-exec rather than setting `process.env`: glibc reads
 * `LD_LIBRARY_PATH` once, when the process starts, and caches the search path
 * it derives. Assigning to `process.env.LD_LIBRARY_PATH` afterwards changes a
 * string the loader will never consult again, so a later `dlopen` fails exactly
 * as before. The variable has to be in place before the process begins, which
 * means a new process.
 *
 * The re-exec is self-limiting. It happens only when libstdc++ cannot already
 * be resolved, so the hook scripts' bash probe keeps them on the fast path
 * (they set the variable, the check passes, no second process), and on any
 * system where the library is where it belongs this module does nothing at all.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where a loader looks when `LD_LIBRARY_PATH` does not say otherwise. */
const DEFAULT_LIBRARY_DIRECTORIES = [
  '/run/current-system/sw/lib',
  '/usr/local/lib',
  '/usr/lib64',
  '/usr/lib',
  '/lib64',
  '/lib',
  '/usr/lib/x86_64-linux-gnu',
] as const;

const SONAME = 'libstdc++.so.6';
const NIX_STORE = '/nix/store';
const GCC_LIB_OUTPUT = /^.+-gcc-(\d+)\.(\d+)\.(\d+)-lib$/;

/** Set on the child so a failed probe can never fork forever. */
export const REEXEC_GUARD_ENV = 'CORTEX_NATIVE_LIB_REEXEC';
/** Pins the directory explicitly, skipping the store probe entirely. */
export const PINNED_PATH_ENV = 'CORTEX_ONNX_LD_PATH';

/**
 * Is this a 64-bit ELF shared object?
 *
 * The store also holds 32-bit gcc outputs. Choosing one fails at `dlopen` with
 * "wrong ELF class: ELFCLASS32", which reaches the caller as the same generic
 * embedding failure as everything else — so the class is checked rather than
 * assumed. Byte 4 of an ELF header is `EI_CLASS`, where 2 means 64-bit; the
 * four bytes before it are the magic that proves this is an ELF file at all.
 */
function isElf64(path: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const header = Buffer.alloc(5);
    if (readSync(descriptor, header, 0, 5, 0) !== 5) return false;
    return header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c &&
      header[3] === 0x46 && header[4] === 2;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* the descriptor is already gone */ }
    }
  }
}

function librarySearchDirectories(environment: NodeJS.ProcessEnv): readonly string[] {
  const configured = (environment.LD_LIBRARY_PATH ?? '').split(':').filter((entry) => entry.length > 0);
  return [...configured, ...DEFAULT_LIBRARY_DIRECTORIES];
}

/** Can the loader already find a usable libstdc++ without our help? */
export function resolvesNatively(environment: NodeJS.ProcessEnv = process.env): boolean {
  return librarySearchDirectories(environment).some((directory) => isElf64(join(directory, SONAME)));
}

/**
 * The newest 64-bit gcc lib output in the store, or null.
 *
 * Newest rather than first-found: libstdc++ is backward compatible, so the
 * highest version satisfies every consumer that any older one would, and a
 * glob's first match is ordered by store hash — which is to say, arbitrarily,
 * and differently on two machines running identical configurations.
 */
export function probeStoreLibraryDirectory(storeRoot: string = NIX_STORE): string | null {
  let entries: readonly string[];
  try {
    entries = readdirSync(storeRoot);
  } catch {
    return null;
  }
  const candidates = entries
    .map((name) => ({ name, version: GCC_LIB_OUTPUT.exec(name) }))
    .filter((candidate): candidate is { name: string; version: RegExpExecArray } => candidate.version !== null)
    .map(({ name, version }) => ({
      directory: join(storeRoot, name, 'lib'),
      order: [Number(version[1]), Number(version[2]), Number(version[3])] as const,
    }))
    .sort((left, right) =>
      right.order[0] - left.order[0] || right.order[1] - left.order[1] || right.order[2] - left.order[2] ||
      (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0));
  for (const { directory } of candidates) {
    if (isElf64(join(directory, SONAME))) return directory;
  }
  return null;
}

/**
 * What this process should do about its native library path.
 *
 * Separated from the act so the decision is testable without spawning
 * anything: every branch below is a pure function of the environment and the
 * filesystem, and `ensureNativeLibraryPath` only carries it out.
 */
export type NativeLibraryPathPlan =
  /** Nothing to do — already resolvable, already re-exec'd, or no candidate exists. */
  | Readonly<{ kind: 'proceed' }>
  /** Re-run this exact process with the directory prepended to LD_LIBRARY_PATH. */
  | Readonly<{ kind: 're-exec'; libraryPath: string }>;

/**
 * The two filesystem questions the plan asks, as a seam.
 *
 * Without it the plan's answer depends on the machine running the test: a
 * distribution that keeps libstdc++ in `/usr/lib` resolves natively and every
 * re-exec case becomes unreachable, so the interesting half of this module
 * would be provably tested only on NixOS.
 */
export type NativeLibraryProbes = Readonly<{
  resolves: (environment: NodeJS.ProcessEnv) => boolean;
  probeStore: () => string | null;
  isDirectory: (path: string) => boolean;
}>;

const FILESYSTEM_PROBES: NativeLibraryProbes = Object.freeze({
  resolves: resolvesNatively,
  probeStore: () => probeStoreLibraryDirectory(),
  isDirectory: existsSync,
});

export function planNativeLibraryPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probes: NativeLibraryProbes = FILESYSTEM_PROBES,
): NativeLibraryPathPlan {
  if (platform !== 'linux') return { kind: 'proceed' };
  if (environment[REEXEC_GUARD_ENV] === '1') return { kind: 'proceed' };
  if (probes.resolves(environment)) return { kind: 'proceed' };
  const pinned = environment[PINNED_PATH_ENV];
  const directory = pinned !== undefined && pinned.length > 0 && probes.isDirectory(pinned)
    ? pinned
    : probes.probeStore();
  if (directory === null) return { kind: 'proceed' };
  const existing = environment.LD_LIBRARY_PATH;
  return {
    kind: 're-exec',
    libraryPath: existing === undefined || existing.length === 0 ? directory : `${directory}:${existing}`,
  };
}

/**
 * Carry out the plan. Returns only when the caller should keep running; on a
 * re-exec it runs the child to completion and exits with the child's status,
 * so stdin, stdout, stderr, and the exit code all pass through untouched — a
 * hook piping JSON in and reading a surface out cannot tell the difference.
 */
export function ensureNativeLibraryPath(): void {
  const plan = planNativeLibraryPath();
  if (plan.kind === 'proceed') return;
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    env: { ...process.env, LD_LIBRARY_PATH: plan.libraryPath, [REEXEC_GUARD_ENV]: '1' },
    stdio: 'inherit',
  });
  process.exit(child.status ?? 1);
}
