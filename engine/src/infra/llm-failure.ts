/**
 * The LLM failures that say something about every LATER call, not just this one.
 *
 * Background work (extraction chunks, prune batches, edge-classification
 * batches) loops over many LLM calls. One failed call usually says nothing
 * about the next, so the loops keep going. Two failures are different: they
 * mean every further call in this process will fail the same way, and asking
 * again only burns the provider's quota or the shared server's capacity.
 *
 * - LlmEndpointSaturatedError: the direct endpoint failed so often in a row
 *   that the subprocess fallback is suppressed.
 * - LlmProviderRefusedError: the subprocess fallback's provider refused the
 *   request outright (an HTTP 4xx, an unknown provider, failed credentials, a
 *   model the account may not use). Measured in pi-detached.log before this
 *   existed: 582 identical 400s, 293 "model is not supported", 148 "429 quota
 *   exceeded" and 118 "Unknown provider" — every one a whole prune or edge run
 *   repeating a refusal it had already been given.
 *
 * Kept apart from claude-llm.ts so modules whose tests replace that module
 * wholesale still get the real classes and the real predicate.
 */

import { match } from 'ts-pattern';

/**
 * The direct endpoint has failed so many times in a row that the subprocess
 * fallback is suppressed (see getDirectFailureFallbackThreshold in claude-llm.ts).
 */
export class LlmEndpointSaturatedError extends Error {
  override readonly name = 'LlmEndpointSaturatedError';

  constructor(readonly consecutiveFailures: number) {
    super(
      `direct LLM endpoint saturated: ${consecutiveFailures} consecutive failure(s); ` +
        `subprocess fallback suppressed to avoid escalating server load`
    );
  }
}

/** Why a provider refused a headless CLI call, as read from the CLI's stderr. */
export type ProviderRefusal =
  | Readonly<{ kind: 'http-status'; status: number }>
  | Readonly<{ kind: 'unknown-provider' }>
  | Readonly<{ kind: 'auth-failed' }>
  | Readonly<{ kind: 'model-unsupported' }>;

/** The headless CLI's provider refused the request; the same request will be refused again. */
export class LlmProviderRefusedError extends Error {
  override readonly name = 'LlmProviderRefusedError';

  constructor(readonly refusal: ProviderRefusal, readonly detail: string) {
    super(`LLM provider refused the request (${describeRefusal(refusal)}): ${detail}`);
  }
}

/**
 * A 4xx status at the start of a stderr line (`400 {"type":"error"...`,
 * `429 quota exceeded`, `401 "Unauthorized"`), which is how pi reports a
 * provider's HTTP refusal. 408 is a timeout, not a refusal.
 */
const HTTP_REFUSAL = /^\s*(4\d\d)\b/m;

/**
 * Pure: the refusal a headless CLI's stderr reports, or null when the failure
 * may be transient (a timeout, a connection error, a crashed extension).
 */
export function providerRefusalIn(stderr: string): ProviderRefusal | null {
  const status = HTTP_REFUSAL.exec(stderr)?.[1];
  if (status !== undefined && status !== '408') return { kind: 'http-status', status: Number(status) };
  if (/Unknown provider "/.test(stderr)) return { kind: 'unknown-provider' };
  if (/API key auth failed/.test(stderr)) return { kind: 'auth-failed' };
  if (/model is not supported/i.test(stderr)) return { kind: 'model-unsupported' };
  return null;
}

/** Pure: a refusal in a few words, for the error message. */
export function describeRefusal(refusal: ProviderRefusal): string {
  return match(refusal)
    .with({ kind: 'http-status' }, ({ status }) => `HTTP ${status}`)
    .with({ kind: 'unknown-provider' }, () => 'unknown provider')
    .with({ kind: 'auth-failed' }, () => 'API key auth failed')
    .with({ kind: 'model-unsupported' }, () => 'model not supported for this account')
    .exhaustive();
}

/**
 * Pure: whether this failure means every further LLM call in this process
 * will fail the same way, so a loop over batches should stop asking and leave
 * the rest for the next run.
 */
export function stopsFurtherLlmCalls(err: unknown): boolean {
  return err instanceof LlmEndpointSaturatedError || err instanceof LlmProviderRefusedError;
}
