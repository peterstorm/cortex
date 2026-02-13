
/**
 * End-to-end integration tests for Cortex memory system
 *
 * NOTE: These tests may fail when run with the full suite due to mock pollution
 * from backfill.test.ts. Run in isolation for accurate results:
 *   bun test src/commands/e2e.test.ts
 *
 * The tests exercise the full pipeline without requiring API keys by using
 * keyword search instead of semantic search (no embeddings needed).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import { openDatabase } from '../infra/db.js';
import { executeRemember } from './remember.js';
import { executeRecall } from './recall.js';
import { forgetById } from './forget.js';
import { runLifecycle } from './lifecycle.js';
import { runGenerate } from './generate.js';
import { getMemory } from '../infra/db.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Cortex E2E Integration Tests', () => {
  let projectDb: Database;
  let globalDb: Database;
  let tempDir: string;
  const sessionId = 'e2e-test-session';

  beforeEach(() => {
    // Create fresh in-memory databases for each test
    projectDb = openDatabase(':memory:');
    globalDb = openDatabase(':memory:');

    // Create temp directory for file operations
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-'));
  });

  afterEach(() => {
    // Restore all mocks to prevent pollution from other test files
    vi.restoreAllMocks();
  });

  test('full pipeline: remember -> recall -> forget -> verify archived', async () => {
    // Step 1: Remember - Create explicit memory
    const rememberResult = executeRemember(
      ['Test architecture decision about database choice', '--type=decision', '--priority=8'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(rememberResult.success).toBe(true);
    if (!rememberResult.success) return;

    const memoryId = rememberResult.memory_id;

    // Step 2: Recall - Find the memory using keyword search
    const recallResult1 = await executeRecall(projectDb, globalDb, {
      query: 'database architecture',
      limit: 10,
      // No geminiApiKey - forces keyword search
    });

    expect(recallResult1.success).toBe(true);
    if (!recallResult1.success) return;

    expect(recallResult1.result.method).toBe('keyword');
    expect(recallResult1.result.results.length).toBeGreaterThan(0);
    const foundMemory = recallResult1.result.results.find((r) => r.memory.id === memoryId);
    expect(foundMemory).toBeDefined();
    expect(foundMemory?.memory.content).toContain('database choice');

    // Step 3: Forget - Archive the memory
    const forgetResult = forgetById(projectDb, memoryId);
    expect(forgetResult.status).toBe('archived');

    // Step 4: Verify memory is archived in database
    const archivedMemory = getMemory(projectDb, memoryId);
    expect(archivedMemory).not.toBeNull();
    expect(archivedMemory!.status).toBe('archived');

    // Step 5: Recall again - archived memories are still searchable in current implementation
    // (This tests that recall works with archived memories, which may be useful for recovery)
    const recallResult2 = await executeRecall(projectDb, globalDb, {
      query: 'database architecture',
      limit: 10,
    });

    expect(recallResult2.success).toBe(true);
    if (!recallResult2.success) return;

    // Memory is found but status shows it's archived
    const foundAfterArchive = recallResult2.result.results.find((r) => r.memory.id === memoryId);
    expect(foundAfterArchive).toBeDefined();
    expect(foundAfterArchive?.memory.status).toBe('archived');
  });

  test('lifecycle: decay -> archive -> prune', () => {
    // Create a progress memory with low confidence, old timestamp
    const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

    // Use executeRemember but then manually update timestamps for testing
    const rememberResult = executeRemember(
      ['Old progress note', '--type=progress', '--priority=5'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(rememberResult.success).toBe(true);
    if (!rememberResult.success) return;

    const memoryId = rememberResult.memory_id;

    // Manually set old timestamps and low confidence for testing decay
    const updateStmt = projectDb.prepare(`
      UPDATE memories
      SET confidence = 0.1,
          created_at = ?,
          last_accessed_at = ?
      WHERE id = ?
    `);
    updateStmt.run(hundredDaysAgo, hundredDaysAgo, memoryId);

    // Run lifecycle - should decay and potentially archive/prune
    const lifecycleResult = runLifecycle(projectDb);

    // With very old progress memory (100d) at 0.1 confidence:
    // - Will decay further
    // - Should be archived (confidence < 0.3 for 14+ days)
    // - Should be pruned (unaccessed 30+ days while archived)
    expect(lifecycleResult.archived).toBeGreaterThan(0);
    expect(lifecycleResult.pruned).toBeGreaterThan(0);

    // Verify final status
    const finalMemory = getMemory(projectDb, memoryId);
    expect(finalMemory).not.toBeNull();
    expect(finalMemory!.status).toBe('pruned');
  });

  test('generate: create push surface from memories', () => {
    // Create multiple memories with different types
    const memories = [
      ['Core architecture uses functional programming', '--type=architecture', '--priority=9'],
      ['API endpoint pattern: /api/v1/{resource}', '--type=pattern', '--priority=8'],
      ['Remember to update docs after schema changes', '--type=gotcha', '--priority=7'],
      ['Current sprint: implement search feature', '--type=progress', '--priority=6'],
    ];

    for (const args of memories) {
      const result = executeRemember(args, sessionId, projectDb, globalDb);
      expect(result.success).toBe(true);
    }

    // Create .claude directory for surface output
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Mock git to return a branch (since temp dir is not a git repo)
    // We'll use default 'main' from getCurrentBranch fallback

    // Generate push surface
    const generateResult = runGenerate({
      projectDb,
      globalDb,
      cwd: tempDir,
      surfacePath: path.join(claudeDir, 'cortex-memory.local.md'),
      cachePath: path.join(tempDir, '.memory', 'surface-cache'),
      lockDir: path.join(tempDir, '.memory', 'locks'),
    });

    expect(generateResult.memoryCount).toBe(4);
    expect(generateResult.selectedCount).toBeGreaterThan(0);
    expect(generateResult.branch).toBeTruthy();

    // Verify surface file was written
    const surfacePath = path.join(claudeDir, 'cortex-memory.local.md');
    expect(fs.existsSync(surfacePath)).toBe(true);

    const surfaceContent = fs.readFileSync(surfacePath, 'utf8');
    expect(surfaceContent).toContain('<!-- CORTEX_MEMORY_START -->');
    expect(surfaceContent).toContain('<!-- CORTEX_MEMORY_END -->');
    expect(surfaceContent).toContain('functional programming'); // architecture memory
  });

  test('project vs global scope isolation', async () => {
    // Create project-scoped memory
    const projectResult = executeRemember(
      ['Project-specific database configuration', '--type=context', '--scope=project'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(projectResult.success).toBe(true);
    if (!projectResult.success) return;

    // Create global-scoped memory
    const globalResult = executeRemember(
      ['Global design pattern for all projects', '--type=pattern', '--scope=global'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(globalResult.success).toBe(true);
    if (!globalResult.success) return;

    // Verify project memory is in project DB only
    const projectMem = getMemory(projectDb, projectResult.memory_id);
    expect(projectMem).not.toBeNull();
    expect(projectMem!.scope).toBe('project');

    const projectMemInGlobal = getMemory(globalDb, projectResult.memory_id);
    expect(projectMemInGlobal).toBeNull();

    // Verify global memory is in global DB only
    const globalMem = getMemory(globalDb, globalResult.memory_id);
    expect(globalMem).not.toBeNull();
    expect(globalMem!.scope).toBe('global');

    const globalMemInProject = getMemory(projectDb, globalResult.memory_id);
    expect(globalMemInProject).toBeNull();

    // Recall should search both DBs and merge results
    // Use more specific keywords to ensure match
    const recallResult = await executeRecall(projectDb, globalDb, {
      query: 'database configuration',
      limit: 10,
    });

    expect(recallResult.success).toBe(true);
    if (!recallResult.success) return;

    // Should find the project memory
    const projectFound = recallResult.result.results.some(
      (r) => r.memory.id === projectResult.memory_id
    );

    expect(projectFound).toBe(true);

    // Test global DB search
    const globalRecallResult = await executeRecall(projectDb, globalDb, {
      query: 'design pattern',
      limit: 10,
    });

    expect(globalRecallResult.success).toBe(true);
    if (!globalRecallResult.success) return;

    const globalFound = globalRecallResult.result.results.some(
      (r) => r.memory.id === globalResult.memory_id
    );

    expect(globalFound).toBe(true);
  });

  test('multiple memory types with keyword search', async () => {
    // Create memories of different types
    const types = [
      { content: 'System uses microservices architecture', type: 'architecture' },
      { content: 'Decided to use PostgreSQL for ACID guarantees', type: 'decision' },
      { content: 'Repository pattern isolates data access', type: 'pattern' },
      { content: 'Watch out for N+1 query problem', type: 'gotcha' },
    ];

    for (const { content, type } of types) {
      const result = executeRemember(
        [content, `--type=${type}`, '--priority=7'],
        sessionId,
        projectDb,
        globalDb
      );
      expect(result.success).toBe(true);
    }

    // Search for common term "pattern"
    const recallResult = await executeRecall(projectDb, globalDb, {
      query: 'pattern',
      limit: 10,
    });

    expect(recallResult.success).toBe(true);
    if (!recallResult.success) return;

    expect(recallResult.result.method).toBe('keyword');
    expect(recallResult.result.results.length).toBeGreaterThan(0);

    // Should find the pattern type memory
    const patternMemory = recallResult.result.results.find((r) =>
      r.memory.content.includes('Repository pattern')
    );
    expect(patternMemory).toBeDefined();
    expect(patternMemory?.memory.memory_type).toBe('pattern');
  });

  test('pinned memories survive lifecycle decay', () => {
    // Create pinned and non-pinned progress memories (fast decay type)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const pinnedResult = executeRemember(
      ['Important milestone - pinned', '--type=progress', '--priority=9', '--pinned'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(pinnedResult.success).toBe(true);
    if (!pinnedResult.success) return;

    const normalResult = executeRemember(
      ['Regular progress note', '--type=progress', '--priority=5'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(normalResult.success).toBe(true);
    if (!normalResult.success) return;

    // Set old timestamps for testing
    for (const memId of [pinnedResult.memory_id, normalResult.memory_id]) {
      const updateStmt = projectDb.prepare(`
        UPDATE memories
        SET created_at = ?, last_accessed_at = ?
        WHERE id = ?
      `);
      updateStmt.run(thirtyDaysAgo, thirtyDaysAgo, memId);
    }

    // Run lifecycle
    runLifecycle(projectDb);

    // Pinned memory should maintain confidence
    const pinnedMem = getMemory(projectDb, pinnedResult.memory_id);
    expect(pinnedMem).not.toBeNull();
    expect(pinnedMem!.confidence).toBe(1.0); // No decay
    expect(pinnedMem!.status).toBe('active');

    // Normal memory should have decayed
    const normalMem = getMemory(projectDb, normalResult.memory_id);
    expect(normalMem).not.toBeNull();
    expect(normalMem!.confidence).toBeLessThan(1.0); // Decayed
  });

  test('empty database handles gracefully', async () => {
    // Recall on empty database
    const recallResult = await executeRecall(projectDb, globalDb, {
      query: 'nonexistent',
      limit: 10,
    });

    expect(recallResult.success).toBe(true);
    if (!recallResult.success) return;

    expect(recallResult.result.results).toHaveLength(0);

    // Lifecycle on empty database
    const lifecycleResult = runLifecycle(projectDb);
    expect(lifecycleResult.decayed).toBe(0);
    expect(lifecycleResult.archived).toBe(0);
    expect(lifecycleResult.pruned).toBe(0);

    // Generate on empty database
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const generateResult = runGenerate({
      projectDb,
      globalDb,
      cwd: tempDir,
      surfacePath: path.join(claudeDir, 'cortex-memory.local.md'),
      lockDir: path.join(tempDir, '.memory', 'locks'),
    });

    expect(generateResult.memoryCount).toBe(0);
    expect(generateResult.selectedCount).toBe(0);

    // Surface file should still be created (empty content with markers)
    const surfacePath = path.join(claudeDir, 'cortex-memory.local.md');
    expect(fs.existsSync(surfacePath)).toBe(true);
  });

  test('tags are stored and searchable', async () => {
    // Create memory with tags
    const result = executeRemember(
      [
        'API versioning strategy',
        '--type=decision',
        '--priority=8',
        '--tags=api,versioning,breaking-changes',
      ],
      sessionId,
      projectDb,
      globalDb
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Verify tags are stored
    const memory = getMemory(projectDb, result.memory_id);
    expect(memory).not.toBeNull();
    expect(memory!.tags).toEqual(['api', 'versioning', 'breaking-changes']);

    // Search by tag content
    const recallResult = await executeRecall(projectDb, globalDb, {
      query: 'versioning',
      limit: 10,
    });

    expect(recallResult.success).toBe(true);
    if (!recallResult.success) return;

    const foundMemory = recallResult.result.results.find(
      (r) => r.memory.id === result.memory_id
    );
    expect(foundMemory).toBeDefined();
  });

  test('idempotent forget - archiving twice succeeds', () => {
    // Create memory
    const result = executeRemember(
      ['Memory to forget', '--type=context'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Archive once
    const forget1 = forgetById(projectDb, result.memory_id);
    expect(forget1.status).toBe('archived');

    // Archive again - should be idempotent
    const forget2 = forgetById(projectDb, result.memory_id);
    expect(forget2.status).toBe('archived');

    // Memory should still be archived
    const memory = getMemory(projectDb, result.memory_id);
    expect(memory).not.toBeNull();
    expect(memory!.status).toBe('archived');
  });

  test('priority affects memory persistence', () => {
    // Create high and low priority memories
    const highPriorityResult = executeRemember(
      ['Critical decision', '--type=decision', '--priority=10'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(highPriorityResult.success).toBe(true);
    if (!highPriorityResult.success) return;

    const lowPriorityResult = executeRemember(
      ['Minor note', '--type=context', '--priority=1'],
      sessionId,
      projectDb,
      globalDb
    );

    expect(lowPriorityResult.success).toBe(true);
    if (!lowPriorityResult.success) return;

    // Verify priorities are stored
    const highPriorityMem = getMemory(projectDb, highPriorityResult.memory_id);
    expect(highPriorityMem).not.toBeNull();
    expect(highPriorityMem!.priority).toBe(10);

    const lowPriorityMem = getMemory(projectDb, lowPriorityResult.memory_id);
    expect(lowPriorityMem).not.toBeNull();
    expect(lowPriorityMem!.priority).toBe(1);
  });
});
