import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PINNED_PATH_ENV,
  REEXEC_GUARD_ENV,
  planNativeLibraryPath,
  probeStoreLibraryDirectory,
  resolvesNatively,
  type NativeLibraryProbes,
} from './native-library-path.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** An ELF header of the given class: 2 is 64-bit, 1 is the 32-bit trap. */
function writeElf(path: string, elfClass: 1 | 2): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, elfClass, 0, 0, 0]));
}

/** A store holding one gcc lib output per requested version. */
function storeWith(versions: readonly string[], elfClass: 1 | 2 = 2): string {
  const store = scratch('cortex-store-');
  for (const version of versions) {
    writeElf(join(store, `abc123-gcc-${version}-lib`, 'lib', 'libstdc++.so.6'), elfClass);
  }
  return store;
}

describe('resolving libstdc++ before onnxruntime needs it', () => {
  it('sees a library the loader would already find through LD_LIBRARY_PATH', () => {
    const directory = scratch('cortex-lib-');
    writeElf(join(directory, 'libstdc++.so.6'), 2);

    expect(resolvesNatively({ LD_LIBRARY_PATH: directory })).toBe(true);
    expect(resolvesNatively({ LD_LIBRARY_PATH: `${directory}-absent` })).toBe(false);
  });

  it('rejects a 32-bit library rather than letting dlopen fail on ELF class', () => {
    const directory = scratch('cortex-lib32-');
    writeElf(join(directory, 'libstdc++.so.6'), 1);

    // Accepting this is the failure the ELF check exists to prevent: dlopen
    // reports "wrong ELF class: ELFCLASS32", which reaches the caller as the
    // same generic embedding failure as a missing library.
    expect(resolvesNatively({ LD_LIBRARY_PATH: directory })).toBe(false);
  });

  it('picks the newest gcc output, not whichever hash sorts first', () => {
    const store = storeWith(['15.2.0', '9.5.0', '15.3.0', '15.2.1']);

    expect(probeStoreLibraryDirectory(store)).toBe(join(store, 'abc123-gcc-15.3.0-lib', 'lib'));
  });

  it('finds nothing in a store with no usable gcc output', () => {
    expect(probeStoreLibraryDirectory(storeWith(['15.3.0'], 1))).toBeNull();
    expect(probeStoreLibraryDirectory(storeWith([]))).toBeNull();
    expect(probeStoreLibraryDirectory(join(scratch('cortex-absent-'), 'nope'))).toBeNull();
  });
});

describe('the native library path plan', () => {
  /** A machine where nothing resolves and the store holds `/gcc/lib`. */
  const nixLike: NativeLibraryProbes = {
    resolves: () => false,
    probeStore: () => '/gcc/lib',
    isDirectory: () => true,
  };
  const resolving: NativeLibraryProbes = { ...nixLike, resolves: () => true };

  it('proceeds when the library already resolves — the hook scripts stay on the fast path', () => {
    expect(planNativeLibraryPath({ LD_LIBRARY_PATH: '/somewhere' }, 'linux', resolving))
      .toEqual({ kind: 'proceed' });
  });

  it('proceeds on a platform with no such loader convention', () => {
    expect(planNativeLibraryPath({}, 'darwin', nixLike)).toEqual({ kind: 'proceed' });
    expect(planNativeLibraryPath({}, 'win32', nixLike)).toEqual({ kind: 'proceed' });
  });

  it('never re-execs a process that is already the re-exec', () => {
    // Without the guard this would plan a re-exec forever: the child inherits
    // the same unresolvable default path that made the parent spawn it.
    expect(planNativeLibraryPath({ [REEXEC_GUARD_ENV]: '1' }, 'linux', nixLike))
      .toEqual({ kind: 'proceed' });
  });

  it('proceeds when there is no candidate to point at', () => {
    expect(planNativeLibraryPath({}, 'linux', { ...nixLike, probeStore: () => null }))
      .toEqual({ kind: 'proceed' });
  });

  it('prepends the probed directory, preserving an existing LD_LIBRARY_PATH', () => {
    expect(planNativeLibraryPath({ LD_LIBRARY_PATH: '/other/lib' }, 'linux', nixLike))
      .toEqual({ kind: 're-exec', libraryPath: '/gcc/lib:/other/lib' });
    expect(planNativeLibraryPath({}, 'linux', nixLike))
      .toEqual({ kind: 're-exec', libraryPath: '/gcc/lib' });
  });

  it('prefers a pinned directory over the store probe, and ignores one that is absent', () => {
    expect(planNativeLibraryPath({ [PINNED_PATH_ENV]: '/pinned/lib' }, 'linux', nixLike))
      .toEqual({ kind: 're-exec', libraryPath: '/pinned/lib' });
    expect(planNativeLibraryPath(
      { [PINNED_PATH_ENV]: '/pinned/lib' },
      'linux',
      { ...nixLike, isDirectory: () => false },
    )).toEqual({ kind: 're-exec', libraryPath: '/gcc/lib' });
  });
});
