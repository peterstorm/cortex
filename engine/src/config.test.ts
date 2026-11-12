/**
 * Tests for config module
 * Pure function tests - no I/O mocks needed
 */

import { describe, it, expect } from 'vitest';
import {
  getProjectDbPath,
  getLegacyGlobalDbPaths,
  homeDir,
  locateGlobalDb,
  getSurfaceCacheDir,
  getSurfaceOutputPath,
  getLockDir,
  getTelemetryPath,
  MAX_TRANSCRIPT_BYTES,
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

  it('the global DB path is the same for every harness: the XDG data dir, under home by default', () => {
    expect(locateGlobalDb({}, '/home/u').path).toBe('/home/u/.local/share/cortex/global.db');
    expect(locateGlobalDb({ PI_CODING_AGENT_DIR: '/home/u/.pi/agent' }, '/home/u').path).toBe(
      '/home/u/.local/share/cortex/global.db',
    );
  });

  it('the global DB path honours XDG_DATA_HOME, ignoring a relative one as the spec requires', () => {
    expect(locateGlobalDb({ XDG_DATA_HOME: '/data' }, '/home/u').path).toBe('/data/cortex/global.db');
    expect(locateGlobalDb({ XDG_DATA_HOME: 'relative/data' }, '/home/u').path).toBe(
      '/home/u/.local/share/cortex/global.db',
    );
  });

  it('the global DB path lets CORTEX_GLOBAL_DB override everything', () => {
    expect(locateGlobalDb({ CORTEX_GLOBAL_DB: '/x/m.db', XDG_DATA_HOME: '/data' }, '/home/u').path).toBe('/x/m.db');
  });

  it('locateGlobalDb tells an explicit override from the default, which is the one merged into', () => {
    expect(locateGlobalDb({ CORTEX_GLOBAL_DB: '/x/m.db' }, '/home/u')).toEqual({ kind: 'override', path: '/x/m.db' });
    expect(locateGlobalDb({}, '/home/u')).toEqual({ kind: 'default', path: '/home/u/.local/share/cortex/global.db' });
  });

  it('homeDir takes an absolute $HOME and ignores a relative one', () => {
    expect(homeDir({ HOME: '/tmp/isolated-home' })).toBe('/tmp/isolated-home');
    expect(homeDir({ HOME: 'relative' })).not.toBe('relative');
    expect(locateGlobalDb({ HOME: '/tmp/isolated-home' }).path).toBe('/tmp/isolated-home/.local/share/cortex/global.db');
  });

  it('getLegacyGlobalDbPaths lists the old per-harness files, Claude first', () => {
    expect(getLegacyGlobalDbPaths('/home/u')).toEqual([
      { harness: 'claude', path: '/home/u/.claude/memory/cortex-global.db' },
      { harness: 'pi', path: '/home/u/.pi/agent/memory/cortex-global.db' },
    ]);
  });

  it('getSurfaceCacheDir returns correct path', () => {
    const result = getSurfaceCacheDir('/project');
    expect(result).toBe('/project/.memory/surface-cache');
  });

  it('getSurfaceOutputPath always returns the unified .claude path', () => {
    expect(getSurfaceOutputPath('/project')).toBe('/project/.claude/cortex-memory.local.md');
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

describe('config - constants', () => {
  it('MAX_TRANSCRIPT_BYTES is 100KB', () => {
    expect(MAX_TRANSCRIPT_BYTES).toBe(100 * 1024);
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
  it('uses the well-separated default for jaccard', () => {
    expect(consolidationThresholdFor('jaccard')).toBe(CONSOLIDATION_SIMILARITY_THRESHOLD);
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
