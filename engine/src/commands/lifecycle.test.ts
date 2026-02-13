/**
 * Tests for lifecycle command
 * Uses in-memory SQLite database for isolation
 */


import { openDatabase } from '../infra/db.js';
import { insertMemory, insertEdge, getMemory } from '../infra/db.js';
import { createMemory, createEdge } from '../core/types.js';
import { runLifecycle } from './lifecycle.js';

describe('lifecycle command', () => {
  test('applies decay to active memories', () => {
    const db = openDatabase(':memory:');

    // Create a progress memory (7 day half-life) created 7 days ago
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const memory = createMemory({
      id: 'm1',
      content: 'Task completed',
      summary: 'Progress note',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      created_at: sevenDaysAgo,
      last_accessed_at: sevenDaysAgo,
    });

    insertMemory(db, memory);

    // Run lifecycle
    const result = runLifecycle(db);

    // Should have decayed (half-life = 7 days, age = 7 days -> confidence * 0.5)
    expect(result.decayed).toBeGreaterThan(0);

    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.confidence).toBeCloseTo(0.4, 2); // 0.8 * 0.5
    expect(updated!.status).toBe('active'); // Not yet archived
  });

  test('archives memories with confidence < 0.3 for 14 days', () => {
    const db = openDatabase(':memory:');

    // Create a context memory with low confidence, not accessed for 15 days
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const memory = createMemory({
      id: 'm1',
      content: 'Old context',
      summary: 'Outdated context',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.25, // Already below threshold
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      created_at: fifteenDaysAgo,
      last_accessed_at: fifteenDaysAgo,
    });

    insertMemory(db, memory);

    // Run lifecycle
    const result = runLifecycle(db);

    // Should be archived
    expect(result.archived).toBe(1);

    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('archived');
  });

  test('prunes archived memories untouched for 30 days', () => {
    const db = openDatabase(':memory:');

    // Create an archived memory not accessed for 31 days
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const memory = createMemory({
      id: 'm1',
      content: 'Archived memory',
      summary: 'Old archived',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.2,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      status: 'archived',
      created_at: thirtyOneDaysAgo,
      last_accessed_at: thirtyOneDaysAgo,
    });

    insertMemory(db, memory);

    // Run lifecycle
    const result = runLifecycle(db);

    // Should be pruned
    expect(result.pruned).toBe(1);

    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('pruned');
  });

  test('exempts pinned memories from decay', () => {
    const db = openDatabase(':memory:');

    // Create a pinned progress memory (normally decays fast)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const memory = createMemory({
      id: 'm1',
      content: 'Pinned progress',
      summary: 'Important milestone',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.8,
      priority: 10,
      pinned: true,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      created_at: thirtyDaysAgo,
      last_accessed_at: thirtyDaysAgo,
    });

    insertMemory(db, memory);

    // Run lifecycle
    runLifecycle(db);

    // Should not decay
    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.confidence).toBe(0.8); // Unchanged
    expect(updated!.status).toBe('active');
  });

  test('exempts high centrality memories from archiving', () => {
    const db = openDatabase(':memory:');

    // Create a memory with low confidence but high centrality
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const hubMemory = createMemory({
      id: 'hub',
      content: 'Hub memory',
      summary: 'Central concept',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.25, // Low confidence
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      created_at: twentyDaysAgo,
      last_accessed_at: twentyDaysAgo,
    });

    // Create several other memories that link to this hub
    const relatedMemories = Array.from({ length: 5 }, (_, i) =>
      createMemory({
        id: `m${i}`,
        content: `Related ${i}`,
        summary: `Relates to hub`,
        memory_type: 'context',
        scope: 'project',
        confidence: 0.8,
        priority: 5,
        source_type: 'extraction',
        source_session: 's1',
        source_context: '{}',
      })
    );

    insertMemory(db, hubMemory);
    for (const mem of relatedMemories) {
      insertMemory(db, mem);
      // Create edge to hub (hub has high in-degree)
      insertEdge(db, {
        source_id: mem.id,
        target_id: 'hub',
        relation_type: 'relates_to',
        strength: 0.8,
        status: 'active',
      });
    }

    // Run lifecycle
    const result = runLifecycle(db);

    // Hub should be exempt from archiving due to high centrality
    const updated = getMemory(db, 'hub');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('active'); // Not archived
    expect(result.archived).toBe(0);
  });

  test('stable memory types do not decay', () => {
    const db = openDatabase(':memory:');

    // Create architecture memory (stable type) created 100 days ago
    const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const memory = createMemory({
      id: 'm1',
      content: 'System architecture',
      summary: 'Core design',
      memory_type: 'architecture',
      scope: 'project',
      confidence: 0.9,
      priority: 10,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      created_at: hundredDaysAgo,
      last_accessed_at: hundredDaysAgo,
    });

    insertMemory(db, memory);

    // Run lifecycle
    runLifecycle(db);

    // Should not decay (stable type)
    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.confidence).toBe(0.9); // Unchanged
  });

  test('high access count doubles half-life', () => {
    const db = openDatabase(':memory:');

    // Create two identical memories, one with high access count
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const lowAccess = createMemory({
      id: 'm1',
      content: 'Low access',
      summary: 'Rarely used',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      access_count: 5,
      created_at: sevenDaysAgo,
      last_accessed_at: sevenDaysAgo,
    });

    const highAccess = createMemory({
      id: 'm2',
      content: 'High access',
      summary: 'Frequently used',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      access_count: 15, // > 10, doubles half-life
      created_at: sevenDaysAgo,
      last_accessed_at: sevenDaysAgo,
    });

    insertMemory(db, lowAccess);
    insertMemory(db, highAccess);

    // Run lifecycle
    runLifecycle(db);

    const updatedLow = getMemory(db, 'm1');
    const updatedHigh = getMemory(db, 'm2');

    // Low access: 7d age, 7d half-life -> 0.5 decay factor
    expect(updatedLow!.confidence).toBeCloseTo(0.4, 2); // 0.8 * 0.5

    // High access: 7d age, 14d half-life -> 0.7071 decay factor
    expect(updatedHigh!.confidence).toBeCloseTo(0.566, 2); // 0.8 * 0.7071
    expect(updatedHigh!.confidence).toBeGreaterThan(updatedLow!.confidence);
  });

  test('returns zero counts for empty database', () => {
    const db = openDatabase(':memory:');

    const result = runLifecycle(db);

    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.pruned).toBe(0);
  });

  test('handles mix of statuses correctly', () => {
    const db = openDatabase(':memory:');

    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();

    // Active memory that will decay but stay active (recent enough)
    insertMemory(db, createMemory({
      id: 'm1',
      content: 'Active',
      summary: 'Active memory',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      created_at: threeDaysAgo,
      last_accessed_at: threeDaysAgo,
    }));

    // Active memory that will archive
    insertMemory(db, createMemory({
      id: 'm2',
      content: 'Will archive',
      summary: 'Low confidence old',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.25,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      created_at: fifteenDaysAgo,
      last_accessed_at: fifteenDaysAgo,
    }));

    // Archived memory that will prune
    insertMemory(db, createMemory({
      id: 'm3',
      content: 'Will prune',
      summary: 'Old archived',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.2,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      status: 'archived',
      created_at: thirtyOneDaysAgo,
      last_accessed_at: thirtyOneDaysAgo,
    }));

    // Superseded memory (should be ignored)
    insertMemory(db, createMemory({
      id: 'm4',
      content: 'Superseded',
      summary: 'Already superseded',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      status: 'superseded',
      created_at: fifteenDaysAgo,
      last_accessed_at: fifteenDaysAgo,
    }));

    const result = runLifecycle(db);

    expect(result.decayed).toBeGreaterThan(0); // m1 decayed
    expect(result.archived).toBe(1); // m2 archived
    expect(result.pruned).toBe(1); // m3 pruned

    // Verify states
    expect(getMemory(db, 'm1')!.status).toBe('active');
    expect(getMemory(db, 'm2')!.status).toBe('archived');
    expect(getMemory(db, 'm3')!.status).toBe('pruned');
    expect(getMemory(db, 'm4')!.status).toBe('superseded'); // Unchanged
  });

  test('very old memory gets archived then pruned in same run', () => {
    const db = openDatabase(':memory:');

    // Create a very old progress memory (100 days) that will:
    // 1. Decay to ~0
    // 2. Get archived (confidence < 0.3 and unaccessed 14d+)
    // 3. Get pruned in same run (archived and unaccessed 30d+)
    const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const memory = createMemory({
      id: 'm1',
      content: 'Ancient progress',
      summary: 'Very old',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.1,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      created_at: hundredDaysAgo,
      last_accessed_at: hundredDaysAgo,
    });

    insertMemory(db, memory);

    const result = runLifecycle(db);

    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    // Should end up pruned (archived then pruned in same run)
    expect(updated!.status).toBe('pruned');
    expect(result.archived).toBe(1);
    expect(result.pruned).toBe(1);
  });

  test('does not process pruned or superseded memories', () => {
    const db = openDatabase(':memory:');

    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

    // Pruned memory should stay pruned
    insertMemory(db, createMemory({
      id: 'm1',
      content: 'Pruned',
      summary: 'Already pruned',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      status: 'pruned',
      created_at: fifteenDaysAgo,
      last_accessed_at: fifteenDaysAgo,
    }));

    // Superseded memory should stay superseded
    insertMemory(db, createMemory({
      id: 'm2',
      content: 'Superseded',
      summary: 'Already superseded',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      status: 'superseded',
      created_at: fifteenDaysAgo,
      last_accessed_at: fifteenDaysAgo,
    }));

    runLifecycle(db);

    // Status should be unchanged
    expect(getMemory(db, 'm1')!.status).toBe('pruned');
    expect(getMemory(db, 'm2')!.status).toBe('superseded');
  });

  test('archived memory not yet 30 days stays archived', () => {
    const db = openDatabase(':memory:');

    // Archived 20 days ago (not yet 30)
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const memory = createMemory({
      id: 'm1',
      content: 'Recently archived',
      summary: 'Archived but not old enough',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.2,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      status: 'archived',
      created_at: twentyDaysAgo,
      last_accessed_at: twentyDaysAgo,
    });

    insertMemory(db, memory);

    const result = runLifecycle(db);

    // Should not be pruned yet
    expect(result.pruned).toBe(0);
    expect(getMemory(db, 'm1')!.status).toBe('archived');
  });
});
