import { afterEach, describe, expect, it } from 'vitest';
import registerCortex from './extension.js';

const originalMarker = process.env.CORTEX_EXTRACTING;

afterEach(() => {
  if (originalMarker === undefined) delete process.env.CORTEX_EXTRACTING;
  else process.env.CORTEX_EXTRACTING = originalMarker;
});

describe('Cortex Pi extension shutdown', () => {
  it('returns before touching session context in an extraction child', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerCortex({
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(name, handler);
      },
      registerCommand: () => undefined,
    } as never);

    process.env.CORTEX_EXTRACTING = '1';
    const context = new Proxy({}, {
      get: () => {
        throw new Error('shutdown pipeline accessed context');
      },
    });

    await expect(
      handlers.get('session_shutdown')?.({ reason: 'quit' }, context),
    ).resolves.toBeUndefined();
  });
});
