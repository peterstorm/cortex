/**
 * Generate command: Create push surface from ranked memories
 * FR-013, FR-014, FR-019, FR-022, FR-027
 *
 * Imperative shell - orchestrates I/O and pure core functions
 */

import type { Database } from 'bun:sqlite';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Memory } from '../core/types.js';
import type { RankedMemory } from '../core/surface.js';
import { SURFACE_STALE_HOURS, SURFACE_OVERHEAD_TOKENS } from '../config.js';
import { getActiveMemories, getAllEdges } from '../infra/db.js';
import { computeAllCentrality } from '../core/graph.js';
import { selectForSurface } from '../core/ranking.js';
import { generateSurface, wrapInMarkers } from '../core/surface.js';
import { writeSurface, writeTelemetry } from '../infra/filesystem.js';
import { getCurrentBranch } from '../infra/git-context.js';

export interface GenerateOptions {
  readonly projectDb: Database;
  readonly globalDb: Database;
  readonly cwd: string;
  readonly surfacePath?: string;
  readonly cachePath?: string;
  readonly lockDir?: string;
}

export interface GenerateResult {
  readonly memoryCount: number;
  readonly selectedCount: number;
  readonly branch: string;
  readonly cached: boolean;
  readonly durationMs: number;
}

/**
 * Generate push surface and write to file.
 *
 * Data flow:
 * 1. getCurrentBranch (I/O)
 * 2. getActiveMemories from both DBs (I/O)
 * 3. getAllEdges for centrality (I/O)
 * 4. computeAllCentrality (pure)
 * 5. selectForSurface → RankedMemory[] (pure, single ranking pass)
 * 6. generateSurface (pure)
 * 7. wrapInMarkers (pure)
 * 8. writeSurface with PID lock (I/O)
 * 9. write cache file (I/O)
 * 10. writeTelemetry (I/O)
 */
export function runGenerate(options: GenerateOptions): GenerateResult {
  const startTime = Date.now();

  // Default paths
  const surfacePath = options.surfacePath ?? path.join(options.cwd, '.claude', 'cortex-memory.local.md');
  const cachePath = options.cachePath ?? path.join(options.cwd, '.memory', 'surface-cache');
  const lockDir = options.lockDir ?? path.join(options.cwd, '.memory', 'locks');

  // I/O: Get current branch
  const branch = getCurrentBranch(options.cwd);

  // I/O: Fetch active memories from both DBs
  const projectMemories = getActiveMemories(options.projectDb);
  const globalMemories = getActiveMemories(options.globalDb);
  const allMemories = [...projectMemories, ...globalMemories];

  // I/O: Fetch all edges for centrality computation
  const projectEdges = getAllEdges(options.projectDb);
  const globalEdges = getAllEdges(options.globalDb);
  const allEdges = [...projectEdges, ...globalEdges];

  // Pure: Compute centrality for all memories
  const centralityMap = computeAllCentrality(allEdges);

  // Attach centrality to memories
  const memoriesWithCentrality = allMemories.map(mem => ({
    ...mem,
    centrality: centralityMap.get(mem.id) ?? 0,
  }));

  // Pure: Select and rank memories for surface with branch boost
  // Reserve SURFACE_OVERHEAD_TOKENS for markdown formatting (headers, markers, tags)
  const rankedMemories: RankedMemory[] = selectForSurface(memoriesWithCentrality, {
    currentBranch: branch,
    targetTokens: 1500 - SURFACE_OVERHEAD_TOKENS,
    maxTokens: 2000 - SURFACE_OVERHEAD_TOKENS,
  });

  // Pure: Generate surface markdown
  const surfaceContent = generateSurface(rankedMemories, branch, null);

  // Pure: Wrap in markers
  const markedContent = wrapInMarkers(surfaceContent);

  // I/O: Write surface with PID lock
  writeSurface(surfacePath, markedContent, lockDir);

  // I/O: Write cache
  writeCache(cachePath, branch, options.cwd, surfaceContent);

  // I/O: Write telemetry
  const durationMs = Date.now() - startTime;
  const telemetryPath = path.join(options.cwd, '.memory', 'cortex-status.json');
  writeTelemetry(telemetryPath, {
    last_generation: new Date().toISOString(),
    branch,
    memory_count: allMemories.length,
    selected_count: rankedMemories.length,
    duration_ms: durationMs,
  });

  return {
    memoryCount: allMemories.length,
    selectedCount: rankedMemories.length,
    branch,
    cached: false, // Fresh generation, not served from cache
    durationMs,
  };
}

/**
 * Load cached surface if available and fresh.
 * Returns null if no cache or stale.
 */
export function loadCachedSurface(
  cwd: string,
  cachePath?: string
): { surface: string; branch: string; staleness: { stale: boolean; age_hours: number } } | null {
  const cacheDir = cachePath ?? path.join(cwd, '.memory', 'surface-cache');
  const branch = getCurrentBranch(cwd);
  const cacheKey = computeCacheKey(branch, cwd);
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);

  try {
    const cacheData = fs.readFileSync(cacheFile, 'utf8');
    const parsed = JSON.parse(cacheData) as {
      surface: string;
      branch: string;
      cwd: string;
      generated_at: string;
    };

    // Validate cache matches current context
    if (parsed.branch !== branch || parsed.cwd !== cwd) {
      return null;
    }

    // Compute staleness
    const generatedAt = new Date(parsed.generated_at);
    const now = new Date();
    const ageMs = now.getTime() - generatedAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    const stale = ageHours > SURFACE_STALE_HOURS;

    return {
      surface: parsed.surface,
      branch: parsed.branch,
      staleness: { stale, age_hours: ageHours },
    };
  } catch {
    return null; // Cache doesn't exist or invalid
  }
}

/**
 * Write surface to cache.
 * Cache key: hash of (branch, cwd).
 */
function writeCache(cacheDir: string, branch: string, cwd: string, surface: string): void {
  // Ensure cache directory exists
  fs.mkdirSync(cacheDir, { recursive: true });

  const cacheKey = computeCacheKey(branch, cwd);
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);

  const cacheData = {
    surface,
    branch,
    cwd,
    generated_at: new Date().toISOString(),
  };

  fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2), 'utf8');
}

/**
 * Compute cache key from branch and cwd.
 * Uses sha256 hash for consistent file naming.
 */
function computeCacheKey(branch: string, cwd: string): string {
  const input = `${branch}:${cwd}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Invalidate all cached surfaces (FR-022).
 * Called after extraction inserts new memories, since any branch surface may be stale.
 */
export function invalidateSurfaceCache(cwd: string, cachePath?: string): void {
  const cacheDir = cachePath ?? path.join(cwd, '.memory', 'surface-cache');
  try {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(cacheDir, file));
      }
    }
  } catch {
    // Cache dir doesn't exist or already empty — no-op
  }
}
