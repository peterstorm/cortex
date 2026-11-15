import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Real subprocesses: what this launcher promises (the command runs, sees a
// loader path where libstdc++ resolves, and hands back its own exit status)
// only exists once processes start.
const LAUNCHER = join(import.meta.dir, 'with-native-library-path.ts');
const NATIVE_PATH_MODULE = join(import.meta.dir, 'infra', 'native-library-path.ts');

const launch = (...command: string[]) =>
  spawnSync(process.execPath, [LAUNCHER, ...command], { encoding: 'utf8' });

describe('with-native-library-path', () => {
  it('gives the command a loader path on which libstdc++ resolves', () => {
    const check =
      `const { resolvesNatively } = await import(${JSON.stringify(NATIVE_PATH_MODULE)});` +
      `process.exit(resolvesNatively(process.env) ? 0 : 9);`;

    expect(launch(process.execPath, '-e', check).status).toBe(0);
  });

  it('passes the arguments through and returns the command\'s exit status', () => {
    const result = launch('sh', '-c', 'printf "%s|%s" "$0" "$1"; exit 3', 'a b', 'c');

    expect(result.stdout).toBe('a b|c');
    expect(result.status).toBe(3);
  });

  it('sets no re-exec guard, so it cannot leak into the command\'s children', () => {
    const result = launch('sh', '-c', 'printf "%s" "${CORTEX_NATIVE_LIB_REEXEC:-unset}"');

    expect(result.stdout).toBe('unset');
  });

  it('names a command it cannot start and fails', () => {
    const result = launch('cortex-no-such-command');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not run cortex-no-such-command');
  });

  it('explains its usage when given no command', () => {
    const result = launch();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
