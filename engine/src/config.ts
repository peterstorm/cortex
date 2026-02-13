/**
 * Configuration module - paths, constants, environment variables
 * Pure functions for path resolution and config access
 * No side effects - callers handle file I/O
 */

import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

/**
 * Get Gemini API key from environment
 * Returns undefined if not set
 */
export function getGeminiApiKey(): string | undefined {
  return Bun.env.GEMINI_API_KEY;
}

/**
 * Get plugin root directory from environment
 * Returns undefined if not set
 */
export function getPluginRoot(): string | undefined {
  return Bun.env.CLAUDE_PLUGIN_ROOT;
}

// ============================================================================
// PATH RESOLUTION
// ============================================================================

/**
 * Resolve project-scoped database path
 * Pure function - returns path relative to project root
 *
 * @param projectRoot - Absolute path to project root (cwd from hook input)
 * @returns Absolute path to project database
 */
export function getProjectDbPath(projectRoot: string): string {
  return join(projectRoot, '.memory', 'cortex.db');
}

/**
 * Resolve global database path
 * Pure function - returns path in user home directory
 *
 * @returns Absolute path to global database
 */
export function getGlobalDbPath(): string {
  return join(homedir(), '.claude', 'memory', 'cortex-global.db');
}

/**
 * Resolve surface cache directory
 * Pure function - returns path relative to project root
 *
 * @param projectRoot - Absolute path to project root
 * @returns Absolute path to surface cache directory
 */
export function getSurfaceCacheDir(projectRoot: string): string {
  return join(projectRoot, '.memory', 'surface-cache');
}

/**
 * Resolve push surface output file path
 * Pure function - output file written to .claude/cortex-memory.local.md
 *
 * @param projectRoot - Absolute path to project root
 * @returns Absolute path to surface output file
 */
export function getSurfaceOutputPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'cortex-memory.local.md');
}

/**
 * Resolve PID lock directory
 * Pure function - lock directory under .memory
 *
 * @param projectRoot - Absolute path to project root
 * @returns Absolute path to lock directory
 */
export function getLockDir(projectRoot: string): string {
  return join(projectRoot, '.memory', 'locks');
}

/**
 * Resolve telemetry log path
 * Pure function - telemetry stored in .memory/telemetry.json
 *
 * @param projectRoot - Absolute path to project root
 * @returns Absolute path to telemetry file
 */
export function getTelemetryPath(projectRoot: string): string {
  return join(projectRoot, '.memory', 'telemetry.json');
}

/**
 * Resolve project name from project root path
 * Pure function - extracts last path segment as project name
 *
 * @param projectRoot - Absolute path to project root
 * @returns Project name (last directory name)
 */
export function getProjectName(projectRoot: string): string {
  return basename(projectRoot) || 'unknown';
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Maximum transcript size before truncation (100KB per FR-012)
 */
export const MAX_TRANSCRIPT_BYTES = 100 * 1024;

/**
 * Extraction timeout in milliseconds (30s per NFR-001)
 */
export const EXTRACTION_TIMEOUT_MS = 30_000;

/**
 * Surface generation token budget (includes ~200 tokens markdown overhead)
 */
export const SURFACE_MAX_TOKENS = 2000;

/**
 * Tokens reserved for markdown formatting overhead (headers, markers, metadata)
 */
export const SURFACE_OVERHEAD_TOKENS = 200;

/**
 * Recency decay half-life in days for ranking formula.
 * At this age, a memory's recency multiplier = 0.5.
 * 0 days → ×1.0, 7 days → ×0.67, 14 days → ×0.5, 30 days → ×0.31
 */
export const RECENCY_HALF_LIFE_DAYS = 14;

/**
 * Surface staleness threshold in hours (24h per FR-022)
 */
export const SURFACE_STALE_HOURS = 24;

/**
 * Consolidation trigger: extraction count threshold
 */
export const CONSOLIDATION_EXTRACTION_THRESHOLD = 10;

/**
 * Consolidation trigger: active memory count threshold
 */
export const CONSOLIDATION_ACTIVE_THRESHOLD = 80;

/**
 * Lifecycle decay check interval in days
 * How often decay confidence should be recomputed (1 day)
 */
export const DECAY_CHECK_INTERVAL_DAYS = 1;

/**
 * Lifecycle archive threshold in days
 * How long memory must be below confidence threshold before archival (7 days)
 */
export const ARCHIVE_THRESHOLD_DAYS = 7;

/**
 * Lifecycle prune threshold in days
 * How long archived memory must remain before pruning (90 days)
 */
export const PRUNE_THRESHOLD_DAYS = 90;

/**
 * Default search result limit
 */
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Default graph traversal max depth
 */
export const DEFAULT_TRAVERSAL_DEPTH = 2;

/**
 * Patterns to add to .gitignore for Cortex files
 */
export const GITIGNORE_PATTERNS = [
  '.memory/',
  '.claude/cortex-memory.local.md',
] as const;
