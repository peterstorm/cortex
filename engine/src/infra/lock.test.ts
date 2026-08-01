import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, releaseLock } from './lock.js';

const directories: string[] = [];

function lockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cortex-lock-'));
  directories.push(directory);
  return join(directory, 'nested', 'worker.lock');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PID lock', () => {
  it('allows one holder and rejects a concurrent holder', () => {
    const path = lockPath();

    expect(acquireLock(path)).toEqual({ acquired: true });
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
    expect(acquireLock(path)).toEqual({ acquired: false, reason: 'held' });
  });

  it('reclaims a lock whose holder no longer exists', () => {
    const path = lockPath();
    expect(acquireLock(path)).toEqual({ acquired: true });
    releaseLock(path);
    writeFileSync(path, '2147483647', 'utf8');

    expect(acquireLock(path)).toEqual({ acquired: true });
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
  });

  it('does not delete a lock owned by another process', () => {
    const path = lockPath();
    expect(acquireLock(path)).toEqual({ acquired: true });
    writeFileSync(path, '2', 'utf8');

    releaseLock(path);

    expect(readFileSync(path, 'utf8')).toBe('2');
  });
});
