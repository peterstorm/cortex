/**
 * The real `maintenance` command: it must not classify edges with an LLM.
 *
 * Typed-edge classification used to run here after every session. On 139,123
 * recorded pairs it left 99.6% as plain `relates_to`, and only `traverse`
 * reads the type, so it was taken out of maintenance; `semantic-edges` is an
 * explicit command now. The LLM endpoint below is a closed port, so a
 * regression fails this test instead of spending real quota.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectDbPath } from './config.js';
import { createMemory } from './core/types.js';
import { getAllEdges, insertEdge, insertMemory, openDatabase } from './infra/db.js';
import { runCli } from './test-support.js';

const NO_LLM = {
  CORTEX_LLM_API_URL: 'http://127.0.0.1:9/v1',
  CORTEX_LLM_API_KEY: 'unused',
  CORTEX_LLM_MODEL: 'unused',
  // One failed direct call suppresses the CLI fallback, so nothing real is asked.
  CORTEX_LLM_MAX_DIRECT_FAILURES: '1',
};

const memory = (id: string, summary: string) =>
  createMemory({
    id,
    content: summary,
    summary,
    memory_type: 'decision',
    scope: 'project',
    confidence: 0.9,
    priority: 7,
    source_type: 'extraction',
    source_session: 's',
    source_context: '{}',
  });

describe('maintenance', () => {
  it('leaves similarity edges unclassified and asks no LLM about them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-maintenance-'));
    mkdirSync(join(dir, '.memory'), { recursive: true });
    const seeded = openDatabase(getProjectDbPath(dir));
    try {
      insertMemory(seeded, memory('m-a', 'Surface ranks memories by edge in-degree'));
      insertMemory(seeded, memory('m-b', 'Prompt recall reads no edges'));
      insertEdge(seeded, {
        source_id: 'm-a',
        target_id: 'm-b',
        relation_type: 'relates_to',
        strength: 0.6,
        bidirectional: true,
        status: 'active',
      });
    } finally {
      seeded.close();
    }

    const result = runCli(['maintenance', dir], { env: NO_LLM });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Semantic edges');
    expect(result.stderr).not.toContain('semantic-edges');
    const after = openDatabase(getProjectDbPath(dir));
    try {
      expect(getAllEdges(after).map((e) => [e.relation_type, e.classified_at, e.last_failed_at])).toEqual([
        ['relates_to', null, null],
      ]);
    } finally {
      after.close();
    }
  });
});
