/**
 * PID-based file locking for detached workers.
 *
 * SessionEnd spawns detached processes (extract, semantic-edges) that can
 * overlap with each other across sessions. A per-project lock file with the
 * holder's PID prevents concurrent runs; stale locks (holder no longer
 * running) are reclaimed automatically.
 *
 * I/O boundary — all functions perform filesystem side effects.
 */

import { unlinkSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Acquire a lock file with PID. Returns true if acquired.
 * Stale locks (PID no longer running) are automatically reclaimed.
 * The lock should live in the project's .memory/locks dir — a global lock
 * would make runs for unrelated projects silently skip each other.
 */
export function acquireLock(lockFile: string): boolean {
  try {
    mkdirSync(dirname(lockFile), { recursive: true });
    // O_EXCL: atomic create-if-not-exists — eliminates TOCTOU race
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
    // Lock file exists — check if holder is still alive
    try {
      const existingPid = parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);
      if (!isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0);
          return false; // Process still alive, lock is held
        } catch {
          // Process gone, stale lock — reclaim it
          process.stderr.write(`[cortex:lock] INFO: Reclaiming stale lock from PID ${existingPid}\n`);
          unlinkSync(lockFile);
          try {
            writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
            return true;
          } catch {
            return false; // Another process beat us to reclaim
          }
        }
      }
    } catch {
      return false;
    }
    return false;
  }
}

/**
 * Release a previously acquired lock file.
 * Idempotent — a missing lock file is ignored.
 */
export function releaseLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch {
    // Ignore — lock already removed
  }
}
