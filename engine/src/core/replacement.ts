/**
 * Explicit replacement: `remember --replaces=<tag>` states that the new memory
 * is the current version of whatever the database holds under that tag.
 *
 * Pure: the tag's parser and the choice of what it replaces.
 */

import type { Memory } from './types.js';

/** A tag that names a replaceable fact: non-empty, no commas, no whitespace. */
export type ReplacementTag = string & { readonly __brand: 'ReplacementTag' };

export type ReplacementTagResult =
  | Readonly<{ ok: true; tag: ReplacementTag }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Parse a `--replaces` value. Commas are refused because `--tags` splits on
 * them, so a tag containing one could never be stored as a single tag;
 * whitespace is refused because it would be a different tag after the trim
 * `--tags` applies.
 */
export function parseReplacementTag(raw: string): ReplacementTagResult {
  if (raw === '') return { ok: false, error: '--replaces needs a tag, e.g. --replaces=deploy-procedure' };
  if (/[,\s]/u.test(raw)) {
    return { ok: false, error: `--replaces tag must not contain commas or whitespace, got: '${raw}'` };
  }
  return { ok: true, tag: raw as ReplacementTag };
}

/**
 * The memories a new memory replaces: every OTHER active memory carrying the
 * tag, pinned ones included — the caller named the replacement explicitly,
 * and pinning protects a memory from decay, not from being restated. The pin
 * is not lost with it: carryForward moves it to the replacement.
 */
export function replacedBy(
  replacementId: string,
  tag: ReplacementTag,
  memories: readonly Memory[]
): readonly Memory[] {
  return memories.filter(
    (memory) => memory.id !== replacementId && memory.status === 'active' && memory.tags.includes(tag)
  );
}

/**
 * The replacement as it is written: pinned when it or any memory it replaces
 * is pinned, at the highest priority among them.
 *
 * A new version states the same fact, so it inherits the standing the fact
 * already had. Without this, replacing a pinned memory without repeating
 * `--pinned` left the current version unpinned: decay could archive it,
 * prune and vacuum it, and the fact would leave the active set entirely while
 * every older version sat superseded behind it.
 */
export function carryForward(memory: Memory, replaced: readonly Memory[]): Memory {
  return {
    ...memory,
    pinned: memory.pinned || replaced.some((old) => old.pinned),
    priority: Math.max(memory.priority, ...replaced.map((old) => old.priority)),
  };
}
