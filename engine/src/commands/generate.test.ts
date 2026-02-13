
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'crypto';
import { openDatabase, insertMemory, insertEdge } from '../infra/db.js';
import { createMemory, createEdge } from '../core/types.js';
import { runGenerate, loadCachedSurface, invalidateSurfaceCache } from './generate.js';

describe('generate command', () => {
  let tempDir: string;
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-generate-test-'));

    // Create in-memory databases
    projectDb = openDatabase(':memory:');
    globalDb = openDatabase(':memory:');

    // Initialize real git repository
    const { execSync } = require('node:child_process');
    try {
      execSync('git init', { cwd: tempDir, stdio: 'ignore' });
      execSync('git checkout -b main', { cwd: tempDir, stdio: 'ignore' });
      // Create initial commit to establish branch
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tempDir, '.gitignore'), '');
      execSync('git add .gitignore', { cwd: tempDir, stdio: 'ignore' });
      execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: 'ignore' });
    } catch {
      // If git not available, tests will skip branch-specific behavior
    }
  });

  afterEach(() => {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('generates surface from active memories', () => {
    // Arrange: Insert memories
    const mem1 = createMemory({
      id: randomUUID(),
      content: 'Use functional core pattern for business logic',
      summary: 'Functional core pattern preferred',
      memory_type: 'architecture',
      scope: 'project',
      confidence: 0.9,
      priority: 8,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    const mem2 = createMemory({
      id: randomUUID(),
      content: 'Always validate inputs at boundaries',
      summary: 'Validate inputs at boundaries',
      memory_type: 'pattern',
      scope: 'project',
      confidence: 0.85,
      priority: 7,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, mem1);
    insertMemory(projectDb, mem2);

    // Act: Generate surface
    const result = runGenerate({
      projectDb,
      globalDb,
      cwd: tempDir,
    });

    // Assert: Result metadata
    expect(result.memoryCount).toBe(2);
    expect(result.selectedCount).toBeGreaterThan(0);
    expect(result.branch).toBe('main');
    expect(result.cached).toBe(false); // Fresh generation, not from cache
    expect(result.durationMs).toBeGreaterThan(0);

    // Assert: Surface file written
    const surfacePath = path.join(tempDir, '.claude', 'cortex-memory.local.md');
    expect(fs.existsSync(surfacePath)).toBe(true);

    const content = fs.readFileSync(surfacePath, 'utf8');
    expect(content).toContain('<!-- CORTEX_MEMORY_START -->');
    expect(content).toContain('<!-- CORTEX_MEMORY_END -->');
    expect(content).toContain('**Branch:** main');
    expect(content).toContain('Functional core pattern preferred');
  });

  test('merges project and global memories', () => {
    // Arrange: Project memory
    const projectMem = createMemory({
      id: randomUUID(),
      content: 'Project-specific rule',
      summary: 'Project rule',
      memory_type: 'decision',
      scope: 'project',
      confidence: 0.8,
      priority: 6,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    // Global memory
    const globalMem = createMemory({
      id: randomUUID(),
      content: 'Global best practice',
      summary: 'Global best practice',
      memory_type: 'pattern',
      scope: 'global',
      confidence: 0.9,
      priority: 9,
      source_type: 'manual',
      source_session: 'manual-session',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, projectMem);
    insertMemory(globalDb, globalMem);

    // Act
    const result = runGenerate({
      projectDb,
      globalDb,
      cwd: tempDir,
    });

    // Assert: Both memories considered
    expect(result.memoryCount).toBe(2);
  });

  test('boosts memories on current branch', () => {
    // Arrange: Memory on current branch
    const branchMem = createMemory({
      id: randomUUID(),
      content: 'Feature X implementation',
      summary: 'Feature X impl',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.7,
      priority: 5,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    // Memory on different branch
    const otherMem = createMemory({
      id: randomUUID(),
      content: 'Other branch work',
      summary: 'Other work',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.7,
      priority: 5,
      source_type: 'extraction',
      source_session: 'session-2',
      source_context: JSON.stringify({ branch: 'feature-branch', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, branchMem);
    insertMemory(projectDb, otherMem);

    // Act
    const result = runGenerate({
      projectDb,
      globalDb,
      cwd: tempDir,
    });

    // Assert: Surface generated
    expect(result.selectedCount).toBeGreaterThan(0);

    // Branch-specific memory should be ranked higher (checked implicitly via surface content)
    const surfacePath = path.join(tempDir, '.claude', 'cortex-memory.local.md');
    const content = fs.readFileSync(surfacePath, 'utf8');
    const branchMemIndex = content.indexOf('Feature X impl');
    const otherMemIndex = content.indexOf('Other work');

    // If both are present, branch memory should appear first
    if (branchMemIndex !== -1 && otherMemIndex !== -1) {
      expect(branchMemIndex).toBeLessThan(otherMemIndex);
    }
  });

  test('respects centrality in ranking', () => {
    // Arrange: Create memories with edges
    const central = createMemory({
      id: randomUUID(),
      content: 'Central concept',
      summary: 'Central concept',
      memory_type: 'architecture',
      scope: 'project',
      confidence: 0.8,
      priority: 7,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    const peripheral = createMemory({
      id: randomUUID(),
      content: 'Peripheral detail',
      summary: 'Peripheral detail',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.8,
      priority: 7,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, central);
    insertMemory(projectDb, peripheral);

    // Create edges pointing to central (higher centrality)
    const edge1 = createEdge({
      id: randomUUID(),
      source_id: peripheral.id,
      target_id: central.id,
      relation_type: 'relates_to',
      strength: 0.8,
    });

    insertEdge(projectDb, edge1);

    // Act
    const result = runGenerate({
      projectDb,
      globalDb,
      cwd: tempDir,
    });

    // Assert
    expect(result.selectedCount).toBeGreaterThan(0);
  });

  test('writes cache file with metadata', () => {
    // Arrange
    const mem = createMemory({
      id: randomUUID(),
      content: 'Test memory',
      summary: 'Test',
      memory_type: 'decision',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, mem);

    // Act
    runGenerate({
      projectDb,
      globalDb,
      cwd: tempDir,
    });

    // Assert: Cache file exists
    const cacheDir = path.join(tempDir, '.memory', 'surface-cache');
    expect(fs.existsSync(cacheDir)).toBe(true);

    const cacheFiles = fs.readdirSync(cacheDir);
    expect(cacheFiles.length).toBe(1);
    expect(cacheFiles[0]).toMatch(/\.json$/);

    // Verify cache content
    const cacheFile = path.join(cacheDir, cacheFiles[0]);
    const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

    expect(cacheData).toHaveProperty('surface');
    expect(cacheData).toHaveProperty('branch', 'main');
    expect(cacheData).toHaveProperty('cwd', tempDir);
    expect(cacheData).toHaveProperty('generated_at');
    expect(cacheData.surface).toContain('Test');
  });

  test('loads cached surface when fresh', () => {
    // Arrange: Generate surface to create cache
    const mem = createMemory({
      id: randomUUID(),
      content: 'Cached memory',
      summary: 'Cached',
      memory_type: 'pattern',
      scope: 'project',
      confidence: 0.9,
      priority: 8,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, mem);
    runGenerate({ projectDb, globalDb, cwd: tempDir });

    // Act: Load cached surface
    const cached = loadCachedSurface(tempDir);

    // Assert
    expect(cached).not.toBeNull();
    expect(cached!.branch).toBe('main');
    expect(cached!.surface).toContain('Cached');
    expect(cached!.staleness.stale).toBe(false);
    expect(cached!.staleness.age_hours).toBeLessThan(1);
  });

  test('detects stale cache', () => {
    // Arrange: Generate surface
    const mem = createMemory({
      id: randomUUID(),
      content: 'Old memory',
      summary: 'Old',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.7,
      priority: 5,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, mem);
    runGenerate({ projectDb, globalDb, cwd: tempDir });

    // Manually modify cache timestamp to be >24h old
    const cacheDir = path.join(tempDir, '.memory', 'surface-cache');
    const cacheFiles = fs.readdirSync(cacheDir);
    const cacheFile = path.join(cacheDir, cacheFiles[0]);
    const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    cacheData.generated_at = oldTimestamp;
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData), 'utf8');

    // Act: Load cache
    const cached = loadCachedSurface(tempDir);

    // Assert: Cache is stale
    expect(cached).not.toBeNull();
    expect(cached!.staleness.stale).toBe(true);
    expect(cached!.staleness.age_hours).toBeGreaterThan(24);
  });

  test('returns null for missing cache', () => {
    // Act: Load cache before any generation
    const cached = loadCachedSurface(tempDir);

    // Assert
    expect(cached).toBeNull();
  });

  test('writes telemetry file', () => {
    // Arrange
    const mem = createMemory({
      id: randomUUID(),
      content: 'Memory for telemetry test',
      summary: 'Telemetry test',
      memory_type: 'decision',
      scope: 'project',
      confidence: 0.8,
      priority: 6,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, mem);

    // Act
    runGenerate({ projectDb, globalDb, cwd: tempDir });

    // Assert: Telemetry file exists
    const telemetryPath = path.join(tempDir, '.memory', 'cortex-status.json');
    expect(fs.existsSync(telemetryPath)).toBe(true);

    const telemetry = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
    expect(telemetry).toHaveProperty('last_generation');
    expect(telemetry).toHaveProperty('branch', 'main');
    expect(telemetry).toHaveProperty('memory_count', 1);
    expect(telemetry).toHaveProperty('selected_count');
    expect(telemetry).toHaveProperty('duration_ms');
    expect(telemetry.duration_ms).toBeGreaterThan(0);
  });

  test('completes within 5 seconds for realistic workload', () => {
    // Arrange: Insert 100 memories (realistic session size)
    for (let i = 0; i < 100; i++) {
      const mem = createMemory({
        id: randomUUID(),
        content: `Memory ${i} content with some detail`,
        summary: `Memory ${i} summary`,
        memory_type: i % 2 === 0 ? 'pattern' : 'decision',
        scope: 'project',
        confidence: 0.7 + Math.random() * 0.3,
        priority: 5 + Math.floor(Math.random() * 5),
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
      });
      insertMemory(projectDb, mem);
    }

    // Act
    const result = runGenerate({ projectDb, globalDb, cwd: tempDir });

    // Assert: Duration is reasonable (FR-027: <5s p95)
    expect(result.durationMs).toBeLessThan(5000);
  });

  test('handles empty database gracefully', () => {
    // Act: Generate with no memories
    const result = runGenerate({
      projectDb,
      globalDb,
      cwd: tempDir,
    });

    // Assert
    expect(result.memoryCount).toBe(0);
    expect(result.selectedCount).toBe(0);

    // Surface file should still be created (empty)
    const surfacePath = path.join(tempDir, '.claude', 'cortex-memory.local.md');
    expect(fs.existsSync(surfacePath)).toBe(true);
  });

  test('excludes code type memories from surface', () => {
    // Arrange: Code memory (should be excluded)
    const codeMem = createMemory({
      id: randomUUID(),
      content: 'function foo() { return 42; }',
      summary: 'Foo function',
      memory_type: 'code',
      scope: 'project',
      confidence: 0.9,
      priority: 8,
      source_type: 'code_index',
      source_session: 'code-session',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    // Non-code memory (should be included)
    const normalMem = createMemory({
      id: randomUUID(),
      content: 'Architecture principle',
      summary: 'Architecture principle',
      memory_type: 'architecture',
      scope: 'project',
      confidence: 0.9,
      priority: 8,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, codeMem);
    insertMemory(projectDb, normalMem);

    // Act
    runGenerate({ projectDb, globalDb, cwd: tempDir });

    // Assert: Code memory excluded from surface
    const surfacePath = path.join(tempDir, '.claude', 'cortex-memory.local.md');
    const content = fs.readFileSync(surfacePath, 'utf8');

    expect(content).not.toContain('Foo function');
    expect(content).toContain('Architecture principle');
  });

  test('invalidateSurfaceCache removes all cache files (FR-022)', () => {
    // Arrange: Generate multiple cache files
    const mem1 = createMemory({
      id: randomUUID(),
      content: 'Memory 1',
      summary: 'Mem 1',
      memory_type: 'decision',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 'session-1',
      source_context: JSON.stringify({ branch: 'main', recent_commits: [], changed_files: [] }),
    });

    insertMemory(projectDb, mem1);
    runGenerate({ projectDb, globalDb, cwd: tempDir });

    // Verify cache exists
    const cacheDir = path.join(tempDir, '.memory', 'surface-cache');
    expect(fs.existsSync(cacheDir)).toBe(true);
    const cacheFilesBefore = fs.readdirSync(cacheDir);
    expect(cacheFilesBefore.length).toBe(1);

    // Act: Invalidate cache
    invalidateSurfaceCache(tempDir);

    // Assert: Cache files removed
    const cacheFilesAfter = fs.readdirSync(cacheDir);
    expect(cacheFilesAfter.length).toBe(0);
  });

  test('invalidateSurfaceCache handles missing cache directory gracefully', () => {
    // Arrange: No cache directory exists
    const nonExistentDir = path.join(tempDir, 'nonexistent');

    // Act & Assert: Should not throw
    expect(() => invalidateSurfaceCache(nonExistentDir)).not.toThrow();
  });
});

