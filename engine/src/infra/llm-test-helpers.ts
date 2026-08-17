/**
 * Test-only helpers for the LLM boundary.
 *
 * Kept out of the test files themselves because more than one suite needs
 * them: five tests across the routing, concurrency and semantic-edges suites
 * were each re-deriving the same `globalThis` cast and save/restore dance,
 * which is boilerplate a reader has to re-verify every time rather than a
 * named precondition they can read once.
 */

/** The subset of the Bun global these helpers touch. */
type BunWhichGlobal = { which: (bin: string) => string | null };

function bunGlobal(): BunWhichGlobal {
  const g = (globalThis as { Bun?: BunWhichGlobal }).Bun;
  if (g === undefined) throw new Error('llm-test-helpers: no Bun global — these helpers require the bun runtime');
  return g;
}

/**
 * Run `body` with the LLM CLI absent from PATH, restoring the real lookup
 * afterwards even if `body` throws.
 *
 * Makes `isClaudeLlmAvailable()` false and the subprocess fallback fail fast
 * with a typed "CLI not found" error instead of spawning a real agent loop.
 */
export async function withBunWhichUnavailable<T>(body: () => Promise<T>): Promise<T> {
  const g = bunGlobal();
  const originalWhich = g.which;
  g.which = () => null;
  try {
    return await body();
  } finally {
    g.which = originalWhich;
  }
}
