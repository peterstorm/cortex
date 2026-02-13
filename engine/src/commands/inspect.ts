/**
 * Inspect command - display telemetry data.
 * Imperative shell: reads telemetry file and queries DBs, delegates to pure formatting.
 * Satisfies FR-118, FR-121, FR-122.
 */

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { getActiveMemories, getAllEdges } from '../infra/db.js';
import type { Memory, MemoryType, MemoryScope } from '../core/types.js';

// ============================================================================
// TELEMETRY DATA TYPES
// ============================================================================

export interface TelemetryData {
  readonly last_extraction?: {
    readonly status: 'success' | 'failure';
    readonly timestamp: string;
    readonly error?: string;
  };
  readonly memory_counts: {
    readonly total: number;
    readonly by_type: Record<MemoryType, number>;
    readonly by_scope: Record<MemoryScope, number>;
  };
  readonly edge_count: number;
  readonly embedding_queue_size: number;
  readonly cache_staleness?: {
    readonly exists: boolean;
    readonly age_hours?: number;
  };
}

// ============================================================================
// FUNCTIONAL CORE: PURE DATA TRANSFORMATION
// ============================================================================

/**
 * Count memories by type (pure).
 * Pre-populates all MemoryType keys with 0 so return type is honest.
 */
export function countByType(memories: readonly Memory[]): Record<MemoryType, number> {
  // Pre-populate all MemoryType keys with 0
  const counts: Record<MemoryType, number> = {
    architecture: 0,
    decision: 0,
    pattern: 0,
    gotcha: 0,
    context: 0,
    progress: 0,
    code_description: 0,
    code: 0,
  };

  for (const memory of memories) {
    counts[memory.memory_type] = counts[memory.memory_type] + 1;
  }

  return counts;
}

/**
 * Count memories by scope (pure).
 * Pre-populates all MemoryScope keys with 0 so return type is honest.
 */
export function countByScope(memories: readonly Memory[]): Record<MemoryScope, number> {
  // Pre-populate all MemoryScope keys with 0
  const counts: Record<MemoryScope, number> = {
    project: 0,
    global: 0,
  };

  for (const memory of memories) {
    counts[memory.scope] = counts[memory.scope] + 1;
  }

  return counts;
}

/**
 * Count memories with null embeddings (pending embedding queue).
 * Pure function.
 */
export function countPendingEmbeddings(memories: readonly Memory[]): number {
  return memories.filter(
    (m) => m.embedding === null && m.local_embedding === null
  ).length;
}

/**
 * Calculate cache staleness in hours from timestamp.
 * Returns null if timestamp is invalid.
 * Pure function.
 */
export function calculateStalenessHours(timestamp: string): number | null {
  try {
    const cacheTime = new Date(timestamp).getTime();
    if (Number.isNaN(cacheTime)) {
      return null;
    }
    const now = Date.now();
    const diffMs = now - cacheTime;
    const hours = diffMs / (1000 * 60 * 60);
    return Number.isNaN(hours) ? null : hours;
  } catch {
    return null;
  }
}

/**
 * Parse telemetry file data safely (pure).
 * Validates each field and returns only validated fields.
 * Parse, don't validate: returns typed data, not booleans.
 */
export function parseTelemetryFile(
  data: Record<string, unknown>
): Partial<Pick<TelemetryData, 'last_extraction'>> {
  const result: Partial<Pick<TelemetryData, 'last_extraction'>> = {};

  // Validate last_extraction if present
  if (data.last_extraction && typeof data.last_extraction === 'object') {
    const extraction = data.last_extraction as Record<string, unknown>;

    // Validate status field
    if (
      extraction.status === 'success' ||
      extraction.status === 'failure'
    ) {
      // Validate timestamp field
      if (typeof extraction.timestamp === 'string') {
        result.last_extraction = {
          status: extraction.status,
          timestamp: extraction.timestamp,
          error: typeof extraction.error === 'string' ? extraction.error : undefined,
        };
      }
    }
  }

  return result;
}

/**
 * Format telemetry data as JSON string (pure).
 */
export function formatTelemetry(data: TelemetryData): string {
  return JSON.stringify(data, null, 2);
}

// ============================================================================
// IMPERATIVE SHELL: I/O ORCHESTRATION
// ============================================================================

/**
 * Read telemetry file if exists (I/O).
 * Returns parsed data or null if file doesn't exist or is invalid.
 */
function readTelemetryFile(path: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(path, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get cache metadata from filesystem (I/O).
 * Checks if surface cache directory exists and gets most recent mtime.
 */
function getCacheStaleness(cachePath: string): { exists: boolean; age_hours?: number } {
  try {
    const stats = fs.statSync(cachePath);
    if (!stats.isDirectory()) {
      return { exists: false };
    }

    // Find most recent file in cache directory
    const files = fs.readdirSync(cachePath);
    if (files.length === 0) {
      return { exists: true, age_hours: undefined };
    }

    let mostRecentMtime = 0;
    for (const file of files) {
      const filePath = `${cachePath}/${file}`;
      const fileStats = fs.statSync(filePath);
      if (fileStats.mtimeMs > mostRecentMtime) {
        mostRecentMtime = fileStats.mtimeMs;
      }
    }

    const ageMs = Date.now() - mostRecentMtime;
    const ageHours = ageMs / (1000 * 60 * 60);

    return { exists: true, age_hours: ageHours };
  } catch {
    return { exists: false };
  }
}

/**
 * Collect telemetry from both DBs and filesystem (I/O orchestrator).
 * Returns complete telemetry data.
 */
export function collectTelemetry(
  projectDb: Database,
  globalDb: Database,
  telemetryPath: string,
  cachePath: string
): TelemetryData {
  // Read telemetry file (I/O)
  const telemetryFile = readTelemetryFile(telemetryPath);

  // Query both DBs for active memories (I/O)
  const projectMemories = getActiveMemories(projectDb);
  const globalMemories = getActiveMemories(globalDb);
  const allMemories = [...projectMemories, ...globalMemories];

  // Query both DBs for edges (I/O)
  const projectEdges = getAllEdges(projectDb);
  const globalEdges = getAllEdges(globalDb);
  const totalEdges = projectEdges.length + globalEdges.length;

  // Pure transformations
  const byType = countByType(allMemories);
  const byScope = countByScope(allMemories);
  const pendingEmbeddings = countPendingEmbeddings(allMemories);

  // Get cache staleness (I/O)
  const cacheStaleness = getCacheStaleness(cachePath);

  // Parse telemetry file safely (pure)
  const parsedTelemetry = telemetryFile ? parseTelemetryFile(telemetryFile) : {};

  // Assemble telemetry data
  return {
    last_extraction: parsedTelemetry.last_extraction,
    memory_counts: {
      total: allMemories.length,
      by_type: byType,
      by_scope: byScope,
    },
    edge_count: totalEdges,
    embedding_queue_size: pendingEmbeddings,
    cache_staleness: cacheStaleness,
  };
}

/**
 * Main inspect command entry point (I/O orchestrator).
 * Collects telemetry and outputs formatted JSON.
 */
export function runInspect(
  projectDb: Database,
  globalDb: Database,
  telemetryPath: string,
  cachePath: string
): void {
  const telemetry = collectTelemetry(projectDb, globalDb, telemetryPath, cachePath);
  const output = formatTelemetry(telemetry);
  console.log(output);
}
