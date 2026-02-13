import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { embedTexts, isGeminiAvailable } from './gemini-embed.js';

// Mock fetch globally
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('isGeminiAvailable', () => {
  it('returns true for valid non-empty API key', () => {
    expect(isGeminiAvailable('AIzaSy-test-key-123')).toBe(true);
  });

  it('returns false for undefined', () => {
    expect(isGeminiAvailable(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGeminiAvailable('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(isGeminiAvailable('   ')).toBe(false);
  });

  it('returns false for non-string types', () => {
    expect(isGeminiAvailable(null as any)).toBe(false);
    expect(isGeminiAvailable(123 as any)).toBe(false);
    expect(isGeminiAvailable({} as any)).toBe(false);
    expect(isGeminiAvailable([] as any)).toBe(false);
  });
});

describe('embedTexts', () => {
  describe('successful embedding', () => {
    it('embeds single text successfully', async () => {
      const mockEmbedding = Array(768).fill(0).map((_, i) => i * 0.001);
      const mockResponse = {
        embedding: {
          values: mockEmbedding,
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await embedTexts(['test text'], 'AIzaSy-test-key');

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Float64Array);
      expect(result[0].length).toBe(768);
      expect(Array.from(result[0])).toEqual(mockEmbedding);

      // Verify fetch was called correctly
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': 'AIzaSy-test-key',
          },
          body: JSON.stringify({
            content: {
              parts: [{ text: 'test text' }],
            },
            outputDimensionality: 768,
          }),
        }
      );
    });

    it('embeds multiple texts in batch', async () => {
      const mockEmbeddings = [
        Array(768).fill(0).map((_, i) => i * 0.001),
        Array(768).fill(0).map((_, i) => i * 0.002),
        Array(768).fill(0).map((_, i) => i * 0.003),
      ];
      const mockResponse = {
        embeddings: [
          { values: mockEmbeddings[0] },
          { values: mockEmbeddings[1] },
          { values: mockEmbeddings[2] },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const texts = ['text one', 'text two', 'text three'];
      const result = await embedTexts(texts, 'AIzaSy-test-key');

      expect(result).toHaveLength(3);
      result.forEach((embedding, i) => {
        expect(embedding).toBeInstanceOf(Float64Array);
        expect(embedding.length).toBe(768);
        expect(Array.from(embedding)).toEqual(mockEmbeddings[i]);
      });

      // Verify batch endpoint was used
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': 'AIzaSy-test-key',
          },
        })
      );
    });

    it('returns empty array for empty input', async () => {
      const result = await embedTexts([], 'AIzaSy-test-key');
      expect(result).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('throws when batch size exceeds limit', async () => {
      const oversized = Array.from({ length: 101 }, (_, i) => `text ${i}`);
      await expect(embedTexts(oversized, 'test-key')).rejects.toThrow(/batch limit/i);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws on missing API key', async () => {
      await expect(embedTexts(['test'], '')).rejects.toThrow(
        'Gemini API key is required and must be non-empty'
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws on undefined API key', async () => {
      await expect(embedTexts(['test'], undefined as any)).rejects.toThrow(
        'Gemini API key is required and must be non-empty'
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws on network failure (single text)', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network timeout'));

      await expect(embedTexts(['test'], 'AIzaSy-test-key')).rejects.toThrow(
        'Network failure calling Gemini API: Network timeout'
      );
    });

    it('throws on network failure (batch)', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network timeout'));

      await expect(embedTexts(['test1', 'test2'], 'AIzaSy-test-key')).rejects.toThrow(
        'Network failure calling Gemini API: Network timeout'
      );
    });

    it('throws on 401 authentication error', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid API key' } }),
      });

      await expect(embedTexts(['test'], 'AIzaSy-invalid-key')).rejects.toThrow(
        'Gemini API authentication failed (401): Invalid API key'
      );
    });

    it('throws on 403 forbidden error', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ message: 'Access denied' }),
      });

      await expect(embedTexts(['test'], 'AIzaSy-test-key')).rejects.toThrow(
        'Gemini API authentication failed (403): Access denied'
      );
    });

    it('throws on 429 rate limit error', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: { message: 'Rate limit exceeded' } }),
      });

      await expect(embedTexts(['test'], 'AIzaSy-test-key')).rejects.toThrow(
        'Gemini API rate limit exceeded (429): Rate limit exceeded'
      );
    });

    it('throws on 500 server error', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: { message: 'Server error' } }),
      });

      await expect(embedTexts(['test'], 'AIzaSy-test-key')).rejects.toThrow(
        'Gemini API error (500): Server error'
      );
    });

    it('handles error response with no JSON body', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new Error('No JSON');
        },
      });

      await expect(embedTexts(['test'], 'AIzaSy-test-key')).rejects.toThrow(
        'Gemini API error (502): Bad Gateway'
      );
    });

    it('throws on malformed JSON response (single)', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      await expect(embedTexts(['test'], 'AIzaSy-test-key')).rejects.toThrow(
        'Malformed response from Gemini API: Invalid JSON'
      );
    });

    it('throws on malformed JSON response (batch)', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      await expect(embedTexts(['test1', 'test2'], 'AIzaSy-test-key')).rejects.toThrow(
        'Malformed response from Gemini API: Invalid JSON'
      );
    });

    it('throws when single response missing embedding.values field', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ model: 'gemini-embedding-001' }),
      });

      await expect(embedTexts(['test'], 'AIzaSy-test-key')).rejects.toThrow(
        'Malformed response from Gemini API: missing or invalid embedding.values field'
      );
    });

    it('throws when batch response missing embeddings field', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ model: 'gemini-embedding-001' }),
      });

      await expect(embedTexts(['test1', 'test2'], 'AIzaSy-test-key')).rejects.toThrow(
        'Malformed response from Gemini API: missing or invalid embeddings field'
      );
    });

    it('throws when batch response embeddings is not an array', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ embeddings: 'not an array' }),
      });

      await expect(embedTexts(['test1', 'test2'], 'AIzaSy-test-key')).rejects.toThrow(
        'Malformed response from Gemini API: missing or invalid embeddings field'
      );
    });

    it('throws when response has wrong number of embeddings', async () => {
      const mockEmbedding = Array(768).fill(0);
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: [{ values: mockEmbedding }],
        }),
      });

      await expect(embedTexts(['text1', 'text2'], 'AIzaSy-test-key')).rejects.toThrow(
        'Malformed response from Gemini API: expected 2 embeddings, got 1'
      );
    });

    it('throws when embedding values is not an array', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: [{ values: 'not an array' }, { values: 'not an array' }],
        }),
      });

      await expect(embedTexts(['test1', 'test2'], 'AIzaSy-test-key')).rejects.toThrow(
        'Failed to process embeddings: Malformed response: embedding values is not an array'
      );
    });

    it('throws when embedding has wrong dimensions (single)', async () => {
      const wrongDimensions = Array(512).fill(0); // Wrong size
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          embedding: { values: wrongDimensions },
        }),
      });

      await expect(embedTexts(['test'], 'AIzaSy-test-key')).rejects.toThrow(
        'Malformed response from Gemini API: expected 768 dimensions, got 512'
      );
    });

    it('throws when embedding has wrong dimensions (batch)', async () => {
      const wrongDimensions = Array(512).fill(0); // Wrong size
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: [{ values: wrongDimensions }, { values: wrongDimensions }],
        }),
      });

      await expect(embedTexts(['test1', 'test2'], 'AIzaSy-test-key')).rejects.toThrow(
        'Failed to process embeddings: Malformed response: expected 768 dimensions, got 512'
      );
    });
  });

  describe('immutability', () => {
    it('accepts readonly array (immutability guarantee)', async () => {
      const mockEmbedding = Array(768).fill(0);
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          embedding: { values: mockEmbedding },
        }),
      });

      const texts: readonly string[] = ['test text'];
      const result = await embedTexts(texts, 'AIzaSy-test-key');

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Float64Array);
    });
  });
});

// Property-based tests
describe('property tests', () => {
  describe('isGeminiAvailable invariants', () => {
    it('returns true only for non-empty strings', () => {
      fc.assert(
        fc.property(fc.anything(), (value) => {
          const result = isGeminiAvailable(value as any);
          if (typeof value === 'string' && value.trim().length > 0) {
            expect(result).toBe(true);
          } else {
            expect(result).toBe(false);
          }
        })
      );
    });

    it('is consistent for same input', () => {
      fc.assert(
        fc.property(fc.string(), (key) => {
          const result1 = isGeminiAvailable(key);
          const result2 = isGeminiAvailable(key);
          expect(result1).toBe(result2);
        })
      );
    });
  });

  describe('embedTexts output properties', () => {
    it('output array length matches input array length', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 2, maxLength: 5 }),
          async (texts) => {
            const mockEmbeddings = texts.map(() => Array(768).fill(0).map((_, i) => i * 0.001));
            const mockResponse = {
              embeddings: mockEmbeddings.map((values) => ({ values })),
            };

            (global.fetch as any).mockResolvedValueOnce({
              ok: true,
              status: 200,
              json: async () => mockResponse,
            });

            const result = await embedTexts(texts, 'AIzaSy-test-key');
            expect(result.length).toBe(texts.length);
          }
        ),
        { numRuns: 20 }
      );
    });

    it('all embeddings have correct dimensions', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 3 }),
          async (texts) => {
            const mockEmbeddings = texts.map(() => Array(768).fill(0).map((_, i) => i * 0.001));
            const mockResponse = {
              embeddings: mockEmbeddings.map((values) => ({ values })),
            };

            (global.fetch as any).mockResolvedValueOnce({
              ok: true,
              status: 200,
              json: async () => mockResponse,
            });

            const result = await embedTexts(texts, 'AIzaSy-test-key');
            result.forEach((embedding) => {
              expect(embedding).toBeInstanceOf(Float64Array);
              expect(embedding.length).toBe(768);
            });
          }
        ),
        { numRuns: 10 }
      );
    });
  });
});
