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
import type { EntityProfile } from '../core/entities.js';
import { SURFACE_STALE_HOURS, SURFACE_OVERHEAD_TOKENS } from '../config.js';
import { getActiveMemories, getAllEdges, getAllEntities, getCurrentFacts } from '../infra/db.js';
import { computeAllCentrality } from '../core/graph.js';
import { selectForSurface } from '../core/ranking.js';
import { generateSurface, wrapInMarkers, renderEntitySection, estimateTokens } from '../core/surface.js';
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

  // I/O: Fetch entities and current facts for surface entity section
  const entityProfiles = buildEntityProfiles(options.projectDb, options.globalDb);

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

  // Account the entity section against the token budget BEFORE selection —
  // it is appended to the surface but was previously unbudgeted, letting the
  // rendered surface overshoot maxTokens by up to 5 entities × 3 facts.
  const entitySection = renderEntitySection(entityProfiles);
  const entityTokens = entitySection ? estimateTokens(entitySection) : 0;

  // Pure: Select and rank memories for surface with branch boost
  // Reserve SURFACE_OVERHEAD_TOKENS for markdown formatting (headers, markers)
  // plus the measured entity section cost. Floor at 200 tokens so a huge
  // entity section can't zero out memory selection entirely.
  const rankedMemories: RankedMemory[] = selectForSurface(memoriesWithCentrality, {
    currentBranch: branch,
    targetTokens: Math.max(200, 1500 - SURFACE_OVERHEAD_TOKENS - entityTokens),
    maxTokens: Math.max(200, 2000 - SURFACE_OVERHEAD_TOKENS - entityTokens),
  });

  // Pure: Generate surface markdown (includes entity profiles section)
  const surfaceContent = generateSurface(rankedMemories, branch, null, {}, entityProfiles);

  // Pure: Wrap in markers
  const markedContent = wrapInMarkers(surfaceContent);

  // I/O: Write surface with PID lock
  writeSurface(surfacePath, markedContent, lockDir);

  // I/O: Write cache (fingerprinted against both DBs so archives/merges
  // that don't go through invalidateSurfaceCache still miss the cache)
  const fingerprint = computeDbFingerprint(options.projectDb, options.globalDb);
  writeCache(cachePath, branch, options.cwd, surfaceContent, fingerprint);

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
 * Fingerprint the visible (active) memory set of both DBs.
 * Any archive, merge, insert, or content update changes the fingerprint
 * (count and/or max(updated_at)), so a cached surface built against a
 * different memory set is detectably stale regardless of its age.
 * I/O: Reads from database.
 */
export function computeDbFingerprint(projectDb: Database, globalDb: Database): string {
  const fp = (db: Database): string => {
    const row = db
      .prepare(
        `SELECT count(*) || ':' || coalesce(max(updated_at), '') AS fp FROM memories WHERE status = 'active'`
      )
      .get() as { fp: string };
    return row.fp;
  };
  return `${fp(projectDb)}|${fp(globalDb)}`;
}

/**
 * Normalize a cwd for cache keying/comparison.
 * realpathSync resolves symlinks so a symlinked cwd hits the same cache
 * entry; falls back to path.resolve when the path can't be resolved.
 */
function normalizeCwd(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * Load cached surface if available and fresh.
 * Returns null if no cache, stale context (branch/cwd mismatch), or — when
 * `expectedFingerprint` is provided — the cached DB fingerprint doesn't match
 * the current one (memories changed since the cache was written).
 */
export function loadCachedSurface(
  cwd: string,
  cachePath?: string,
  expectedFingerprint?: string
): { surface: string; branch: string; staleness: { stale: boolean; age_hours: number } } | null {
  const cacheDir = cachePath ?? path.join(cwd, '.memory', 'surface-cache');
  const branch = getCurrentBranch(cwd);
  const normCwd = normalizeCwd(cwd);
  const cacheKey = computeCacheKey(branch, normCwd);
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);

  try {
    const cacheData = fs.readFileSync(cacheFile, 'utf8');
    const parsed = JSON.parse(cacheData) as {
      surface: string;
      branch: string;
      cwd: string;
      generated_at: string;
      db_fingerprint?: string;
    };

    // Validate cache matches current context (cwd normalized on both sides
    // so symlinked cwds still hit)
    if (parsed.branch !== branch || normalizeCwd(parsed.cwd) !== normCwd) {
      return null;
    }

    // Validate DB fingerprint when the caller can supply one: a mismatch
    // (or a legacy cache without one) means the memory set changed —
    // serving it would resurface archived/forgotten memories.
    if (expectedFingerprint !== undefined && parsed.db_fingerprint !== expectedFingerprint) {
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
function writeCache(
  cacheDir: string,
  branch: string,
  cwd: string,
  surface: string,
  dbFingerprint: string
): void {
  // Ensure cache directory exists
  fs.mkdirSync(cacheDir, { recursive: true });

  const normCwd = normalizeCwd(cwd);
  const cacheKey = computeCacheKey(branch, normCwd);
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);

  const cacheData = {
    surface,
    branch,
    cwd: normCwd,
    generated_at: new Date().toISOString(),
    db_fingerprint: dbFingerprint,
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
 * Build entity profiles from both DBs for surface rendering.
 * Deduplicates by entity name (case-insensitive). Skips entities with no current facts.
 * I/O: Reads from database.
 */
function buildEntityProfiles(projectDb: Database, globalDb: Database): readonly EntityProfile[] {
  const profiles: EntityProfile[] = [];
  const seen = new Set<string>();

  for (const db of [projectDb, globalDb]) {
    const entities = getAllEntities(db);
    for (const entity of entities) {
      const key = entity.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const facts = getCurrentFacts(db, entity.id);
      if (facts.length === 0) continue;

      profiles.push({
        entity,
        currentFacts: facts,
        sourceMemories: [],
      });
    }
  }

  return profiles;
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
