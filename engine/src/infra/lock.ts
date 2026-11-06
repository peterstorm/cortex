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

/** How many create-reclaim rounds one acquisition may try before giving up. */
const ACQUIRE_ATTEMPTS = 3;

/** The PID recorded in a lock file, or null when it names none. */
function readHolderPid(lockFile: string): number | null {
  try {
    const holder = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
    return Number.isInteger(holder) && holder > 0 ? holder : null;
  } catch {
    return null;
  }
}

/** Can this PID still be signalled? `EPERM` counts as alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire an exclusive PID lock without waiting. */
export function acquireLock(lockFile: string): LockAcquisition {
  try {
    mkdirSync(dirname(lockFile), { recursive: true });
  } catch {
    return { acquired: false, reason: 'io-error' };
  }

  // Bounded retry, because reclaiming is two steps (unlink, then create) and a
  // second worker doing the same can interleave with them: our create loses to
  // EEXIST, or our unlink loses to ENOENT. Neither is a real failure — both are
  // the race resolving in the other process's favour — but the previous code
  // reported the ENOENT half as `io-error`, which is indistinguishable from an
  // unwritable filesystem and therefore never retried by the caller.
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return { acquired: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return { acquired: false, reason: 'io-error' };
      }
    }

    // A lock naming no live PID has no holder. That includes contents that
    // name no PID at all: an empty or truncated file left by a process killed
    // between open and write used to read as `io-error` forever, so extraction
    // skipped on every run and nothing could ever clear it.
    const holder = readHolderPid(lockFile);
    if (holder !== null && isProcessAlive(holder)) {
      return { acquired: false, reason: 'held' };
    }

    try {
      unlinkSync(lockFile);
      process.stderr.write(
        holder === null
          ? `[cortex:lock] INFO: Reclaimed unreadable lock ${lockFile}\n`
          : `[cortex:lock] INFO: Reclaimed stale lock from PID ${holder}\n`
      );
    } catch {
      // Another reclaimer removed it first — retry the create.
    }
  }

  // Every attempt lost the create race; someone else holds it now.
  return { acquired: false, reason: 'held' };
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
