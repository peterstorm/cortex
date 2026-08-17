/**
 * Pure collection helpers shared across commands.
 */

/**
 * Split an array into consecutive chunks of the given size (pure).
 *
 * Shared by the AI-prune and semantic-edge classification commands: both
 * batch LLM work into fixed-size groups, and the chunking algorithm stays
 * one copy so the two batchers can never silently drift.
 */
export function chunk<T>(arr: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
