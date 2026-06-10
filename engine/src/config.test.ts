/**
 * Tests for config module
 * Pure function tests - no I/O mocks needed
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  detectHarness,
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
} from './config.js';

describe('config - path resolution', () => {
  it('getProjectDbPath returns correct path', () => {
    const result = getProjectDbPath('/home/user/myproject');
    expect(result).toBe('/home/user/myproject/.memory/cortex.db');
  });

  it('getGlobalDbPath returns path in home directory', () => {
    const result = getGlobalDbPath();
    expect(result).toContain(homedir());
    expect(result).toContain('cortex-global.db');
  });

  it('getSurfaceCacheDir returns correct path', () => {
    const result = getSurfaceCacheDir('/project');
    expect(result).toBe('/project/.memory/surface-cache');
  });

  it('getSurfaceOutputPath returns correct path', () => {
    const result = getSurfaceOutputPath('/project');
    expect(result).toBe('/project/.claude/cortex-memory.local.md');
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

  it('GITIGNORE_PATTERNS contains exactly the live cortex paths', () => {
    // .pi/cortex-memory.local.md was removed when the surface unified on .claude/
    expect([...GITIGNORE_PATTERNS]).toEqual([
      '.memory/',
      '.claude/cortex-memory.local.md',
    ]);
  });
});

describe('config - harness detection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('detectHarness returns claude when pi env vars are absent', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    vi.stubEnv('PI_CODING_AGENT', '');
    expect(detectHarness()).toBe('claude');
  });

  it('detectHarness returns pi when PI_CODING_AGENT_DIR is set', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/home/user/.pi');
    expect(detectHarness()).toBe('pi');
  });

  it('getGlobalDbPath uses .claude under claude harness', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    vi.stubEnv('PI_CODING_AGENT', '');
    expect(getGlobalDbPath()).toBe(
      join(homedir(), '.claude', 'memory', 'cortex-global.db')
    );
  });

  it('getGlobalDbPath uses .pi/agent under pi harness', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/home/user/.pi');
    expect(getGlobalDbPath()).toBe(
      join(homedir(), '.pi', 'agent', 'memory', 'cortex-global.db')
    );
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

  it('surface output path stays under .claude even under pi harness', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/home/user/.pi');
    try {
      expect(getSurfaceOutputPath('/project')).toBe(
        '/project/.claude/cortex-memory.local.md'
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
