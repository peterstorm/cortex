/**
 * Tests for extract command
 * Simplified tests for bun test runner
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { HookInput, MemoryCandidate, Memory } from '../core/types.js';
import { createMemory } from '../core/types.js';
import {
  openDatabase,
  insertMemory,
  getMemory,
  getActiveMemories,
  getExtractionCheckpoint,
  saveExtractionCheckpoint,
} from '../infra/db.js';
import { truncateTranscript, buildExtractionPrompt, parseExtractionResponse } from '../core/extraction.js';
import { tokenize, jaccardSimilarity, classifySimilarity } from '../core/similarity.js';
import { deduplicateCandidates, applyDedupMerges, executeExtract, computeEdgeCandidates } from './extract.js';

// Mock the LLM boundary so executeExtract tests never shell out to `claude`,
// and the local embedding model so no ONNX weights are loaded.
const mockExtractMemories = vi.fn();
vi.mock('../infra/claude-llm.js', () => ({
  isClaudeLlmAvailable: () => true,
  extractMemories: (prompt: string) => mockExtractMemories(prompt),
}));
vi.mock('../infra/local-embed.ts', () => ({
  ensureModelLoaded: async () => false,
  embedLocal: async () => {
    throw new Error('local embedding model disabled in tests');
  },
}));

describe('extract command - core logic', () => {
  let db: Database;
  let input: HookInput;

  beforeEach(() => {
    // Setup in-memory database
    db = openDatabase(':memory:');

    // Setup test input
    input = {
      session_id: 'test-session-123',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/home/user/project',
    };
  });

  describe('transcript truncation', () => {
    it('truncates transcript larger than maxBytes', () => {
      const longTranscript = 'a'.repeat(150_000);
      const result = truncateTranscript(longTranscript, 100_000, 0);

      expect(result.newCursor).toBeLessThan(longTranscript.length);
      expect(result.truncated.length).toBeLessThanOrEqual(100_000);
    });

    it('returns full transcript if within maxBytes', () => {
      const shortTranscript = 'short';
      const result = truncateTranscript(shortTranscript, 100_000, 0);

      expect(result.truncated).toBe(shortTranscript);
      expect(result.newCursor).toBe(shortTranscript.length);
    });

    it('resumes from cursor position', () => {
      const transcript = 'line1\nline2\nline3\n';
      const result = truncateTranscript(transcript, 100_000, 6);

      expect(result.truncated).toBe('line2\nline3\n');
      expect(result.newCursor).toBe(transcript.length);
    });
  });

  describe('extraction prompt building', () => {
    it('includes git context in prompt', () => {
      const transcript = 'test transcript';
      const gitContext = {
        branch: 'feature/test',
        recent_commits: ['commit1', 'commit2'],
        changed_files: ['file1.ts', 'file2.ts'],
      };

      const prompt = buildExtractionPrompt(transcript, gitContext, 'test-project');

      expect(prompt).toContain('feature/test');
      expect(prompt).toContain('commit1');
      expect(prompt).toContain('file1.ts');
      expect(prompt).toContain('test transcript');
    });

    it('includes memory type instructions', () => {
      const transcript = 'test';
      const gitContext = {
        branch: 'main',
        recent_commits: [],
        changed_files: [],
      };

      const prompt = buildExtractionPrompt(transcript, gitContext, 'proj');

      expect(prompt).toContain('architecture');
      expect(prompt).toContain('decision');
      expect(prompt).toContain('pattern');
      expect(prompt).toContain('gotcha');
    });
  });

  describe('extraction response parsing', () => {
    it('parses valid JSON response', () => {
      const response = JSON.stringify([
        {
          content: 'Test content',
          summary: 'Test summary',
          memory_type: 'decision',
          scope: 'project',
          confidence: 0.9,
          priority: 8,
          tags: ['test'],
        },
      ]);

      const result = parseExtractionResponse(response);

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('expected ok');
      expect(result.memories.length).toBe(1);
      expect(result.memories[0].content).toBe('Test content');
      expect(result.memories[0].memory_type).toBe('decision');
    });

    it('handles markdown code blocks', () => {
      const response = '```json\n[{"content":"test","summary":"test","memory_type":"context","scope":"project","confidence":0.5,"priority":5,"tags":[]}]\n```';

      const result = parseExtractionResponse(response);

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('expected ok');
      expect(result.memories.length).toBe(1);
    });

    it('returns parse_error for invalid JSON', () => {
      const response = 'not json';

      const result = parseExtractionResponse(response);

      expect(result.kind).toBe('parse_error');
    });

    it('filters invalid candidates', () => {
      const response = JSON.stringify([
        {
          content: 'Valid',
          summary: 'Valid',
          memory_type: 'decision',
          scope: 'project',
          confidence: 0.9,
          priority: 8,
          tags: [],
        },
        {
          content: 'Invalid',
          summary: 'Invalid',
          memory_type: 'invalid_type',
          scope: 'project',
          confidence: 0.9,
          priority: 8,
          tags: [],
        },
        {
          content: 'Invalid2',
          summary: 'Invalid2',
          memory_type: 'decision',
          scope: 'project',
          confidence: 2.0, // Out of range
          priority: 8,
          tags: [],
        },
      ]);

      const result = parseExtractionResponse(response);

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('expected ok');
      expect(result.memories.length).toBe(1);
      expect(result.memories[0].content).toBe('Valid');
    });
  });

  describe('similarity computation', () => {
    it('computes Jaccard similarity correctly', () => {
      const text1 = 'Pattern X involves modular architecture';
      const text2 = 'Modular architecture enables testability';

      const tokens1 = tokenize(text1);
      const tokens2 = tokenize(text2);

      const similarity = jaccardSimilarity(tokens1, tokens2);

      expect(similarity).toBeGreaterThan(0.1); // Some overlap
      expect(similarity).toBeLessThan(1.0);    // Not identical
    });

    it('returns 0 for completely different texts', () => {
      const text1 = 'Python data processing';
      const text2 = 'CSS flexbox layout';

      const tokens1 = tokenize(text1);
      const tokens2 = tokenize(text2);

      const similarity = jaccardSimilarity(tokens1, tokens2);

      expect(similarity).toBe(0);
    });

    it('classifies similarity into actions', () => {
      const ignore = classifySimilarity(0.05);
      expect(ignore.action).toBe('ignore');

      const relate = classifySimilarity(0.25);
      expect(relate.action).toBe('relate');

      const suggest = classifySimilarity(0.45);
      expect(suggest.action).toBe('suggest');

      const consolidate = classifySimilarity(0.6);
      expect(consolidate.action).toBe('consolidate');
    });
  });

  describe('database operations', () => {
    it('saves and retrieves extraction checkpoint', () => {
      const { saveExtractionCheckpoint, getExtractionCheckpoint } = require('../infra/db.js');

      saveExtractionCheckpoint(db, {
        session_id: 'test-session',
        cursor_position: 1234,
        extracted_at: new Date().toISOString(),
      });

      const checkpoint = getExtractionCheckpoint(db, 'test-session');

      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.session_id).toBe('test-session');
      expect(checkpoint!.cursor_position).toBe(1234);
    });

    it('updates existing checkpoint', () => {
      const { saveExtractionCheckpoint, getExtractionCheckpoint } = require('../infra/db.js');

      // First save
      saveExtractionCheckpoint(db, {
        session_id: 'test-session',
        cursor_position: 100,
        extracted_at: new Date().toISOString(),
      });

      // Update
      saveExtractionCheckpoint(db, {
        session_id: 'test-session',
        cursor_position: 200,
        extracted_at: new Date().toISOString(),
      });

      const checkpoint = getExtractionCheckpoint(db, 'test-session');

      expect(checkpoint!.cursor_position).toBe(200);
    });
  });
});

describe('deduplicateCandidates', () => {
  const now = new Date().toISOString();

  function makeMemory(overrides: Partial<Memory>): Memory {
    return createMemory({
      id: 'test-id',
      content: 'default content',
      summary: 'default content',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.9,
      priority: 5,
      pinned: false,
      source_type: 'extraction',
      source_session: 'sess',
      source_context: '{}',
      tags: [],
      embedding: null,
      local_embedding: null,
      access_count: 0,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
      status: 'active',
      ...overrides,
    });
  }

  function makeCandidate(overrides: Partial<MemoryCandidate>): MemoryCandidate {
    return {
      content: 'default content',
      summary: 'default content',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      tags: [],
      ...overrides,
    };
  }

  it('filters candidates matching existing memories by Jaccard', () => {
    const existing = [makeMemory({
      summary: 'Use functional core imperative shell pattern for commands',
      content: 'Use functional core imperative shell pattern to separate pure logic from IO in all commands',
    })];
    const candidates = [makeCandidate({
      summary: 'Functional core imperative shell pattern for commands',
      content: 'Apply functional core imperative shell pattern to separate pure logic from IO in all services',
    })];

    // High Jaccard overlap (~0.82) + no embeddings → merge (between threshold and ceiling)
    const { kept, merges } = deduplicateCandidates(candidates, existing, 0.75, new Map(), 0.90);
    expect(merges).toHaveLength(1);
    expect(kept).toHaveLength(0);
  });

  it('keeps candidates that differ from existing memories', () => {
    const existing = [makeMemory({
      summary: 'Database uses PostgreSQL',
      content: 'Database uses PostgreSQL for persistence',
    })];
    const candidates = [makeCandidate({
      summary: 'Frontend uses React hooks',
      content: 'Frontend uses React hooks for state management',
    })];

    const { kept, skipped } = deduplicateCandidates(candidates, existing, 0.45);
    expect(skipped).toBe(0);
    expect(kept).toHaveLength(1);
  });

  it('catches semantic duplicates via cosine when Jaccard is in maybe range', () => {
    // Create an embedding vector — same for both to simulate semantic similarity
    const sharedEmbedding = new Float32Array(384);
    for (let i = 0; i < 384; i++) sharedEmbedding[i] = Math.sin(i * 0.1);

    // Texts with partial word overlap — enough for "maybe" range (Jaccard 0.1-0.6)
    // but not enough for Jaccard alone to exceed 0.45
    const existing = [makeMemory({
      summary: 'Prefer immutable data structures in TypeScript code',
      content: 'Prefer immutable data structures in TypeScript code for safety',
      local_embedding: sharedEmbedding,
    })];

    const candidates = [makeCandidate({
      summary: 'Use readonly data types in TypeScript modules',
      content: 'Use readonly data types in TypeScript modules for correctness',
    })];

    // Candidate embedding is identical to existing → cosine = 1.0
    const candidateEmbeddings = new Map<number, Float32Array>();
    candidateEmbeddings.set(0, sharedEmbedding);

    const { kept, skipped } = deduplicateCandidates(
      candidates, existing, 0.45, candidateEmbeddings
    );
    // Cosine of identical embeddings = 1.0, well above 0.45
    expect(skipped).toBe(1);
  });

  it('performs intra-batch dedup', () => {
    const candidates = [
      makeCandidate({
        summary: 'Use TypeScript strict mode always',
        content: 'Enable TypeScript strict mode in tsconfig',
      }),
      makeCandidate({
        summary: 'Use TypeScript strict mode always',
        content: 'Enable TypeScript strict mode in tsconfig for safety',
      }),
    ];

    const { kept, skipped } = deduplicateCandidates(candidates, [], 0.45);
    expect(skipped).toBe(1);
    expect(kept).toHaveLength(1);
  });

  it('gracefully handles empty candidateEmbeddings map', () => {
    const candidates = [makeCandidate({
      summary: 'Test content here',
      content: 'Test content here for dedup',
    })];

    const { kept, skipped } = deduplicateCandidates(candidates, [], 0.45);
    expect(kept).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  describe('intra-batch dedup runs regardless of existing-memory match (finding: dedup gap)', () => {
    // 384-dim vector with all mass in the first two dims — lets us dial
    // exact cosine similarities between candidates and existing memories.
    function vecAtAngle(theta: number): Float32Array {
      const v = new Float32Array(384);
      v[0] = Math.cos(theta);
      v[1] = Math.sin(theta);
      return v;
    }

    it('skips a candidate that duplicates a kept candidate even when it also matches an existing memory', () => {
      // Existing X at angle 0.
      // Candidate A at 60°: cos vs X = 0.5 < threshold → kept as new.
      // Candidate B at acos(0.8): cos vs X = 0.8 → merge range [0.75, 0.85);
      //   cos vs A ≈ 0.92 ≥ intra-batch threshold → must be SKIPPED, not
      //   merged into X (near-identical content must not land twice).
      const existing = [makeMemory({
        id: 'existing-x',
        summary: 'existing memory about topic',
        content: 'existing memory about topic',
        local_embedding: vecAtAngle(0),
      })];

      const candidates = [
        makeCandidate({ summary: 'first kept candidate', content: 'first kept candidate' }),
        makeCandidate({ summary: 'second near duplicate', content: 'second near duplicate' }),
      ];
      const embeddings = new Map<number, Float32Array>();
      embeddings.set(0, vecAtAngle(Math.acos(0.5)));
      embeddings.set(1, vecAtAngle(Math.acos(0.8)));

      const { kept, skipped, merges } = deduplicateCandidates(
        candidates, existing, 0.75, embeddings, 0.85, 0.75
      );

      expect(kept).toHaveLength(1);
      expect(kept[0]).toBe(candidates[0]);
      expect(merges).toHaveLength(0); // B must NOT merge into X
      expect(skipped).toBe(1);        // B skipped as intra-batch duplicate
    });

    it('still merges into an existing memory when no kept candidate duplicates it', () => {
      const existing = [makeMemory({
        id: 'existing-x',
        summary: 'existing memory about topic',
        content: 'existing memory about topic',
        local_embedding: vecAtAngle(0),
      })];

      const candidates = [
        makeCandidate({ summary: 'merge range candidate', content: 'merge range candidate' }),
      ];
      const embeddings = new Map<number, Float32Array>();
      embeddings.set(0, vecAtAngle(Math.acos(0.8)));

      const { kept, skipped, merges } = deduplicateCandidates(
        candidates, existing, 0.75, embeddings, 0.85, 0.75
      );

      expect(kept).toHaveLength(0);
      expect(skipped).toBe(0);
      expect(merges).toHaveLength(1);
      expect(merges[0].existingMemoryId).toBe('existing-x');
    });
  });
});

// ============================================================================
// applyDedupMerges — dead merge targets (finding: merge target may be dead)
// ============================================================================

describe('applyDedupMerges', () => {
  const gitContext = { branch: 'main', recent_commits: [], changed_files: [] };
  const now = new Date().toISOString();

  function makeMemory(overrides: Partial<Memory>): Memory {
    return createMemory({
      id: 'target-id',
      content: 'target content',
      summary: 'target summary',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.9,
      priority: 5,
      source_type: 'extraction',
      source_session: 'sess',
      source_context: '{}',
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      ...overrides,
    });
  }

  const candidate: MemoryCandidate = {
    content: 'candidate content',
    summary: 'candidate summary',
    memory_type: 'context',
    scope: 'project',
    confidence: 0.8,
    priority: 5,
    tags: [],
  };

  it('appends to an active merge target', () => {
    const db = openDatabase(':memory:');
    insertMemory(db, makeMemory({ id: 'active-target' }));

    const result = applyDedupMerges(
      db,
      [{ candidate, existingMemoryId: 'active-target' }],
      () => null,
      'sess',
      gitContext
    );

    expect(result.merged).toBe(1);
    expect(result.fallbackInserted).toHaveLength(0);
    expect(getMemory(db, 'active-target')!.content).toContain('candidate content');
    db.close();
  });

  it('inserts the candidate as a NEW memory when the target was archived concurrently', () => {
    const db = openDatabase(':memory:');
    insertMemory(db, makeMemory({ id: 'dead-target', status: 'archived' }));

    const result = applyDedupMerges(
      db,
      [{ candidate, existingMemoryId: 'dead-target' }],
      () => null,
      'sess',
      gitContext
    );

    expect(result.merged).toBe(0);
    expect(result.fallbackInserted).toHaveLength(1);
    // Target untouched, candidate landed as its own active memory
    expect(getMemory(db, 'dead-target')!.content).toBe('target content');
    const active = getActiveMemories(db);
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe('candidate content');
    db.close();
  });

  it('inserts the candidate as a NEW memory when the target is missing entirely', () => {
    const db = openDatabase(':memory:');

    const result = applyDedupMerges(
      db,
      [{ candidate, existingMemoryId: 'no-such-id' }],
      () => null,
      'sess',
      gitContext
    );

    expect(result.merged).toBe(0);
    expect(result.fallbackInserted).toHaveLength(1);
    expect(getActiveMemories(db)).toHaveLength(1);
    db.close();
  });
});

// ============================================================================
// executeExtract — checkpoint semantics, chunk loop, concurrency lock
// ============================================================================

describe('executeExtract (mocked LLM)', () => {
  const tempDirs: string[] = [];

  function makeTestProject(transcript: string): { cwd: string; transcriptPath: string } {
    const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cortex-extract-test-'));
    tempDirs.push(cwd);
    const transcriptPath = nodePath.join(cwd, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcript);
    return { cwd, transcriptPath };
  }

  function memoriesResponse(...contents: string[]): string {
    return JSON.stringify({
      memories: contents.map((content) => ({
        content,
        summary: content,
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        tags: [],
      })),
      entities: [],
    });
  }

  beforeEach(() => {
    mockExtractMemories.mockReset();
  });

  afterAll(() => {
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('skips gracefully when another extraction holds the lock', async () => {
    const { cwd, transcriptPath } = makeTestProject('{"role":"user","content":"hello"}\n');
    const lockDir = nodePath.join(cwd, '.memory', 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    // Live PID → lock is held
    fs.writeFileSync(nodePath.join(lockDir, 'extract.lock'), String(process.pid));

    const db = openDatabase(':memory:');
    const result = await executeExtract(
      { session_id: 's-lock', transcript_path: transcriptPath, cwd }, db
    );

    expect(result.skipped).toBe(true);
    expect(result.success).toBe(true);
    expect(result.error).toContain('another extraction running');
    expect(mockExtractMemories).not.toHaveBeenCalled();
    db.close();
  });

  it('does NOT advance the checkpoint on LLM parse failure', async () => {
    const transcript = '{"role":"user","content":"we decided to use sqlite"}\n';
    const { cwd, transcriptPath } = makeTestProject(transcript);
    const db = openDatabase(':memory:');

    mockExtractMemories.mockResolvedValue('this is definitely { not valid json');

    const result = await executeExtract(
      { session_id: 's-parse', transcript_path: transcriptPath, cwd }, db
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('parse');
    expect(result.cursor_position).toBe(0);
    // Transcript must NOT be consumed — no checkpoint saved
    expect(getExtractionCheckpoint(db, 's-parse')).toBeNull();

    // Retry with a genuinely-empty response now succeeds from cursor 0
    mockExtractMemories.mockResolvedValue('{"memories": [], "entities": []}');
    const retry = await executeExtract(
      { session_id: 's-parse', transcript_path: transcriptPath, cwd }, db
    );
    expect(retry.success).toBe(true);
    expect(retry.cursor_position).toBe(transcript.length);
    expect(getExtractionCheckpoint(db, 's-parse')!.cursor_position).toBe(transcript.length);
    db.close();
  });

  it('advances the checkpoint on a genuinely-empty extraction', async () => {
    const transcript = '{"role":"user","content":"nothing memorable"}\n';
    const { cwd, transcriptPath } = makeTestProject(transcript);
    const db = openDatabase(':memory:');

    mockExtractMemories.mockResolvedValue('{"memories": [], "entities": []}');

    const result = await executeExtract(
      { session_id: 's-empty', transcript_path: transcriptPath, cwd }, db
    );

    expect(result.success).toBe(true);
    expect(result.extracted_count).toBe(0);
    expect(result.cursor_position).toBe(transcript.length);
    const checkpoint = getExtractionCheckpoint(db, 's-empty');
    expect(checkpoint!.cursor_position).toBe(transcript.length);
    expect(checkpoint!.transcript_length).toBe(transcript.length);
    db.close();
  });

  it('resets the cursor when the transcript shrank below the stored cursor', async () => {
    const transcript = '{"role":"user","content":"rewritten short transcript"}\n';
    const { cwd, transcriptPath } = makeTestProject(transcript);
    const db = openDatabase(':memory:');

    // Stale checkpoint from before the transcript was rewritten shorter
    saveExtractionCheckpoint(db, {
      session_id: 's-shrink',
      cursor_position: 5000,
      extracted_at: new Date().toISOString(),
      transcript_length: 5000,
    });

    mockExtractMemories.mockResolvedValue(memoriesResponse('alpha decision about sqlite storage'));

    const result = await executeExtract(
      { session_id: 's-shrink', transcript_path: transcriptPath, cwd }, db
    );

    expect(result.success).toBe(true);
    // Extraction re-ran from 0 over the full (new) content
    expect(mockExtractMemories).toHaveBeenCalledTimes(1);
    expect(mockExtractMemories.mock.calls[0][0]).toContain('rewritten short transcript');
    expect(result.extracted_count).toBe(1);
    expect(result.cursor_position).toBe(transcript.length);
    expect(getExtractionCheckpoint(db, 's-shrink')!.cursor_position).toBe(transcript.length);
    db.close();
  });

  it('resets the cursor when the stored transcript length exceeds the current length', async () => {
    const transcript = '{"role":"user","content":"compacted transcript"}\n';
    const { cwd, transcriptPath } = makeTestProject(transcript);
    const db = openDatabase(':memory:');

    // Cursor is still within bounds, but the stored length reveals a rewrite
    saveExtractionCheckpoint(db, {
      session_id: 's-shrink2',
      cursor_position: 10,
      extracted_at: new Date().toISOString(),
      transcript_length: 9999,
    });

    mockExtractMemories.mockResolvedValue('{"memories": [], "entities": []}');

    const result = await executeExtract(
      { session_id: 's-shrink2', transcript_path: transcriptPath, cwd }, db
    );

    expect(result.success).toBe(true);
    // Re-extracted from 0: prompt contains the very start of the transcript
    expect(mockExtractMemories.mock.calls[0][0]).toContain('compacted transcript');
    expect(getExtractionCheckpoint(db, 's-shrink2')!.cursor_position).toBe(transcript.length);
    db.close();
  });

  it('drains a 250KB transcript fully in one run via the chunk loop', async () => {
    // ~250KB of JSONL — 3 chunks at the 100KB cap
    const line = JSON.stringify({ role: 'user', content: 'x'.repeat(90) }) + '\n';
    const transcript = line.repeat(Math.ceil(250_000 / line.length));
    const { cwd, transcriptPath } = makeTestProject(transcript);
    const db = openDatabase(':memory:');

    mockExtractMemories
      .mockResolvedValueOnce(memoriesResponse('alpha bravo first unique insight'))
      .mockResolvedValueOnce(memoriesResponse('charlie delta second distinct learning'))
      .mockResolvedValueOnce(memoriesResponse('echo foxtrot third separate observation'));

    const result = await executeExtract(
      { session_id: 's-chunks', transcript_path: transcriptPath, cwd }, db
    );

    expect(result.success).toBe(true);
    expect(mockExtractMemories).toHaveBeenCalledTimes(3);
    expect(result.cursor_position).toBe(transcript.length);
    expect(result.extracted_count).toBe(3);
    expect(getExtractionCheckpoint(db, 's-chunks')!.cursor_position).toBe(transcript.length);
    expect(getActiveMemories(db)).toHaveLength(3);
    db.close();
  });

  it('stops the chunk loop at a failed chunk without advancing past it', async () => {
    const line = JSON.stringify({ role: 'user', content: 'y'.repeat(90) }) + '\n';
    const transcript = line.repeat(Math.ceil(250_000 / line.length));
    const { cwd, transcriptPath } = makeTestProject(transcript);
    const db = openDatabase(':memory:');

    mockExtractMemories
      .mockResolvedValueOnce(memoriesResponse('alpha bravo first unique insight'))
      .mockRejectedValueOnce(new Error('LLM timeout'));

    const result = await executeExtract(
      { session_id: 's-chunk-fail', transcript_path: transcriptPath, cwd }, db
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Claude extraction failed');
    // First chunk's progress persisted; cursor parked at the failed chunk
    expect(result.extracted_count).toBe(1);
    expect(result.cursor_position).toBeGreaterThan(0);
    expect(result.cursor_position).toBeLessThan(transcript.length);
    expect(getExtractionCheckpoint(db, 's-chunk-fail')!.cursor_position).toBe(result.cursor_position);
    db.close();
  });
});


// ============================================================================
// computeEdgeCandidates — space-aware classification + per-memory edge cap
// ============================================================================

describe('computeEdgeCandidates', () => {
  const now = new Date().toISOString();

  function makeEdgeMemory(id: string, overrides: Partial<Memory> = {}): Memory {
    return createMemory({
      id,
      content: 'default content',
      summary: 'default content',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.9,
      priority: 5,
      pinned: false,
      source_type: 'extraction',
      source_session: 'sess',
      source_context: '{}',
      tags: [],
      embedding: null,
      local_embedding: null,
      access_count: 0,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
      status: 'active',
      ...overrides,
    });
  }

  /** Float32 vector with cosine exactly `c` against [1, 0] */
  const localVecAt = (c: number): Float32Array =>
    new Float32Array([c, Math.sqrt(1 - c * c)]);

  // Orthogonal vocabulary so Jaccard is ~0 and cosine drives everything
  const newMemText = { summary: 'alpha bravo', content: 'alpha bravo charlie delta' };
  const existingText = (i: number) => ({
    summary: `word${i}a word${i}b`,
    content: `word${i}a word${i}b word${i}c word${i}d`,
  });

  it('BGE-realistic same-domain distribution (0.6-0.72) produces few, capped edges (regression)', () => {
    // Raw local-BGE cosine puts nearly every same-project pair at 0.6-0.75.
    // Under the old Jaccard bands ALL of these were consolidate → O(n²)
    // active edges. With calibrated bands they are 'relate' at most, and the
    // structural cap keeps only the strongest 3.
    const newMem = makeEdgeMemory('new', { ...newMemText, local_embedding: localVecAt(1) });
    const cosines = [0.60, 0.62, 0.64, 0.65, 0.66, 0.68, 0.69, 0.70, 0.71, 0.72];
    const existing = cosines.map((c, i) =>
      makeEdgeMemory(`e${i}`, { ...existingText(i), local_embedding: localVecAt(c) })
    );

    const edges = computeEdgeCandidates(newMem, existing);

    expect(edges.length).toBe(3); // cap, not 10
    // Strongest three, sorted descending
    expect(edges.map(e => e.targetId)).toEqual(['e9', 'e8', 'e7']);
    // Same-domain band is relate → active edges with band strength, never suggested
    for (const edge of edges) {
      expect(edge.status).toBe('active');
      expect(edge.strength).toBeCloseTo(edge.score, 10);
    }
  });

  it('local-cosine below 0.6 creates NO edges (same-domain background)', () => {
    const newMem = makeEdgeMemory('new', { ...newMemText, local_embedding: localVecAt(1) });
    const existing = [0.3, 0.45, 0.55, 0.59].map((c, i) =>
      makeEdgeMemory(`e${i}`, { ...existingText(i), local_embedding: localVecAt(c) })
    );

    expect(computeEdgeCandidates(newMem, existing)).toEqual([]);
  });

  it('local-cosine maps bands: relate→active, suggest→suggested, consolidate→active', () => {
    const newMem = makeEdgeMemory('new', { ...newMemText, local_embedding: localVecAt(1) });
    const existing = [
      makeEdgeMemory('relate', { ...existingText(0), local_embedding: localVecAt(0.7) }),
      makeEdgeMemory('suggest', { ...existingText(1), local_embedding: localVecAt(0.78) }),
      makeEdgeMemory('consolidate', { ...existingText(2), local_embedding: localVecAt(0.9) }),
    ];

    const edges = computeEdgeCandidates(newMem, existing);

    expect(edges.map(e => e.targetId)).toEqual(['consolidate', 'suggest', 'relate']);
    expect(edges.find(e => e.targetId === 'relate')!.status).toBe('active');
    expect(edges.find(e => e.targetId === 'suggest')!.status).toBe('suggested');
    expect(edges.find(e => e.targetId === 'consolidate')!.status).toBe('active');
    // consolidate uses the raw score as strength
    expect(edges.find(e => e.targetId === 'consolidate')!.strength).toBeCloseTo(0.9, 5);
  });

  it('Jaccard fallback behavior unchanged: 0.25 overlap still creates a relate edge', () => {
    // No embeddings on either side → Jaccard with the original FR-059 bands
    const newMem = makeEdgeMemory('new', {
      summary: 'one two', content: 'one two three four',
    });
    // Jaccard: intersection {one,two} = 2, union 6 → 0.333 → relate
    const existing = [makeEdgeMemory('e0', {
      summary: 'one two', content: 'one two five six',
    })];

    const edges = computeEdgeCandidates(newMem, existing);

    expect(edges.length).toBe(1);
    expect(edges[0].status).toBe('active');
    expect(edges[0].score).toBeCloseTo(2 / 6, 5);
  });

  it('per-memory edge cap is enforced for Jaccard edges too', () => {
    const newMem = makeEdgeMemory('new', { summary: 'one two', content: 'one two three four' });
    const existing = Array.from({ length: 8 }, (_, i) =>
      makeEdgeMemory(`e${i}`, { summary: 'one two', content: 'one two five six' })
    );

    expect(computeEdgeCandidates(newMem, existing).length).toBe(3);
    expect(computeEdgeCandidates(newMem, existing, 5).length).toBe(5);
  });

  it('skips self-comparison', () => {
    const mem = makeEdgeMemory('same', { ...newMemText, local_embedding: localVecAt(1) });
    expect(computeEdgeCandidates(mem, [mem])).toEqual([]);
  });
});
