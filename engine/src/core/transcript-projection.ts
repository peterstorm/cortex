/**
 * Transcript projection — pure functions.
 *
 * WHY THIS EXISTS
 *
 * Session transcripts are dominated by data no model ever saw. Measured on the
 * live store (2026-08-15), across the 25 largest pi sessions (1.78 GB):
 * `message.details` accounted for 96.1% of all bytes and `message.content` for
 * 3.4%. The worst single file was 213 MB, of which 208.6 MB was
 * `details.results[].messages[]` — the complete internal conversation of every
 * subagent a parallel batch spawned, nested inside the parent's tool result.
 * The parent model saw 3.4 MB of that file.
 *
 * The Claude Code format has the same shape of problem under different keys:
 * `toolUseResult`, `attachment`, `file-history-snapshot`, and `snapshot`
 * entries carry bulk that never entered a model request.
 *
 * Extraction reads transcripts to distill durable memories. Feeding it bytes no
 * model saw costs memory, LLM tokens, and extraction quality, and buys nothing.
 *
 * THE RULE
 *
 * Keep exactly what reached a model: `message.role` and `message.content`.
 * Drop every sibling key. This is format-agnostic — it holds for pi
 * (`details`) and Claude Code (`toolUseResult`, `snapshot`, …) without either
 * being named — and it is lossless with respect to what extraction is
 * documented to reason about.
 */

/**
 * Projection contract version. Stored alongside each extraction checkpoint.
 *
 * A cursor is an offset into PROJECTED text, so it is only meaningful under the
 * projection that produced it. Any change to the rules below — different fields
 * kept, different clamping — must bump this constant, which forces affected
 * checkpoints back to 0. Re-extraction is safe: dedup absorbs it. Silently
 * reusing a cursor across projection versions would resume mid-content and skip
 * transcript permanently.
 */
export const PROJECTION_VERSION = 2;

/**
 * Per-string clamp inside a projected entry.
 *
 * A single tool result can be megabytes (an unbounded file read, a wide grep).
 * Such a payload is not a durable memory and would otherwise consume an entire
 * extraction chunk on its own. Clamping bounds the worst case per line while
 * leaving structure intact, so a chunk always holds many messages rather than
 * one giant one.
 */
export const MAX_PROJECTED_STRING_BYTES = 32 * 1024;

/**
 * Cap for a line that cannot be parsed as JSON. Unparseable lines are kept
 * (clamped) rather than dropped: an unrecognized transcript format should
 * degrade to "extract from raw text", not to silent data loss.
 */
export const MAX_UNPARSEABLE_LINE_BYTES = 4 * 1024;

/** Marker appended where a string was clamped, so truncation is never silent. */
const CLAMP_MARKER = '…[clamped]';

/** Depth limit when walking content — guards against pathological nesting. */
const MAX_WALK_DEPTH = 12;

/**
 * Clamp every string in a value to maxBytes, preserving structure.
 * Pure. Returns a new value; the input is not mutated.
 */
function clampStrings(value: unknown, maxBytes: number, depth = 0): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    // Slice by characters, then shrink until the UTF-8 size fits: a character
    // slice can still exceed the byte budget on multi-byte text.
    let out = value.slice(0, maxBytes);
    while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) {
      out = out.slice(0, Math.floor(out.length * 0.9));
    }
    return out + CLAMP_MARKER;
  }
  if (depth >= MAX_WALK_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map(v => clampStrings(v, maxBytes, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = clampStrings(v, maxBytes, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Project a single raw JSONL transcript line to the model-visible subset.
 *
 * @param raw - One line of a JSONL transcript
 * @returns A compact JSON line, or null when the line carries nothing a model saw
 */
export function projectTranscriptLine(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Unknown or corrupt format — keep a bounded amount rather than lose it.
    return trimmed.length <= MAX_UNPARSEABLE_LINE_BYTES
      ? trimmed
      : trimmed.slice(0, MAX_UNPARSEABLE_LINE_BYTES) + CLAMP_MARKER;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;

  // Content lives under `message` in pi and Claude Code session logs, but some
  // transcript writers emit a bare {role, content} envelope with no wrapper.
  // Resolve the wrapped form first, then fall back to the top level: treating a
  // bare envelope as "nothing a model saw" would silently discard the entire
  // transcript for those formats.
  const wrapped =
    obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)
      ? (obj.message as Record<string, unknown>)
      : null;
  const source = wrapped !== null && wrapped.content !== undefined ? wrapped : obj;

  // A compaction entry carries its condensed history in a top-level `summary`
  // string rather than in `content` (pi writes `{type:'compaction', summary,
  // firstKeptEntryId, tokensBefore, …}`). That summary IS model-visible — it
  // replaces the compacted range in every later request — and it is the
  // highest-value text per byte in a session: goals, constraints, and progress
  // already distilled. Dropping it lost ~5% of a long session's model-visible
  // text and precisely the part extraction wants most.
  if (source.content === undefined && typeof obj.summary === 'string' && obj.summary.trim() !== '') {
    return JSON.stringify({
      role: typeof obj.type === 'string' ? obj.type : 'summary',
      content: clampStrings(obj.summary, MAX_PROJECTED_STRING_BYTES),
    });
  }

  const role = typeof source.role === 'string' ? source.role : null;
  const content = source.content;

  // No content means nothing reached a model from this entry (session headers,
  // mode changes, file-history snapshots, attachments).
  if (content === undefined || content === null) return null;
  if (typeof content !== 'string' && !Array.isArray(content)) return null;
  if (Array.isArray(content) && content.length === 0) return null;
  if (typeof content === 'string' && content.trim() === '') return null;

  const projected = {
    ...(role !== null ? { role } : {}),
    content: clampStrings(content, MAX_PROJECTED_STRING_BYTES),
  };

  return JSON.stringify(projected);
}
