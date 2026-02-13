/**
 * Tests for extract command
 * Simplified tests for bun test runner
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'bun:sqlite';
import type { HookInput } from '../core/types.js';
import { openDatabase } from '../infra/db.js';
import { truncateTranscript, buildExtractionPrompt, parseExtractionResponse } from '../core/extraction.js';
import { tokenize, jaccardSimilarity, classifySimilarity } from '../core/similarity.js';

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

      const candidates = parseExtractionResponse(response);

      expect(candidates.length).toBe(1);
      expect(candidates[0].content).toBe('Test content');
      expect(candidates[0].memory_type).toBe('decision');
    });

    it('handles markdown code blocks', () => {
      const response = '```json\n[{"content":"test","summary":"test","memory_type":"context","scope":"project","confidence":0.5,"priority":5,"tags":[]}]\n```';

      const candidates = parseExtractionResponse(response);

      expect(candidates.length).toBe(1);
    });

    it('returns empty array for invalid JSON', () => {
      const response = 'not json';

      const candidates = parseExtractionResponse(response);

      expect(candidates.length).toBe(0);
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

      const candidates = parseExtractionResponse(response);

      expect(candidates.length).toBe(1);
      expect(candidates[0].content).toBe('Valid');
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

