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
  MAX_EDGES_PER_MEMORY,
  ACTIVE_COSINE_CALIBRATION,
  ACTIVE_DEDUP_POLICY,
  JACCARD_DEDUP,
  LOCAL_EMBED_MODEL,
  cosineCalibrationFor,
  dedupPolicyFor,
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

describe('config - cosine calibration per model', () => {
  const BGE = 'Xenova/bge-small-en-v1.5';
  const POTION = 'minishlab/potion-retrieval-32M';

  it('an unknown model is uncalibrated, so every comparison fails closed to Jaccard', () => {
    expect(cosineCalibrationFor('google/embeddinggemma-300m')).toBeNull();
    expect(dedupPolicyFor(null)).toEqual({ jaccard: JACCARD_DEDUP, cosine: null });
  });

  it('BGE keeps exactly the numbers it was tuned with, edge bands included', () => {
    expect(cosineCalibrationFor(BGE)).toEqual({
      dedup: {
        existing: { kind: 'merge-then-skip', mergeFrom: 0.75, skipFrom: 0.85 },
        intraBatch: 0.75,
      },
      consolidationCandidate: 0.8,
      edgeBands: { relateFrom: 0.6, suggestFrom: 0.75, consolidateFrom: 0.82 },
      restatement: null,
      distinctRecall: null,
    });
  });

  it('potion skips from 0.92 with no merge band and has no edge bands', () => {
    expect(cosineCalibrationFor(POTION)).toEqual({
      dedup: { existing: { kind: 'skip-only', skipFrom: 0.92 }, intraBatch: 0.92 },
      consolidationCandidate: 0.85,
      edgeBands: null,
      restatement: 0.9,
      distinctRecall: 0.85,
    });
  });

  it('the active calibration is the one recorded for LOCAL_EMBED_MODEL', () => {
    expect(ACTIVE_COSINE_CALIBRATION).toBe(cosineCalibrationFor(LOCAL_EMBED_MODEL));
    expect(ACTIVE_DEDUP_POLICY).toEqual(dedupPolicyFor(ACTIVE_COSINE_CALIBRATION));
  });

  it('every recorded threshold is a cosine in (0, 1] and every band is ordered', () => {
    for (const model of [BGE, POTION]) {
      const calibration = cosineCalibrationFor(model);
      expect(calibration).not.toBeNull();
      if (calibration === null) continue;
      const { existing } = calibration.dedup;
      if (existing.kind === 'merge-then-skip') expect(existing.mergeFrom).toBeLessThan(existing.skipFrom);
      const bands = calibration.edgeBands;
      if (bands !== null) {
        expect(bands.relateFrom).toBeLessThan(bands.suggestFrom);
        expect(bands.suggestFrom).toBeLessThan(bands.consolidateFrom);
      }
      const thresholds = [
        existing.skipFrom,
        calibration.dedup.intraBatch,
        calibration.consolidationCandidate,
        calibration.restatement ?? 1,
        calibration.distinctRecall ?? 1,
      ];
      for (const t of thresholds) {
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the Jaccard fallback keeps the effective thresholds of today: merge 0.75, skip 0.85, intra-batch 0.75', () => {
    expect(JACCARD_DEDUP).toEqual({
      existing: { kind: 'merge-then-skip', mergeFrom: 0.75, skipFrom: 0.85 },
      intraBatch: 0.75,
    });
    expect(CONSOLIDATION_SIMILARITY_THRESHOLD).toBe(0.5);
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
