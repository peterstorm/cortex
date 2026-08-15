/**
 * Tests for transcript projection.
 * Includes property-based tests with fast-check.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  projectTranscriptLine,
  PROJECTION_VERSION,
  MAX_PROJECTED_STRING_BYTES,
  MAX_UNPARSEABLE_LINE_BYTES,
} from './transcript-projection.js';

describe('projectTranscriptLine — drops what no model saw', () => {
  it('drops pi message.details (the 96%-of-bytes case)', () => {
    const line = JSON.stringify({
      type: 'message',
      id: 'x',
      timestamp: 't',
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: 'Parallel: 8/8 succeeded' }],
        details: {
          mode: 'parallel',
          results: [{ agent: 'reviewer', messages: [{ role: 'user', content: 'x'.repeat(50_000) }] }],
        },
      },
    });

    const out = projectTranscriptLine(line)!;

    expect(out).not.toContain('details');
    expect(out).not.toContain('reviewer');
    expect(out).toContain('Parallel: 8/8 succeeded');
    expect(out.length).toBeLessThan(200);
  });

  it('drops Claude Code toolUseResult and snapshot siblings', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u',
      cwd: '/tmp',
      toolUseResult: { stdout: 'y'.repeat(50_000) },
      snapshot: { files: 'z'.repeat(50_000) },
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });

    const out = projectTranscriptLine(line)!;

    expect(out).not.toContain('toolUseResult');
    expect(out).not.toContain('snapshot');
    expect(out).toContain('hello');
  });

  it('keeps a compaction summary, which lives in `summary` not `content`', () => {
    // The condensed history a compaction produces is model-visible for the
    // whole rest of the session and is the densest text in the file.
    const line = JSON.stringify({
      type: 'compaction',
      id: '8a1da537',
      timestamp: 't',
      summary: '## Goal\nComplete F6 durable runtime\n## Progress\n- [x] T8 done',
      firstKeptEntryId: 'x',
      tokensBefore: 120_000,
      details: { blob: 'y'.repeat(10_000) },
    });

    const out = projectTranscriptLine(line)!;
    const parsed = JSON.parse(out);

    expect(parsed.content).toContain('Complete F6 durable runtime');
    expect(parsed.content).toContain('T8 done');
    expect(parsed.role).toBe('compaction');
    expect(out).not.toContain('blob');
  });

  it('ignores a blank summary', () => {
    expect(projectTranscriptLine(JSON.stringify({ type: 'compaction', summary: '   ' }))).toBeNull();
  });

  it('prefers real content over a sibling summary', () => {
    const out = projectTranscriptLine(
      JSON.stringify({ type: 'x', summary: 'the summary', message: { role: 'user', content: 'the content' } })
    )!;
    expect(JSON.parse(out).content).toBe('the content');
  });

  it('drops entries with no message at all', () => {
    expect(projectTranscriptLine(JSON.stringify({ type: 'session', id: 'a' }))).toBeNull();
    expect(projectTranscriptLine(JSON.stringify({ type: 'mode', mode: 'x' }))).toBeNull();
    expect(
      projectTranscriptLine(JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }))
    ).toBeNull();
  });

  it('drops entries whose message carries no content', () => {
    expect(projectTranscriptLine(JSON.stringify({ message: { role: 'user' } }))).toBeNull();
    expect(projectTranscriptLine(JSON.stringify({ message: { role: 'user', content: [] } }))).toBeNull();
    expect(projectTranscriptLine(JSON.stringify({ message: { role: 'user', content: '  ' } }))).toBeNull();
  });

  it('drops blank and whitespace-only lines', () => {
    expect(projectTranscriptLine('')).toBeNull();
    expect(projectTranscriptLine('   ')).toBeNull();
  });

  it('preserves role and content verbatim when within budget', () => {
    const content = [{ type: 'text', text: 'a decision was made' }];
    const out = projectTranscriptLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } }))!;
    expect(JSON.parse(out)).toEqual({ role: 'assistant', content });
  });

  it('keeps string content as well as array content', () => {
    const out = projectTranscriptLine(JSON.stringify({ message: { role: 'user', content: 'plain' } }))!;
    expect(JSON.parse(out)).toEqual({ role: 'user', content: 'plain' });
  });

  it('keeps a bare {role, content} envelope with no message wrapper', () => {
    // Not every transcript writer wraps in `message`. Requiring the wrapper
    // silently discarded the whole transcript for these formats.
    const out = projectTranscriptLine('{"role":"user","content":"remember Cortex uses SQLite"}')!;
    expect(JSON.parse(out)).toEqual({ role: 'user', content: 'remember Cortex uses SQLite' });
  });

  it('prefers the wrapped message when both forms are present', () => {
    const out = projectTranscriptLine(
      JSON.stringify({ content: 'outer', message: { role: 'assistant', content: 'inner' } })
    )!;
    expect(JSON.parse(out)).toEqual({ role: 'assistant', content: 'inner' });
  });

  it('falls back to the top level when the wrapper carries no content', () => {
    const out = projectTranscriptLine(
      JSON.stringify({ role: 'system', content: 'sys text', message: { id: 'x' } })
    )!;
    expect(JSON.parse(out)).toEqual({ role: 'system', content: 'sys text' });
  });
});

describe('projectTranscriptLine — clamping', () => {
  it('clamps an oversized string but keeps the structure parseable', () => {
    const line = JSON.stringify({
      message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(500_000) }] },
    });

    const out = projectTranscriptLine(line)!;

    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.content[0].text).toContain('[clamped]');
    expect(Buffer.byteLength(parsed.content[0].text, 'utf8')).toBeLessThanOrEqual(
      MAX_PROJECTED_STRING_BYTES + 32
    );
  });

  it('clamps multi-byte text without exceeding the byte budget', () => {
    const line = JSON.stringify({
      message: { role: 'user', content: [{ type: 'text', text: '☃'.repeat(200_000) }] },
    });
    const parsed = JSON.parse(projectTranscriptLine(line)!);
    expect(Buffer.byteLength(parsed.content[0].text, 'utf8')).toBeLessThanOrEqual(
      MAX_PROJECTED_STRING_BYTES + 32
    );
  });

  it('keeps an unparseable line, bounded, rather than losing it', () => {
    expect(projectTranscriptLine('not json at all')).toBe('not json at all');

    const huge = 'q'.repeat(MAX_UNPARSEABLE_LINE_BYTES * 3);
    const out = projectTranscriptLine(huge)!;
    expect(out.length).toBeLessThan(MAX_UNPARSEABLE_LINE_BYTES + 32);
    expect(out).toContain('[clamped]');
  });

  it('drops JSON that is not an object', () => {
    expect(projectTranscriptLine('[1,2,3]')).toBeNull();
    expect(projectTranscriptLine('null')).toBeNull();
  });
});

describe('projectTranscriptLine — properties', () => {
  it('never throws, for any input', () => {
    fc.assert(
      fc.property(fc.string(), s => {
        expect(() => projectTranscriptLine(s)).not.toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it('output is always null or a single line (chunks stay valid JSONL)', () => {
    fc.assert(
      fc.property(fc.string(), s => {
        const out = projectTranscriptLine(s);
        if (out !== null) expect(out).not.toContain('\n');
      }),
      { numRuns: 500 }
    );
  });

  it('never grows a parseable transcript entry', () => {
    fc.assert(
      fc.property(
        fc.record({
          role: fc.constantFrom('user', 'assistant', 'toolResult'),
          text: fc.string({ maxLength: 200 }),
          detailsSize: fc.integer({ min: 0, max: 500 }),
        }),
        ({ role, text, detailsSize }) => {
          const line = JSON.stringify({
            type: 'message',
            message: {
              role,
              content: [{ type: 'text', text }],
              details: { blob: 'd'.repeat(detailsSize) },
            },
          });
          const out = projectTranscriptLine(line);
          if (out !== null) expect(out.length).toBeLessThanOrEqual(line.length);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('PROJECTION_VERSION is a positive integer', () => {
    expect(Number.isInteger(PROJECTION_VERSION)).toBe(true);
    expect(PROJECTION_VERSION).toBeGreaterThan(0);
  });
});
