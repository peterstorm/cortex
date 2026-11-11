/**
 * Tests for local-embed module.
 *
 * Handles cases where model may/may not be available in test environment.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { LOCAL_EMBEDDING_DIMENSIONS } from '../config.js';
import {
  embedLocal,
  isLocalModelAvailable,
  ensureModelLoaded,
  resetLocalEmbedCache,
  disposeLocalModel,
} from './local-embed';

describe('local-embed', () => {
  beforeEach(async () => {
    // Reset cache before each test for isolation
    await resetLocalEmbedCache();
  });

  afterAll(async () => {
    // Dispose ONNX pipeline to prevent Bun C++ teardown crash
    await disposeLocalModel();
  });

  describe('isLocalModelAvailable', () => {
    it('returns false before model is loaded', () => {
      const available = isLocalModelAvailable();
      expect(available).toBe(false);
    });

    it('returns true after successful model load', async () => {
      await ensureModelLoaded();
      const available = isLocalModelAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('is synchronous', () => {
      const result = isLocalModelAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('ensureModelLoaded', () => {
    it('returns boolean result', async () => {
      const available = await ensureModelLoaded();
      expect(typeof available).toBe('boolean');
    });

    it('caches result on subsequent calls', async () => {
      const first = await ensureModelLoaded();
      const second = await ensureModelLoaded();
      expect(second).toBe(first);
    });

    it('updates isLocalModelAvailable after loading', async () => {
      expect(isLocalModelAvailable()).toBe(false);
      await ensureModelLoaded();
      const available = isLocalModelAvailable();
      expect(typeof available).toBe('boolean');
    });
  });

  describe('embedLocal - input validation', () => {
    it('throws on empty text', async () => {
      await expect(embedLocal('')).rejects.toThrow('text must not be empty');
    });

    it('throws on whitespace-only text', async () => {
      await expect(embedLocal('   ')).rejects.toThrow('text must not be empty');
    });
  });

  describe('embedLocal - when model available', () => {
    it(`returns Float32Array of length ${LOCAL_EMBEDDING_DIMENSIONS}`, async () => {
      const available = await ensureModelLoaded();
      if (!available) {
        await expect(embedLocal('test text')).rejects.toThrow(/Failed to load local embedding model/);
        return;
      }

      const embedding = await embedLocal('test text');
      expect(embedding).toBeInstanceOf(Float32Array);
      // The configured dimension, never a literal: the constant is what stored
      // vectors are validated against, so a model swap that changed the width
      // fails in one place (config) instead of here.
      expect(embedding.length).toBe(LOCAL_EMBEDDING_DIMENSIONS);
    });

    it('returns deterministic embeddings for same text', async () => {
      const available = await ensureModelLoaded();
      if (!available) {
        return;
      }

      const text = 'machine learning model';
      const embedding1 = await embedLocal(text);
      const embedding2 = await embedLocal(text);

      expect(embedding1.length).toBe(embedding2.length);

      // Check all values are identical
      for (let i = 0; i < embedding1.length; i++) {
        expect(embedding1[i]).toBe(embedding2[i]);
      }
    });

    it('produces different embeddings for different texts', async () => {
      const available = await ensureModelLoaded();
      if (!available) {
        return;
      }

      const text1 = 'functional programming in TypeScript';
      const text2 = 'object-oriented programming in Java';

      const embedding1 = await embedLocal(text1);
      const embedding2 = await embedLocal(text2);

      expect(embedding1.length).toBe(LOCAL_EMBEDDING_DIMENSIONS);
      expect(embedding2.length).toBe(LOCAL_EMBEDDING_DIMENSIONS);

      // Check at least some values differ
      let differenceCount = 0;
      for (let i = 0; i < embedding1.length; i++) {
        if (embedding1[i] !== embedding2[i]) {
          differenceCount++;
        }
      }

      expect(differenceCount).toBeGreaterThan(0);
    });

    it('produces non-zero embeddings', async () => {
      const available = await ensureModelLoaded();
      if (!available) {
        return;
      }

      const embedding = await embedLocal('TypeScript development');

      // Check not all zeros
      const hasNonZero = Array.from(embedding).some(v => v !== 0);
      expect(hasNonZero).toBe(true);
    });

    it('handles longer text', async () => {
      const available = await ensureModelLoaded();
      if (!available) {
        return;
      }

      const longText = 'This is a longer text to test embedding generation. '.repeat(10);
      const embedding = await embedLocal(longText);

      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(LOCAL_EMBEDDING_DIMENSIONS);
    });

    it('embeddings have reasonable magnitude', async () => {
      const available = await ensureModelLoaded();
      if (!available) {
        return;
      }

      const embedding = await embedLocal('test text');

      // Calculate L2 norm
      let sumSquares = 0;
      for (let i = 0; i < embedding.length; i++) {
        sumSquares += embedding[i] * embedding[i];
      }
      const norm = Math.sqrt(sumSquares);

      // Norm should be positive and not excessively large
      expect(norm).toBeGreaterThan(0);
      expect(norm).toBeLessThan(1000);
    });
  });

  describe('load noise', () => {
    // The model is loaded in a fresh process on every user prompt, and the host
    // is a live TUI. Anything the load writes to the console is seen by the
    // user, so a zero-length warning list is the contract, not a nicety.
    it('loads without writing anything to the console', async () => {
      const warnings: unknown[][] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      try {
        await ensureModelLoaded();
      } finally {
        console.warn = original;
      }

      expect(warnings).toEqual([]);
    });
  });

  describe('caching behavior', () => {
    it('reuses loaded model for multiple embeddings', async () => {
      // Count model loads directly. A wall-clock comparison of two embeddings
      // proved nothing (the model was already loaded before either timing) and
      // flaked on millisecond granularity.
      const { PreTrainedModel } = await import('@huggingface/transformers');
      const loads = vi.spyOn(PreTrainedModel, 'from_pretrained');
      try {
        const available = await ensureModelLoaded();
        if (!available) {
          return;
        }

        await embedLocal('first text');
        await embedLocal('second text');

        expect(loads).toHaveBeenCalledTimes(1);
      } finally {
        loads.mockRestore();
      }
    });
  });
});
