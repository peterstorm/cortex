export type CortexShutdownReason = 'quit' | 'reload' | 'new' | 'resume' | 'fork';

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
