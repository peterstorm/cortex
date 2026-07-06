/**
 * Tests for config module
 * Pure function tests - no I/O mocks needed
 */

import { describe, it, expect } from 'vitest';
import {
  getProjectDbPath,
  getGlobalDbPath,
  getSurfaceCacheDir,
  getSurfaceOutputPath,
  getLockDir,
  getTelemetryPath,
  getProjectName,
  MAX_TRANSCRIPT_BYTES,
  EXTRACTION_TIMEOUT_MS,
  SURFACE_MAX_TOKENS,
  DEFAULT_SEARCH_LIMIT,
  GITIGNORE_PATTERNS,
  CONSOLIDATION_SIMILARITY_THRESHOLD,
  CONSOLIDATION_LOCAL_COSINE_THRESHOLD,
  DEDUP_SIMILARITY_THRESHOLD,
  MERGE_CEILING_THRESHOLD,
  MAX_EDGES_PER_MEMORY,
  consolidationThresholdFor,
} from './config.js';

describe('config - path resolution', () => {
  it('getProjectDbPath returns correct path', () => {
    const result = getProjectDbPath('/home/user/myproject');
    expect(result).toBe('/home/user/myproject/.memory/cortex.db');
  });

  it('getGlobalDbPath returns path in home directory', () => {
    const result = getGlobalDbPath();
    // Harness-dependent: .claude or .pi/agent
    expect(result).toMatch(/\.(claude|pi\/agent)\/memory\/cortex-global\.db/);
  });

  it('getSurfaceCacheDir returns correct path', () => {
    const result = getSurfaceCacheDir('/project');
    expect(result).toBe('/project/.memory/surface-cache');
  });

  it('getSurfaceOutputPath returns correct path', () => {
    const result = getSurfaceOutputPath('/project');
    // Harness-dependent: .claude or .pi
    expect(result).toMatch(/\/project\/\.(claude|pi)\/cortex-memory\.local\.md/);
  });

  it('getLockDir returns correct path', () => {
    const result = getLockDir('/project');
    expect(result).toBe('/project/.memory/locks');
  });

  it('getTelemetryPath returns correct path', () => {
    const result = getTelemetryPath('/project');
    expect(result).toBe('/project/.memory/telemetry.json');
  });
});

describe('config - project name extraction', () => {
  it('getProjectName extracts last directory', () => {
    expect(getProjectName('/home/user/myproject')).toBe('myproject');
  });

  it('getProjectName handles trailing slash', () => {
    expect(getProjectName('/home/user/myproject/')).toBe('myproject');
  });

  it('getProjectName handles root path', () => {
    expect(getProjectName('/')).toBe('unknown');
  });

  it('getProjectName handles empty path', () => {
    expect(getProjectName('')).toBe('unknown');
  });

  it('getProjectName handles nested path', () => {
    expect(getProjectName('/a/b/c/d')).toBe('d');
  });
});

describe('config - constants', () => {
  it('MAX_TRANSCRIPT_BYTES is 100KB', () => {
    expect(MAX_TRANSCRIPT_BYTES).toBe(100 * 1024);
  });

  it('EXTRACTION_TIMEOUT_MS is 30 seconds', () => {
    expect(EXTRACTION_TIMEOUT_MS).toBe(30_000);
  });

  it('SURFACE_MAX_TOKENS is reasonable', () => {
    expect(SURFACE_MAX_TOKENS).toBeGreaterThan(0);
    expect(SURFACE_MAX_TOKENS).toBeLessThan(10_000);
  });

  it('DEFAULT_SEARCH_LIMIT is positive', () => {
    expect(DEFAULT_SEARCH_LIMIT).toBeGreaterThan(0);
  });

  it('GITIGNORE_PATTERNS includes .memory/', () => {
    expect(GITIGNORE_PATTERNS).toContain('.memory/');
  });

  it('GITIGNORE_PATTERNS includes cortex-memory.local.md', () => {
    expect(GITIGNORE_PATTERNS).toContain('.claude/cortex-memory.local.md');
  });

  it('MAX_EDGES_PER_MEMORY is a small positive cap', () => {
    expect(MAX_EDGES_PER_MEMORY).toBeGreaterThan(0);
    expect(MAX_EDGES_PER_MEMORY).toBeLessThanOrEqual(10);
  });
});

describe('config - consolidationThresholdFor', () => {
  it('uses the well-separated default for jaccard and gemini-cosine', () => {
    expect(consolidationThresholdFor('jaccard')).toBe(CONSOLIDATION_SIMILARITY_THRESHOLD);
    expect(consolidationThresholdFor('gemini-cosine')).toBe(CONSOLIDATION_SIMILARITY_THRESHOLD);
  });

  it('uses the calibrated hot-space threshold for local-cosine', () => {
    expect(consolidationThresholdFor('local-cosine')).toBe(CONSOLIDATION_LOCAL_COSINE_THRESHOLD);
  });

  it('local-cosine threshold sits above the same-domain band (0.6-0.75) and below the true-duplicate band (0.85+)', () => {
    expect(CONSOLIDATION_LOCAL_COSINE_THRESHOLD).toBeGreaterThan(0.75);
    expect(CONSOLIDATION_LOCAL_COSINE_THRESHOLD).toBeLessThan(MERGE_CEILING_THRESHOLD);
    // Consistent with the dedup threshold calibrated for the same space
    expect(CONSOLIDATION_LOCAL_COSINE_THRESHOLD).toBeGreaterThanOrEqual(DEDUP_SIMILARITY_THRESHOLD);
  });
});

describe('config - path composition', () => {
  it('all paths under same project root are consistent', () => {
    const cwd = '/home/user/project';

    const dbPath = getProjectDbPath(cwd);
    const cachePath = getSurfaceCacheDir(cwd);
    const lockPath = getLockDir(cwd);
    const telemetryPath = getTelemetryPath(cwd);

    // All should start with cwd
    expect(dbPath).toContain(cwd);
    expect(cachePath).toContain(cwd);
    expect(lockPath).toContain(cwd);
    expect(telemetryPath).toContain(cwd);

    // All should be under .memory/ except surface output
    expect(dbPath).toContain('.memory');
    expect(cachePath).toContain('.memory');
    expect(lockPath).toContain('.memory');
    expect(telemetryPath).toContain('.memory');
  });

  it('surface output path is under harness directory', () => {
    const result = getSurfaceOutputPath('/project');
    // In test context (no PI_CODING_AGENT_DIR), defaults to .claude
    expect(result).toMatch(/\.(claude|pi)/);
  });
});
