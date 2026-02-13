/**
 * Filesystem operations for Cortex memory system.
 * Pure, standalone functions for file I/O with PID-based locking.
 *
 * Key responsibilities:
 * - FR-024: Write push surface to `.claude/cortex-memory.local.md`
 * - FR-028: PID-based file locking to prevent concurrent writes
 * - FR-029: Detect and override stale locks (dead PID)
 * - FR-121: Write structured telemetry to `.memory/cortex-status.json`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Check if a process with given PID is running.
 * Uses signal 0 which doesn't send a signal but checks existence.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read PID from lock file, return null if file doesn't exist or invalid.
 */
function readPidFromLock(lockPath: string): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if a PID lock file is stale (process no longer running).
 * Returns false if lock doesn't exist or PID is still running.
 * Returns true if lock exists but process is dead.
 */
export function isStalePidLock(lockPath: string): boolean {
  const pid = readPidFromLock(lockPath);
  if (pid === null) {
    return false; // No lock or invalid lock
  }
  return !isProcessRunning(pid);
}

/**
 * Acquire PID lock by writing current process PID to lock file.
 * Throws if lock exists and process is still running.
 * Overrides if lock is stale.
 *
 * Uses atomic file creation (wx flag) to prevent TOCTOU race conditions.
 */
function acquirePidLock(lockPath: string): void {
  // Create parent directory if needed
  const lockDir = path.dirname(lockPath);
  fs.mkdirSync(lockDir, { recursive: true });

  // Attempt atomic lock creation (fails if file exists)
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return; // Lock acquired successfully
  } catch (e: any) {
    // If error is not EEXIST, propagate it
    if (e.code !== 'EEXIST') {
      throw e;
    }
  }

  // Lock file exists - check if stale
  const existingPid = readPidFromLock(lockPath);
  if (existingPid !== null && isProcessRunning(existingPid)) {
    throw new Error(
      `Lock file already held by running process ${existingPid}: ${lockPath}`
    );
  }

  // Stale lock - override it
  fs.writeFileSync(lockPath, String(process.pid), 'utf8');
}

/**
 * Release PID lock by deleting lock file.
 * Silently succeeds if lock doesn't exist.
 */
function releasePidLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already released or never existed
  }
}

/**
 * Execute function with PID lock protection.
 * Acquires lock, runs fn, releases lock (even on error).
 * Throws if lock is held by another running process.
 */
export function withPidLock<T>(lockPath: string, fn: () => T): T {
  acquirePidLock(lockPath);
  try {
    return fn();
  } finally {
    releasePidLock(lockPath);
  }
}

/**
 * Write surface content to file with PID lock protection.
 * Creates parent directories if needed.
 * Throws if another process holds the lock.
 */
export function writeSurface(
  filePath: string,
  content: string,
  lockDir: string
): void {
  const lockPath = path.join(lockDir, 'surface.lock');

  withPidLock(lockPath, () => {
    // Create parent directory
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // Write content
    fs.writeFileSync(filePath, content, 'utf8');
  });
}

/**
 * Read surface content from file.
 * Returns null if file doesn't exist.
 */
export function readSurface(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Ensure patterns exist in .gitignore file.
 * Creates .gitignore if it doesn't exist.
 * Appends missing patterns (no duplicates).
 */
export function ensureGitignored(
  projectRoot: string,
  patterns: readonly string[]
): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  // Read existing content
  let existingContent = '';
  try {
    existingContent = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    // File doesn't exist, will be created
  }

  const existingLines = new Set(
    existingContent.split('\n').map((line) => line.trim())
  );

  // Find missing patterns
  const missingPatterns = patterns.filter(
    (pattern) => !existingLines.has(pattern)
  );

  if (missingPatterns.length === 0) {
    return; // All patterns already present
  }

  // Append missing patterns
  const newContent = existingContent.endsWith('\n') || existingContent === ''
    ? existingContent
    : existingContent + '\n';

  const appendContent = missingPatterns.join('\n') + '\n';
  fs.writeFileSync(gitignorePath, newContent + appendContent, 'utf8');
}

/**
 * Write telemetry data as formatted JSON.
 * Creates parent directories if needed.
 */
export function writeTelemetry(
  filePath: string,
  data: Record<string, unknown>
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, json, 'utf8');
}
