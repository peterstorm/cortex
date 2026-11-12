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
import { admitAll, type MemoryAdmission } from '../core/admission.js';
import type { RankedMemory } from '../core/surface.js';
import type { EntityProfile } from '../core/entities.js';
import { SURFACE_STALE_HOURS, SURFACE_OVERHEAD_TOKENS, getStatusPath } from '../config.js';
import { getActiveMemories, getAllEdges, getAllEntities, getCurrentFacts } from '../infra/db.js';
import { computeAllCentrality } from '../core/graph.js';
import { selectForSurface } from '../core/ranking.js';
import { generateSurface, wrapInMarkers, renderEntitySection, estimateTokens } from '../core/surface.js';
import { writeSurface, writeTelemetry } from '../infra/filesystem.js';
import { getCurrentBranch } from '../infra/git-context.js';

export interface GenerateOptions {
  readonly projectDb: Database;
  readonly globalDb: Database;
  /** Where the session runs: the branch, the surface file and the cache key. */
  readonly cwd: string;
  /**
   * Where the project's `.memory/` lives: cache, locks and status. Required,
   * so a caller cannot fall back to the session directory by omission and
   * split the project's memory per directory again.
   */
  readonly root: string;
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
  const { root } = options;
  const surfacePath = options.surfacePath ?? path.join(options.cwd, '.claude', 'cortex-memory.local.md');
  const cachePath = options.cachePath ?? path.join(root, '.memory', 'surface-cache');
  const lockDir = options.lockDir ?? path.join(root, '.memory', 'locks');

  // I/O: Get current branch
  const branch = getCurrentBranch(options.cwd);

  const surface = composeSurface(options.projectDb, options.globalDb, branch);

  // Pure: Wrap in markers
  const markedContent = wrapInMarkers(surface.content);

  // I/O: Write surface with PID lock
  writeSurface(surfacePath, markedContent, lockDir);

  // I/O: Write cache (fingerprinted against both DBs so archives/merges
  // that don't go through invalidateSurfaceCache still miss the cache)
  const fingerprint = computeDbFingerprint(options.projectDb, options.globalDb);
  writeCache(cachePath, branch, options.cwd, surface.content, fingerprint);

  // I/O: Write telemetry
  const durationMs = Date.now() - startTime;
  writeTelemetry(getStatusPath(root), {
    last_generation: new Date().toISOString(),
    branch,
    memory_count: surface.memoryCount,
    selected_count: surface.selectedCount,
    duration_ms: durationMs,
  });

  return {
    memoryCount: surface.memoryCount,
    selectedCount: surface.selectedCount,
    branch,
    cached: false, // Fresh generation, not served from cache
    durationMs,
  };
}

export interface ComposedSurface {
  /** Surface markdown, not yet wrapped in markers. */
  readonly content: string;
  readonly memoryCount: number;
  readonly selectedCount: number;
}

/**
 * Compose the push surface from both DBs without writing anything — what
 * runGenerate persists and what the eval harness injects.
 *
 * Data flow:
 * 1. getActiveMemories from both DBs, filtered by `admit` (I/O)
 * 2. entity profiles, minus facts whose source memory was refused (I/O)
 * 3. getAllEdges for centrality (I/O)
 * 4. computeAllCentrality (pure)
 * 5. selectForSurface → RankedMemory[] (pure, single ranking pass)
 * 6. generateSurface (pure)
 */
export function composeSurface(
  projectDb: Database,
  globalDb: Database,
  branch: string,
  options: { readonly admit?: MemoryAdmission; readonly now?: Date } = {},
): ComposedSurface {
  const admit = options.admit ?? admitAll;
  // I/O: Fetch active memories from both DBs
  const active = [...getActiveMemories(projectDb), ...getActiveMemories(globalDb)];
  // `admit` is asked once per memory; the admitted list is derived from the
  // refused set, so the two cannot disagree.
  const refused = new Set(active.filter((mem) => !admit(mem)).map((mem) => mem.id));
  const allMemories = active.filter((mem) => !refused.has(mem.id));

  // I/O: Fetch entities and current facts for surface entity section
  const entityProfiles = buildEntityProfiles(projectDb, globalDb, refused);

  // I/O: Fetch all edges for centrality computation
  const allEdges = [...getAllEdges(projectDb), ...getAllEdges(globalDb)];

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
  const rankedMemories: readonly RankedMemory[] = selectForSurface(memoriesWithCentrality, {
    currentBranch: branch,
    targetTokens: Math.max(200, 1500 - SURFACE_OVERHEAD_TOKENS - entityTokens),
    maxTokens: Math.max(200, 2000 - SURFACE_OVERHEAD_TOKENS - entityTokens),
    now: options.now,
  });

  // Pure: Generate surface markdown (includes entity profiles section)
  return {
    content: generateSurface(rankedMemories, branch, null, {}, entityProfiles),
    memoryCount: allMemories.length,
    selectedCount: rankedMemories.length,
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
 * Deduplicates by entity name (case-insensitive). Skips entities with no
 * current facts, after dropping facts sourced from a refused memory.
 * I/O: Reads from database.
 */
function buildEntityProfiles(
  projectDb: Database,
  globalDb: Database,
  refusedMemoryIds: ReadonlySet<string>,
): readonly EntityProfile[] {
  const profiles: EntityProfile[] = [];
  const seen = new Set<string>();

  for (const db of [projectDb, globalDb]) {
    const entities = getAllEntities(db);
    for (const entity of entities) {
      const key = entity.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const facts = getCurrentFacts(db, entity.id).filter(
        (fact) => !refusedMemoryIds.has(fact.source_memory_id),
      );
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
 * The cache lives with the project's memory, so this clears every worktree's
 * and every subdirectory's cached surface of the project at once.
 *
 * @param projectRoot - where the project's `.memory/` lives
 */
export function invalidateSurfaceCache(projectRoot: string, cachePath?: string): void {
  const cacheDir = cachePath ?? path.join(projectRoot, '.memory', 'surface-cache');
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
