export type CortexShutdownReason = 'quit' | 'reload' | 'new' | 'resume' | 'fork';

/**
 * Runtime narrowing for pi's session_shutdown reason. pi types this as a
 * closed union today, but a future pi version can extend it — a plain cast
 * would launder a reason the policy has never reviewed into it (and the
 * policy runs the pipeline for every reason except 'reload'). The guard
 * keeps the known set in one place (this file) so unknown reasons fail
 * closed at the call site instead of slipping through a cast.
 */
export function isCortexShutdownReason(reason: unknown): reason is CortexShutdownReason {
  return (
    reason === 'quit' ||
    reason === 'reload' ||
    reason === 'new' ||
    reason === 'resume' ||
    reason === 'fork'
  );
}

/**
 * Nested extraction LLMs inherit CORTEX_EXTRACTING=1. Their shutdown must be a
 * terminal no-op or every headless Pi invocation recursively starts another
 * Cortex maintenance pipeline.
 */
export function shouldRunShutdownPipeline(
  reason: CortexShutdownReason,
  extractionMarker: string | undefined,
): boolean {
  return reason !== 'reload' && extractionMarker !== '1';
}
