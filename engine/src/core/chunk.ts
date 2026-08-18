/**
 * Pure collection helpers shared across commands.
 */

/**
 * Split an array into consecutive chunks of the given size (pure).
 *
 * Shared by the AI-prune and semantic-edge classification commands: both
 * batch LLM work into fixed-size groups, and the chunking algorithm stays
 * one copy so the two batchers can never silently drift.
 *
 * @param size - Positive integer. Enforced rather than documented: the loop
 *   advances by `size`, so a zero or negative value never terminates and grows
 *   `result` until the process is OOM-killed — a hang with nothing pointing at
 *   its cause. Today's callers pass fixed positive constants, but this is an
 *   exported general-purpose helper and the next caller may derive its size
 *   from config or an argument.
 * @throws If `size` is not a positive integer.
 */
export function chunk<T>(arr: readonly T[], size: number): readonly T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk: size must be a positive integer, got ${size}`);
  }
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
