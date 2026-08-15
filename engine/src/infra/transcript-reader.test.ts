/**
 * Tests for the streaming transcript reader.
 * Uses real temp files — the point of this module is the I/O behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectedChunks } from './transcript-reader.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cortex-reader-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a JSONL transcript; returns its path. */
function writeTranscript(lines: unknown[]): string {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

const msg = (text: string, details?: unknown) => ({
  type: 'message',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...(details ? { details } : {}),
  },
});

describe('readProjectedChunks', () => {
  it('returns projected content and drops details', async () => {
    const p = writeTranscript([msg('kept one', { blob: 'x'.repeat(100_000) }), msg('kept two')]);

    const res = await readProjectedChunks(p, { maxChunkBytes: 100_000, maxChunks: 5 });

    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].text).toContain('kept one');
    expect(res.chunks[0].text).toContain('kept two');
    expect(res.chunks[0].text).not.toContain('blob');
    expect(res.reachedEnd).toBe(true);
  });

  it('projected output is dramatically smaller than the raw file', async () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      msg(`m${i}`, { results: [{ messages: Array.from({ length: 20 }, () => ({ c: 'x'.repeat(500) })) }] })
    );
    const p = writeTranscript(lines);

    const res = await readProjectedChunks(p, { maxChunkBytes: 1_000_000, maxChunks: 5 });
    const projectedBytes = res.chunks.reduce((n, c) => n + Buffer.byteLength(c.text, 'utf8'), 0);

    expect(projectedBytes).toBeLessThan(res.rawSize / 20);
  });

  it('resumes from a prior endByte without re-reading', async () => {
    const p = writeTranscript([msg('first'), msg('second'), msg('third')]);

    const first = await readProjectedChunks(p, { maxChunkBytes: 1, maxChunks: 1 });
    expect(first.chunks[0].text).toContain('first');
    expect(first.chunks[0].text).not.toContain('second');

    const second = await readProjectedChunks(p, {
      startByte: first.chunks[0].endByte,
      maxChunkBytes: 1,
      maxChunks: 1,
    });
    expect(second.chunks[0].text).toContain('second');
    expect(second.chunks[0].text).not.toContain('first');
  });

  it('reading to the end then resuming yields nothing more', async () => {
    const p = writeTranscript([msg('a'), msg('b')]);

    const first = await readProjectedChunks(p, { maxChunkBytes: 1_000_000, maxChunks: 5 });
    expect(first.reachedEnd).toBe(true);

    const second = await readProjectedChunks(p, {
      startByte: first.finalByte,
      maxChunkBytes: 1_000_000,
      maxChunks: 5,
    });
    expect(second.chunks).toHaveLength(0);
    expect(second.reachedEnd).toBe(true);
  });

  it('advances finalByte past a long run of non-projecting lines', async () => {
    // Entries with no message: they project to nothing, but the cursor must
    // still move or every future run re-reads them.
    const noise = Array.from({ length: 200 }, (_, i) => ({
      type: 'file-history-snapshot',
      snapshot: { i, blob: 'z'.repeat(200) },
    }));
    const p = writeTranscript(noise);

    const res = await readProjectedChunks(p, { maxChunkBytes: 100_000, maxChunks: 5 });

    expect(res.chunks).toHaveLength(0);
    expect(res.reachedEnd).toBe(true);
    expect(res.finalByte).toBeGreaterThanOrEqual(res.rawSize);
  });

  it('respects maxChunks and reports that content remains', async () => {
    const p = writeTranscript(Array.from({ length: 20 }, (_, i) => msg(`m${i}`)));

    const res = await readProjectedChunks(p, { maxChunkBytes: 1, maxChunks: 2 });

    expect(res.chunks).toHaveLength(2);
    expect(res.reachedEnd).toBe(false);
    expect(res.finalByte).toBeLessThan(res.rawSize);
  });

  it('emits a trailing partial chunk rather than discarding it', async () => {
    const p = writeTranscript([msg('only')]);
    const res = await readProjectedChunks(p, { maxChunkBytes: 10_000_000, maxChunks: 5 });
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].text).toContain('only');
  });

  it('treats a startByte past EOF as nothing to do', async () => {
    const p = writeTranscript([msg('a')]);
    const res = await readProjectedChunks(p, { startByte: 999_999, maxChunkBytes: 100, maxChunks: 5 });
    expect(res.chunks).toHaveLength(0);
    expect(res.reachedEnd).toBe(true);
  });

  it('every chunk is valid JSONL', async () => {
    const p = writeTranscript([msg('a'), msg('b'), msg('c')]);
    const res = await readProjectedChunks(p, { maxChunkBytes: 50, maxChunks: 10 });

    for (const chunk of res.chunks) {
      for (const line of chunk.text.split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it('handles a file with no trailing newline', async () => {
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, JSON.stringify(msg('no newline')), 'utf8');

    const res = await readProjectedChunks(p, { maxChunkBytes: 100_000, maxChunks: 5 });
    expect(res.chunks[0].text).toContain('no newline');
    expect(res.reachedEnd).toBe(true);
  });

  it('covers every message exactly once across a resumed read', async () => {
    const p = writeTranscript(Array.from({ length: 30 }, (_, i) => msg(`unique-${i}`)));

    const seen: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 40; i++) {
      const res = await readProjectedChunks(p, {
        startByte: cursor,
        maxChunkBytes: 1,
        maxChunks: 2,
      });
      if (res.chunks.length === 0) break;
      for (const c of res.chunks) seen.push(c.text);
      cursor = res.chunks[res.chunks.length - 1].endByte;
      if (res.reachedEnd) break;
    }

    const joined = seen.join('\n');
    for (let i = 0; i < 30; i++) {
      expect(joined.split(`unique-${i}"`).length - 1).toBe(1);
    }
  });
});
