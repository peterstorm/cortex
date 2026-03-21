/**
 * Tests for lifecycle command
 * Uses in-memory SQLite database for isolation
 *
 * Key behavior: lifecycle computes effective confidence for decisions but
 * does NOT write decayed confidence to DB. Stored confidence stays at
 * original value — decay is recomputed on-the-fly from last_accessed_at.
 */


import { openDatabase } from '../infra/db.js';
import { insertMemory, insertEdge, getMemory } from '../infra/db.js';
import { createMemory, createEdge } from '../core/types.js';
import { runLifecycle } from './lifecycle.js';

describe('lifecycle command', () => {
  test('detects decay but does not write decayed confidence to DB', () => {
    const db = openDatabase(':memory:');

    // Create a progress memory (7 day half-life) last accessed 7 days ago
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

    const result = runLifecycle(db);

    // Should detect decay
    expect(result.decayed).toBeGreaterThan(0);

    // But stored confidence stays at original value
    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.confidence).toBe(0.8); // Unchanged in DB
    expect(updated!.status).toBe('active');
  });

  test('archives memories with low effective confidence for 14+ days', () => {
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

    const result = runLifecycle(db);

    // Should be archived
    expect(result.archived).toBe(1);

    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('archived');
    // Confidence stays at original (not overwritten with decayed value)
    expect(updated!.confidence).toBe(0.25);
  });

  test('prunes archived memories untouched for 30 days', () => {
    const db = openDatabase(':memory:');

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

    const result = runLifecycle(db);

    expect(result.pruned).toBe(1);

    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('pruned');
  });

  test('exempts pinned memories from decay', () => {
    const db = openDatabase(':memory:');

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

    runLifecycle(db);

    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.confidence).toBe(0.8); // Unchanged
    expect(updated!.status).toBe('active');
  });

  test('exempts high centrality memories from archiving', () => {
    const db = openDatabase(':memory:');

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
      insertEdge(db, {
        source_id: mem.id,
        target_id: 'hub',
        relation_type: 'relates_to',
        strength: 0.8,
        status: 'active',
      });
    }

    const result = runLifecycle(db);

    // Hub should be exempt from archiving due to high centrality
    const updated = getMemory(db, 'hub');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('active');
    expect(result.archived).toBe(0);
  });

  test('stable memory types do not decay', () => {
    const db = openDatabase(':memory:');

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

    runLifecycle(db);

    const updated = getMemory(db, 'm1');
    expect(updated).not.toBeNull();
    expect(updated!.confidence).toBe(0.9); // Unchanged
  });

  test('higher access count slows effective decay', () => {
    const db = openDatabase(':memory:');

    // Both memories last accessed 14 days ago
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    // Low access — decays faster, will archive
    // halfLife = 7, effective = 0.6 * 0.5^(14/7) = 0.6 * 0.25 = 0.15 → archives
    const lowAccess = createMemory({
      id: 'm1',
      content: 'Low access',
      summary: 'Rarely used',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.6,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      access_count: 0,
      created_at: fourteenDaysAgo,
      last_accessed_at: fourteenDaysAgo,
    });

    // High access — decays slower, should NOT archive
    // halfLife = 7 * (1 + log2(16)*0.3) = 7 * 2.2 = 15.4
    // effective = 0.6 * 0.5^(14/15.4) = 0.6 * 0.533 = 0.32 → stays active
    const highAccess = createMemory({
      id: 'm2',
      content: 'High access',
      summary: 'Frequently used',
      memory_type: 'progress',
      scope: 'project',
      confidence: 0.6,
      priority: 5,
      source_type: 'extraction',
      source_session: 's1',
      source_context: '{}',
      access_count: 15,
      created_at: fourteenDaysAgo,
      last_accessed_at: fourteenDaysAgo,
    });

    insertMemory(db, lowAccess);
    insertMemory(db, highAccess);

    const result = runLifecycle(db);

    // Low access memory should archive (effective conf drops below 0.3)
    expect(getMemory(db, 'm1')!.status).toBe('archived');

    // High access memory should survive (longer effective half-life keeps conf above 0.3)
    expect(getMemory(db, 'm2')!.status).toBe('active');
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

    // Active memory that will decay but stay active
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

    // Active memory that will archive (low confidence + old access)
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
    expect(getMemory(db, 'm4')!.status).toBe('superseded');
  });

  test('very old memory gets archived then pruned in same run', () => {
    const db = openDatabase(':memory:');

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
    expect(updated!.status).toBe('pruned');
    expect(result.archived).toBe(1);
    expect(result.pruned).toBe(1);
  });

  test('does not process pruned or superseded memories', () => {
    const db = openDatabase(':memory:');

    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

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

    expect(getMemory(db, 'm1')!.status).toBe('pruned');
    expect(getMemory(db, 'm2')!.status).toBe('superseded');
  });

  test('archived memory not yet 30 days stays archived', () => {
    const db = openDatabase(':memory:');

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

    expect(result.pruned).toBe(0);
    expect(getMemory(db, 'm1')!.status).toBe('archived');
  });
});
