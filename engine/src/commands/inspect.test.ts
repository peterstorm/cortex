/**
 * Tests for inspect command.
 * Uses in-memory SQLite and temp directories for testing.
 */


import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase, insertMemory, insertEdge } from '../infra/db.js';
import { createMemory, createEdge, type MemoryType } from '../core/types.js';
import {
  countByType,
  countByScope,
  countPendingEmbeddings,
  calculateStalenessHours,
  formatTelemetry,
  collectTelemetry,
  parseTelemetryFile,
  type TelemetryData,
} from './inspect.js';

// ============================================================================
// PURE FUNCTION TESTS
// ============================================================================

describe('countByType', () => {
  test('empty array returns all types with 0', () => {
    const result = countByType([]);
    expect(result).toEqual({
      architecture: 0,
      decision: 0,
      pattern: 0,
      gotcha: 0,
      context: 0,
      progress: 0,
      code_description: 0,
      code: 0,
    });
  });

  test('counts single type', () => {
    const memories = [
      createMemory({
        id: 'm1',
        content: 'test',
        summary: 'test',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      }),
    ];

    const result = countByType(memories);
    expect(result.decision).toBe(1);
    expect(result.architecture).toBe(0);
  });

  test('counts multiple types', () => {
    const memories = [
      createMemory({
        id: 'm1',
        content: 'test',
        summary: 'test',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      }),
      createMemory({
        id: 'm2',
        content: 'test',
        summary: 'test',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      }),
      createMemory({
        id: 'm3',
        content: 'test',
        summary: 'test',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.7,
        priority: 6,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      }),
    ];

    const result = countByType(memories);
    expect(result.decision).toBe(2);
    expect(result.architecture).toBe(1);
    expect(result.pattern).toBe(0);
  });
});

describe('countByScope', () => {
  test('empty array returns all scopes with 0', () => {
    const result = countByScope([]);
    expect(result).toEqual({ project: 0, global: 0 });
  });

  test('counts project scope', () => {
    const memories = [
      createMemory({
        id: 'm1',
        content: 'test',
        summary: 'test',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      }),
    ];

    const result = countByScope(memories);
    expect(result.project).toBe(1);
    expect(result.global).toBe(0);
  });

  test('counts both scopes', () => {
    const memories = [
      createMemory({
        id: 'm1',
        content: 'test',
        summary: 'test',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      }),
      createMemory({
        id: 'm2',
        content: 'test',
        summary: 'test',
        memory_type: 'architecture',
        scope: 'global',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      }),
      createMemory({
        id: 'm3',
        content: 'test',
        summary: 'test',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 6,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      }),
    ];

    const result = countByScope(memories);
    expect(result.project).toBe(2);
    expect(result.global).toBe(1);
  });
});

describe('countPendingEmbeddings', () => {
  test('empty array returns 0', () => {
    const result = countPendingEmbeddings([]);
    expect(result).toBe(0);
  });

  test('counts memories with null embeddings', () => {
    const memories = [
      createMemory({
        id: 'm1',
        content: 'test',
        summary: 'test',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
        embedding: null,
        local_embedding: null,
      }),
      createMemory({
        id: 'm2',
        content: 'test',
        summary: 'test',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
        embedding: new Float64Array(3),
        local_embedding: null,
      }),
      createMemory({
        id: 'm3',
        content: 'test',
        summary: 'test',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 6,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
        embedding: null,
        local_embedding: null,
      }),
    ];

    const result = countPendingEmbeddings(memories);
    expect(result).toBe(2);
  });

  test('ignores memories with at least one embedding', () => {
    const memories = [
      createMemory({
        id: 'm1',
        content: 'test',
        summary: 'test',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
        embedding: new Float64Array(3),
        local_embedding: null,
      }),
      createMemory({
        id: 'm2',
        content: 'test',
        summary: 'test',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
        embedding: null,
        local_embedding: new Float32Array(3),
      }),
    ];

    const result = countPendingEmbeddings(memories);
    expect(result).toBe(0);
  });
});

describe('calculateStalenessHours', () => {
  test('calculates staleness for recent timestamp', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = calculateStalenessHours(oneHourAgo);

    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(0.99);
    expect(result!).toBeLessThanOrEqual(1.01);
  });

  test('calculates staleness for old timestamp', () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const result = calculateStalenessHours(twentyFiveHoursAgo);

    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(24.9);
    expect(result!).toBeLessThanOrEqual(25.1);
  });

  test('returns null for invalid timestamp', () => {
    const result = calculateStalenessHours('invalid-timestamp');
    expect(result).toBeNull();
  });
});

describe('parseTelemetryFile', () => {
  test('parses valid last_extraction', () => {
    const data = {
      last_extraction: {
        status: 'success',
        timestamp: '2026-02-09T10:00:00Z',
      },
    };

    const result = parseTelemetryFile(data);
    expect(result.last_extraction?.status).toBe('success');
    expect(result.last_extraction?.timestamp).toBe('2026-02-09T10:00:00Z');
  });

  test('parses last_extraction with error', () => {
    const data = {
      last_extraction: {
        status: 'failure',
        timestamp: '2026-02-09T10:00:00Z',
        error: 'test error',
      },
    };

    const result = parseTelemetryFile(data);
    expect(result.last_extraction?.status).toBe('failure');
    expect(result.last_extraction?.error).toBe('test error');
  });

  test('returns empty object when last_extraction missing', () => {
    const data = {};

    const result = parseTelemetryFile(data);
    expect(result.last_extraction).toBeUndefined();
  });

  test('ignores invalid status', () => {
    const data = {
      last_extraction: {
        status: 'invalid',
        timestamp: '2026-02-09T10:00:00Z',
      },
    };

    const result = parseTelemetryFile(data);
    expect(result.last_extraction).toBeUndefined();
  });

  test('ignores missing timestamp', () => {
    const data = {
      last_extraction: {
        status: 'success',
      },
    };

    const result = parseTelemetryFile(data);
    expect(result.last_extraction).toBeUndefined();
  });

  test('ignores non-object last_extraction', () => {
    const data = {
      last_extraction: 'invalid',
    };

    const result = parseTelemetryFile(data);
    expect(result.last_extraction).toBeUndefined();
  });
});

describe('formatTelemetry', () => {
  test('formats telemetry as JSON', () => {
    const data: TelemetryData = {
      last_extraction: {
        status: 'success',
        timestamp: '2026-02-09T10:00:00Z',
      },
      memory_counts: {
        total: 5,
        by_type: {
          architecture: 3,
          decision: 2,
          pattern: 0,
          gotcha: 0,
          context: 0,
          progress: 0,
          code_description: 0,
          code: 0,
        },
        by_scope: { project: 4, global: 1 },
      },
      edge_count: 3,
      embedding_queue_size: 1,
      cache_staleness: {
        exists: true,
        age_hours: 2.5,
      },
    };

    const result = formatTelemetry(data);
    const parsed = JSON.parse(result);

    expect(parsed.last_extraction.status).toBe('success');
    expect(parsed.memory_counts.total).toBe(5);
    expect(parsed.edge_count).toBe(3);
    expect(parsed.embedding_queue_size).toBe(1);
    expect(parsed.cache_staleness.exists).toBe(true);
  });

  test('handles missing last_extraction', () => {
    const data: TelemetryData = {
      memory_counts: {
        total: 0,
        by_type: {
          architecture: 0,
          decision: 0,
          pattern: 0,
          gotcha: 0,
          context: 0,
          progress: 0,
          code_description: 0,
          code: 0,
        },
        by_scope: { project: 0, global: 0 },
      },
      edge_count: 0,
      embedding_queue_size: 0,
    };

    const result = formatTelemetry(data);
    const parsed = JSON.parse(result);

    expect(parsed.last_extraction).toBeUndefined();
    expect(parsed.memory_counts.total).toBe(0);
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('collectTelemetry', () => {
  let projectDb: Database;
  let globalDb: Database;
  let tempDir: string;
  let telemetryPath: string;
  let cachePath: string;

  beforeEach(() => {
    // Create in-memory databases
    projectDb = openDatabase(':memory:');
    globalDb = openDatabase(':memory:');

    // Create temp directory
    tempDir = fs.mkdtempSync('/tmp/cortex-inspect-test-');
    telemetryPath = path.join(tempDir, 'cortex-status.json');
    cachePath = path.join(tempDir, 'surface-cache');
  });

  afterEach(() => {
    projectDb.close();
    globalDb.close();

    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test('collects empty telemetry', () => {
    const result = collectTelemetry(projectDb, globalDb, telemetryPath, cachePath);

    expect(result.memory_counts.total).toBe(0);
    expect(result.edge_count).toBe(0);
    expect(result.embedding_queue_size).toBe(0);
    expect(result.cache_staleness.exists).toBe(false);
    expect(result.last_extraction).toBeUndefined();
  });

  test('collects telemetry from project DB', () => {
    // Insert memories
    insertMemory(
      projectDb,
      createMemory({
        id: 'm1',
        content: 'test1',
        summary: 'test1',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
        embedding: null,
        local_embedding: null,
      })
    );

    insertMemory(
      projectDb,
      createMemory({
        id: 'm2',
        content: 'test2',
        summary: 'test2',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
        embedding: new Float64Array(3),
        local_embedding: null,
      })
    );

    // Insert edge
    insertEdge(projectDb, {
      source_id: 'm1',
      target_id: 'm2',
      relation_type: 'relates_to',
      strength: 0.8,
      bidirectional: false,
      status: 'active',
    });

    const result = collectTelemetry(projectDb, globalDb, telemetryPath, cachePath);

    expect(result.memory_counts.total).toBe(2);
    expect(result.memory_counts.by_type.decision).toBe(1);
    expect(result.memory_counts.by_type.architecture).toBe(1);
    expect(result.memory_counts.by_scope.project).toBe(2);
    expect(result.edge_count).toBe(1);
    expect(result.embedding_queue_size).toBe(1);
  });

  test('collects telemetry from both DBs', () => {
    // Insert project memories
    insertMemory(
      projectDb,
      createMemory({
        id: 'm1',
        content: 'project',
        summary: 'project',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      })
    );

    insertMemory(
      projectDb,
      createMemory({
        id: 'm1b',
        content: 'project2',
        summary: 'project2',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.85,
        priority: 6,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      })
    );

    // Insert global memories
    insertMemory(
      globalDb,
      createMemory({
        id: 'm2',
        content: 'global',
        summary: 'global',
        memory_type: 'pattern',
        scope: 'global',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      })
    );

    insertMemory(
      globalDb,
      createMemory({
        id: 'm2b',
        content: 'global2',
        summary: 'global2',
        memory_type: 'context',
        scope: 'global',
        confidence: 0.75,
        priority: 8,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      })
    );

    // Insert edges in both DBs (non-self-referencing)
    insertEdge(projectDb, {
      source_id: 'm1',
      target_id: 'm1b',
      relation_type: 'relates_to',
      strength: 0.7,
      bidirectional: false,
      status: 'active',
    });

    insertEdge(globalDb, {
      source_id: 'm2',
      target_id: 'm2b',
      relation_type: 'relates_to',
      strength: 0.6,
      bidirectional: false,
      status: 'active',
    });

    const result = collectTelemetry(projectDb, globalDb, telemetryPath, cachePath);

    expect(result.memory_counts.total).toBe(4);
    expect(result.memory_counts.by_scope.project).toBe(2);
    expect(result.memory_counts.by_scope.global).toBe(2);
    expect(result.edge_count).toBe(2);
  });

  test('reads telemetry file', () => {
    // Write telemetry file
    const telemetryData = {
      last_extraction: {
        status: 'success',
        timestamp: '2026-02-09T10:00:00Z',
      },
    };

    fs.writeFileSync(telemetryPath, JSON.stringify(telemetryData), 'utf8');

    const result = collectTelemetry(projectDb, globalDb, telemetryPath, cachePath);

    expect(result.last_extraction?.status).toBe('success');
    expect(result.last_extraction?.timestamp).toBe('2026-02-09T10:00:00Z');
  });

  test('handles missing telemetry file', () => {
    const result = collectTelemetry(projectDb, globalDb, telemetryPath, cachePath);

    expect(result.last_extraction).toBeUndefined();
  });

  test('detects cache staleness', () => {
    // Create cache directory with file
    fs.mkdirSync(cachePath, { recursive: true });
    const cacheFile = path.join(cachePath, 'test-cache.json');
    fs.writeFileSync(cacheFile, '{}', 'utf8');

    const result = collectTelemetry(projectDb, globalDb, telemetryPath, cachePath);

    expect(result.cache_staleness?.exists).toBe(true);
    expect(result.cache_staleness?.age_hours).toBeDefined();
    expect(result.cache_staleness?.age_hours!).toBeGreaterThanOrEqual(0);
    expect(result.cache_staleness?.age_hours!).toBeLessThan(1);
  });

  test('handles missing cache', () => {
    const result = collectTelemetry(projectDb, globalDb, telemetryPath, cachePath);

    expect(result.cache_staleness?.exists).toBe(false);
    expect(result.cache_staleness?.age_hours).toBeUndefined();
  });
});
