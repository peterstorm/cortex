/**
 * Streaming transcript reader — I/O boundary.
 *
 * Replaces `readFileSync(path, 'utf-8')` over whole session transcripts.
 * On the measured store a single session file reached 213 MB, which
 * `readFileSync` materializes as one UTF-16 JS string (~426 MB resident) purely
 * so a 100 KB window can be sliced off the front.
 *
 * This reader instead:
 * - seeks to a stored raw byte offset, so already-extracted content is never
 *   re-read (extraction cost becomes O(new bytes), not O(session));
 * - projects each line to the model-visible subset before it is retained;
 * - stops as soon as enough chunks for one run have been assembled.
 *
 * Peak memory becomes O(one line + one run's chunks) instead of O(file).
 */

import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { projectTranscriptLine } from '../core/transcript-projection.js';

/** One extraction-sized chunk of projected transcript. */
export interface ProjectedChunk {
  /** Projected JSONL text to feed the extraction prompt. */
  readonly text: string;
  /**
   * Raw byte offset immediately after the last line included in this chunk.
   * This is what gets persisted as the cursor: it is a position in the RAW
   * file, so it survives changes to chunk sizing, and it always lands on a
   * line boundary.
   */
  readonly endByte: number;
}

export interface ReadProjectedOptions {
  /** Raw byte offset to resume from. Must be a line boundary (0 or a prior endByte). */
  readonly startByte?: number;
  /** Target size of each chunk in bytes of projected text. */
  readonly maxChunkBytes: number;
  /** Maximum chunks to assemble in one call. */
  readonly maxChunks: number;
}

export interface ReadProjectedResult {
  readonly chunks: readonly ProjectedChunk[];
  /** True when the reader consumed the file to EOF (no more content pending). */
  readonly reachedEnd: boolean;
  /** Raw file size in bytes at read time — used for shrink detection. */
  readonly rawSize: number;
  /**
   * Raw byte offset after the last line READ, including lines that projected to
   * nothing. Without this, a long run of non-projecting entries (a batch of
   * subagent tool results, a block of file-history snapshots) would leave the
   * cursor parked before them and be re-read on every subsequent run.
   */
  readonly finalByte: number;
}

/**
 * Read and project a bounded window of a transcript.
 *
 * A single projected line larger than `maxChunkBytes` becomes a chunk of its
 * own rather than being split: chunks must stay valid JSONL, and the
 * per-string clamp in the projection already bounds how large one line can get.
 *
 * @param path - Transcript file path
 * @param options - Resume offset and chunk sizing
 */
export async function readProjectedChunks(
  path: string,
  options: ReadProjectedOptions
): Promise<ReadProjectedResult> {
  const { startByte = 0, maxChunkBytes, maxChunks } = options;

  const rawSize = statSync(path).size;

  // Nothing new, or a stale offset past EOF — the caller handles the reset.
  if (startByte >= rawSize) {
    return { chunks: [], reachedEnd: true, rawSize, finalByte: startByte };
  }

  const stream = createReadStream(path, { start: startByte });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  const chunks: ProjectedChunk[] = [];
  let pending: string[] = [];
  let pendingBytes = 0;
  // Byte offset of the end of the last line READ (not necessarily retained).
  let consumedBytes = startByte;
  let reachedEnd = true;

  try {
    for await (const line of lines) {
      // +1 for the newline delimiter consumed by the reader. The final line of
      // a file without a trailing newline overshoots by one byte; that is
      // harmless because the offset is only ever used as a resume point and
      // the next read starts at or past EOF.
      consumedBytes += Buffer.byteLength(line, 'utf8') + 1;

      const projected = projectTranscriptLine(line);
      if (projected === null) continue;

      pending.push(projected);
      pendingBytes += Buffer.byteLength(projected, 'utf8') + 1;

      if (pendingBytes >= maxChunkBytes) {
        chunks.push({ text: pending.join('\n'), endByte: consumedBytes });
        pending = [];
        pendingBytes = 0;

        if (chunks.length >= maxChunks) {
          // More content may remain; the caller resumes from this endByte.
          reachedEnd = consumedBytes >= rawSize;
          return { chunks, reachedEnd, rawSize, finalByte: consumedBytes };
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  // Trailing partial chunk — real progress, so it is emitted rather than held.
  if (pending.length > 0) {
    chunks.push({ text: pending.join('\n'), endByte: consumedBytes });
  }

  return { chunks, reachedEnd, rawSize, finalByte: consumedBytes };
}
