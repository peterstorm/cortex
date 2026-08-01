/**
 * PID-based file locking for detached Cortex workers.
 *
 * Lock files contain the holder PID. Creation is atomic and stale locks are
 * reclaimed when the recorded process no longer exists.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LockAcquisition =
  | Readonly<{ acquired: true }>
  | Readonly<{ acquired: false; reason: 'held' | 'io-error' }>;

/** Acquire an exclusive PID lock without waiting. */
export function acquireLock(lockFile: string): LockAcquisition {
  try {
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return { acquired: true };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      return { acquired: false, reason: 'io-error' };
    }
  }

  try {
    const holder = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
    if (!Number.isInteger(holder) || holder <= 0) {
      return { acquired: false, reason: 'io-error' };
    }

    try {
      process.kill(holder, 0);
      return { acquired: false, reason: 'held' };
    } catch {
      unlinkSync(lockFile);
      try {
        writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
        process.stderr.write(`[cortex:lock] INFO: Reclaimed stale lock from PID ${holder}\n`);
        return { acquired: true };
      } catch (error: unknown) {
        return {
          acquired: false,
          reason: (error as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'held' : 'io-error',
        };
      }
    }
  } catch {
    return { acquired: false, reason: 'io-error' };
  }
}

/** Release a lock owned by the current process. */
export function releaseLock(lockFile: string): void {
  try {
    const holder = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
    if (holder === process.pid) unlinkSync(lockFile);
  } catch {
    // Idempotent cleanup: missing/unreadable locks require no action.
  }
}
