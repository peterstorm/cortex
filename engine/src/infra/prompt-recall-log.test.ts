import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PROMPT_RECALL_LOG_MAX_BYTES,
  appendPromptRecallLog,
  logStamp,
  promptRecallLogPath,
  stampedLines,
} from './prompt-recall-log.js';

const AT = new Date('2026-11-20T21:42:07.123Z');
const STAMP = '2026-11-20T21:42:07Z';

describe('promptRecallLogPath — the shim resolution, in TypeScript', () => {
  test('CORTEX_LOG_DIR wins, then XDG_STATE_HOME, then HOME, then the fallback home', () => {
    expect(promptRecallLogPath({ CORTEX_LOG_DIR: '/logs', XDG_STATE_HOME: '/state', HOME: '/h' }, '/fb')).toBe(
      '/logs/prompt-recall.log',
    );
    expect(promptRecallLogPath({ XDG_STATE_HOME: '/state', HOME: '/h' }, '/fb')).toBe('/state/cortex/prompt-recall.log');
    expect(promptRecallLogPath({ HOME: '/h' }, '/fb')).toBe('/h/.local/state/cortex/prompt-recall.log');
    expect(promptRecallLogPath({}, '/fb')).toBe('/fb/.local/state/cortex/prompt-recall.log');
  });

  test('an empty variable counts as unset, as with the shim`s :- expansion', () => {
    expect(promptRecallLogPath({ CORTEX_LOG_DIR: '', XDG_STATE_HOME: '', HOME: '/h' }, '/fb')).toBe(
      '/h/.local/state/cortex/prompt-recall.log',
    );
  });
});

describe('stampedLines', () => {
  test('stamps to the second in UTC, like `date -u +%Y-%m-%dT%H:%M:%SZ`', () => {
    expect(logStamp(AT)).toBe(STAMP);
    expect(stampedLines('one\ntwo\n', AT)).toBe(`${STAMP} one\n${STAMP} two\n`);
  });

  test('an empty message appends nothing', () => {
    expect(stampedLines('', AT)).toBe('');
    expect(stampedLines('\n\n', AT)).toBe('');
  });

  test('property: one stamped line per message line, and removing the stamps gives the message back', () => {
    fc.assert(
      fc.property(fc.string().filter((s) => s.replace(/\n+$/, '') !== ''), (message) => {
        const out = stampedLines(message, AT);
        const lines = out.slice(0, -1).split('\n');
        expect(out.endsWith('\n')).toBe(true);
        expect(lines.every((line) => line.startsWith(`${STAMP} `))).toBe(true);
        expect(lines.map((line) => line.slice(STAMP.length + 1)).join('\n')).toBe(message.replace(/\n+$/, ''));
      }),
    );
  });
});

describe('appendPromptRecallLog', () => {
  let dir: string;
  const env = () => ({ CORTEX_LOG_DIR: path.join(dir, 'nested', 'cortex') });
  const logFile = () => path.join(dir, 'nested', 'cortex', 'prompt-recall.log');

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cortex-recall-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('creates the directory and appends owner-only, stamped lines', () => {
    appendPromptRecallLog('[cortex] WARN: first', { env: env(), now: () => AT });
    appendPromptRecallLog('[cortex] WARN: second', { env: env(), now: () => AT });

    expect(readFileSync(logFile(), 'utf8')).toBe(`${STAMP} [cortex] WARN: first\n${STAMP} [cortex] WARN: second\n`);
    expect(statSync(logFile()).mode & 0o777).toBe(0o600);
  });

  test('rotates past the cap, keeping one previous generation', () => {
    appendPromptRecallLog('seed', { env: env(), now: () => AT });
    writeFileSync(logFile(), 'x'.repeat(PROMPT_RECALL_LOG_MAX_BYTES + 1));

    appendPromptRecallLog('fresh', { env: env(), now: () => AT });

    expect(statSync(`${logFile()}.1`).size).toBe(PROMPT_RECALL_LOG_MAX_BYTES + 1);
    expect(readFileSync(logFile(), 'utf8')).toBe(`${STAMP} fresh\n`);
  });

  test('never throws when the log cannot be written', () => {
    const blocker = path.join(dir, 'a-file');
    writeFileSync(blocker, '');
    expect(() => appendPromptRecallLog('lost', { env: { CORTEX_LOG_DIR: path.join(blocker, 'sub') } })).not.toThrow();
  });
});
