/**
 * The prompt-recall log: where per-prompt recall leaves its warnings.
 *
 * Prompt recall runs on every prompt, in a process whose stderr no one reads:
 * Claude Code drops a hook's stderr on exit 0, and Pi's extension pipes it and
 * keeps it only when the CLI fails. A degraded recall (embedder down → keyword
 * search) exits 0, so before this log it left no trace under either harness.
 * The engine therefore appends its own warnings here; the hook shim
 * (hooks/scripts/prompt-recall.sh) appends only what the engine cannot — the
 * stderr of a CLI that crashed — and resolves the same path the same way.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Past this size the log moves to `<log>.1` (one previous generation kept). */
export const PROMPT_RECALL_LOG_MAX_BYTES = 1_048_576;

export type PromptRecallLogEnvironment = Readonly<{
  CORTEX_LOG_DIR?: string;
  XDG_STATE_HOME?: string;
  HOME?: string;
}>;

/**
 * Pure: the log file path. Mirrors the shim's
 * `${CORTEX_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cortex}`, where an
 * empty variable counts as unset.
 */
export function promptRecallLogPath(env: PromptRecallLogEnvironment, fallbackHome: string): string {
  const stateHome = env.XDG_STATE_HOME || join(env.HOME || fallbackHome, '.local', 'state');
  return join(env.CORTEX_LOG_DIR || join(stateHome, 'cortex'), 'prompt-recall.log');
}

/** Pure: UTC to the second, the shim's `date -u +%Y-%m-%dT%H:%M:%SZ`. */
export function logStamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Pure: the text appended for one message — each of its lines prefixed with
 * the stamp, trailing newlines dropped (as the shim's `$(...)` drops them).
 * An empty message appends nothing.
 */
export function stampedLines(message: string, at: Date): string {
  const body = message.replace(/\n+$/, '');
  if (body === '') return '';
  const stamp = logStamp(at);
  return body
    .split('\n')
    .map((line) => `${stamp} ${line}\n`)
    .join('');
}

/** Where a prompt-recall warning goes. A port so Pi's extension tests pass a fake. */
export type PromptRecallLog = (message: string) => void;

export type PromptRecallLogOptions = Readonly<{
  env?: PromptRecallLogEnvironment;
  now?: () => Date;
}>;

/**
 * Append one warning to the log, rotating first once the log is too big.
 *
 * Never throws: it runs inside a best-effort hook that must not fail a prompt.
 * An unwritable log is swallowed because this IS the last-resort channel —
 * every caller also writes the warning to stderr, so nothing relies on it alone.
 */
export function appendPromptRecallLog(message: string, options: PromptRecallLogOptions = {}): void {
  const text = stampedLines(message, (options.now ?? (() => new Date()))());
  if (text === '') return;
  try {
    const env = options.env ?? {
      CORTEX_LOG_DIR: process.env.CORTEX_LOG_DIR,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      HOME: process.env.HOME,
    };
    const path = promptRecallLogPath(env, homedir());
    mkdirSync(dirname(path), { recursive: true });
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size > PROMPT_RECALL_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, text, { mode: 0o600 });
  } catch {
    // See the doc comment: the stderr copy is the caller's, and there is no
    // further channel to report a failed write to.
  }
}
