/**
 * Tests for Gemini API client.
 * All tests use mocked global.fetch - no real API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractMemories,
  classifyEdges,
  isGeminiLlmAvailable,
  buildEdgeClassificationPrompt,
  parseEdgeClassificationResponse,
  type MemoryPair,
} from './gemini-llm.js';

// Mock fetch globally
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('isGeminiLlmAvailable', () => {
  it('returns true for non-empty string', () => {
    expect(isGeminiLlmAvailable('api-key-123')).toBe(true);
  });

  it('returns false for undefined', () => {
    expect(isGeminiLlmAvailable(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGeminiLlmAvailable('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(isGeminiLlmAvailable('   ')).toBe(false);
  });
});

describe('extractMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns raw response text from Gemini', async () => {
    const responseText = JSON.stringify([
      {
        content: 'Test memory',
        summary: 'Summary',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        tags: ['test'],
      },
    ]);

    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: responseText,
                },
              ],
            },
          },
        ],
      }),
    });

    const prompt = 'Extract memories from: test transcript';
    const result = await extractMemories(prompt, 'test-api-key');

    expect(result).toBe(responseText);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0,
          },
        }),
      }
    );
  });

  it('throws error when no text content in response', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [],
      }),
    });

    await expect(
      extractMemories('test prompt', 'test-api-key')
    ).rejects.toThrow('No text content in Gemini response');
  });

  it('throws error with context when API call fails', async () => {
    (global.fetch as any).mockRejectedValue(
      new Error('API rate limit exceeded')
    );

    await expect(
      extractMemories('test prompt', 'test-api-key')
    ).rejects.toThrow('Network failure calling Gemini API: API rate limit exceeded');
  });

  it('handles non-Error exceptions', async () => {
    (global.fetch as any).mockRejectedValue('string error');

    await expect(
      extractMemories('test prompt', 'test-api-key')
    ).rejects.toThrow('Network failure calling Gemini API: string error');
  });

  it('throws authentication error on 401', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid API key',
    });

    await expect(
      extractMemories('test prompt', 'test-api-key')
    ).rejects.toThrow('Gemini API authentication failed (401): Invalid API key');
  });

  it('throws authentication error on 403', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'Access denied',
    });

    await expect(
      extractMemories('test prompt', 'test-api-key')
    ).rejects.toThrow('Gemini API authentication failed (403): Access denied');
  });

  it('throws rate limit error on 429', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'Rate limit exceeded',
    });

    await expect(
      extractMemories('test prompt', 'test-api-key')
    ).rejects.toThrow('Gemini API rate limit exceeded (429): Rate limit exceeded');
  });

  it('throws generic error on other HTTP errors', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server error',
    });

    await expect(
      extractMemories('test prompt', 'test-api-key')
    ).rejects.toThrow('Gemini API error (500): Server error');
  });

  it('handles error response with no text body', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => {
        throw new Error('No text');
      },
    });

    await expect(
      extractMemories('test prompt', 'test-api-key')
    ).rejects.toThrow('Gemini API error (502): Bad Gateway');
  });
});

describe('classifyEdges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed edge classifications', async () => {
    const responseText = JSON.stringify([
      {
        source_id: 'mem1',
        target_id: 'mem2',
        relation_type: 'relates_to',
        strength: 0.85,
      },
      {
        source_id: 'mem2',
        target_id: 'mem3',
        relation_type: 'derived_from',
        strength: 0.7,
      },
    ]);

    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: responseText,
                },
              ],
            },
          },
        ],
      }),
    });

    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Memory 1 content',
          summary: 'Memory 1 summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Memory 2 content',
          summary: 'Memory 2 summary',
          memory_type: 'pattern',
        },
      },
    ];

    const result = await classifyEdges(pairs, 'test-api-key');

    expect(result).toEqual([
      {
        source_id: 'mem1',
        target_id: 'mem2',
        relation_type: 'relates_to',
        strength: 0.85,
      },
      {
        source_id: 'mem2',
        target_id: 'mem3',
        relation_type: 'derived_from',
        strength: 0.7,
      },
    ]);
  });

  it('returns empty array for empty pairs without API call', async () => {
    const result = await classifyEdges([], 'test-api-key');

    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('handles JSON in markdown code blocks', async () => {
    const responseText = `
Here are the classifications:

\`\`\`json
[
  {
    "source_id": "mem1",
    "target_id": "mem2",
    "relation_type": "refines",
    "strength": 0.9
  }
]
\`\`\`
`;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: responseText,
                },
              ],
            },
          },
        ],
      }),
    });

    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Content 1',
          summary: 'Summary 1',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Content 2',
          summary: 'Summary 2',
          memory_type: 'pattern',
        },
      },
    ];

    const result = await classifyEdges(pairs, 'test-api-key');

    expect(result).toEqual([
      {
        source_id: 'mem1',
        target_id: 'mem2',
        relation_type: 'refines',
        strength: 0.9,
      },
    ]);
  });

  it('filters out invalid classifications', async () => {
    const responseText = JSON.stringify([
      {
        source_id: 'mem1',
        target_id: 'mem2',
        relation_type: 'relates_to',
        strength: 0.8,
      },
      {
        // Invalid: missing relation_type
        source_id: 'mem3',
        target_id: 'mem4',
        strength: 0.7,
      },
      {
        // Invalid: invalid relation_type
        source_id: 'mem5',
        target_id: 'mem6',
        relation_type: 'invalid_type',
        strength: 0.6,
      },
      {
        // Invalid: strength out of range
        source_id: 'mem7',
        target_id: 'mem8',
        relation_type: 'derived_from',
        strength: 1.5,
      },
    ]);

    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: responseText,
                },
              ],
            },
          },
        ],
      }),
    });

    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'pattern',
        },
      },
    ];

    const result = await classifyEdges(pairs, 'test-api-key');

    // Only first classification is valid
    expect(result).toEqual([
      {
        source_id: 'mem1',
        target_id: 'mem2',
        relation_type: 'relates_to',
        strength: 0.8,
      },
    ]);
  });

  it('returns empty array on parse failure', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: 'invalid json',
                },
              ],
            },
          },
        ],
      }),
    });

    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'pattern',
        },
      },
    ];

    const result = await classifyEdges(pairs, 'test-api-key');

    expect(result).toEqual([]);
  });

  it('returns empty array when response is not an array', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({ error: 'not an array' }),
                },
              ],
            },
          },
        ],
      }),
    });

    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'pattern',
        },
      },
    ];

    const result = await classifyEdges(pairs, 'test-api-key');

    expect(result).toEqual([]);
  });

  it('throws error when no text content in response', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [],
      }),
    });

    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'pattern',
        },
      },
    ];

    await expect(classifyEdges(pairs, 'test-api-key')).rejects.toThrow(
      'No text content in Gemini response'
    );
  });

  it('throws error with context when API call fails', async () => {
    (global.fetch as any).mockRejectedValue(
      new Error('Network timeout')
    );

    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Content',
          summary: 'Summary',
          memory_type: 'pattern',
        },
      },
    ];

    await expect(classifyEdges(pairs, 'test-api-key')).rejects.toThrow(
      'Gemini edge classification failed: Network timeout'
    );
  });

  it('validates all edge relation types', async () => {
    const responseText = JSON.stringify([
      { source_id: '1', target_id: '2', relation_type: 'relates_to', strength: 0.8 },
      { source_id: '1', target_id: '3', relation_type: 'derived_from', strength: 0.8 },
      { source_id: '1', target_id: '4', relation_type: 'contradicts', strength: 0.8 },
      { source_id: '1', target_id: '5', relation_type: 'exemplifies', strength: 0.8 },
      { source_id: '1', target_id: '6', relation_type: 'refines', strength: 0.8 },
      { source_id: '1', target_id: '7', relation_type: 'supersedes', strength: 0.8 },
      { source_id: '1', target_id: '8', relation_type: 'source_of', strength: 0.8 },
    ]);

    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: responseText }],
            },
          },
        ],
      }),
    });

    const pairs: MemoryPair[] = [
      {
        source: { id: '1', content: 'C', summary: 'S', memory_type: 'decision' },
        target: { id: '2', content: 'C', summary: 'S', memory_type: 'pattern' },
      },
    ];

    const result = await classifyEdges(pairs, 'test-api-key');

    expect(result).toHaveLength(7);
    expect(result.map((r) => r.relation_type)).toEqual([
      'relates_to',
      'derived_from',
      'contradicts',
      'exemplifies',
      'refines',
      'supersedes',
      'source_of',
    ]);
  });

  it('throws authentication error on 401', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid API key',
    });

    const pairs: MemoryPair[] = [
      {
        source: { id: '1', content: 'C', summary: 'S', memory_type: 'decision' },
        target: { id: '2', content: 'C', summary: 'S', memory_type: 'pattern' },
      },
    ];

    await expect(classifyEdges(pairs, 'test-api-key')).rejects.toThrow(
      'Gemini API authentication failed (401): Invalid API key'
    );
  });

  it('throws rate limit error on 429', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'Rate limit exceeded',
    });

    const pairs: MemoryPair[] = [
      {
        source: { id: '1', content: 'C', summary: 'S', memory_type: 'decision' },
        target: { id: '2', content: 'C', summary: 'S', memory_type: 'pattern' },
      },
    ];

    await expect(classifyEdges(pairs, 'test-api-key')).rejects.toThrow(
      'Gemini API rate limit exceeded (429): Rate limit exceeded'
    );
  });
});

describe('buildEdgeClassificationPrompt', () => {
  it('builds prompt with pair descriptions', () => {
    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Source content',
          summary: 'Source summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Target content',
          summary: 'Target summary',
          memory_type: 'pattern',
        },
      },
    ];

    const result = buildEdgeClassificationPrompt(pairs);

    expect(result).toContain('Pair 1:');
    expect(result).toContain('Source [mem1]:');
    expect(result).toContain('Type: decision');
    expect(result).toContain('Summary: Source summary');
    expect(result).toContain('Content: Source content');
    expect(result).toContain('Target [mem2]:');
    expect(result).toContain('Type: pattern');
    expect(result).toContain('Summary: Target summary');
    expect(result).toContain('Content: Target content');
    expect(result).toContain('Edge Relation Types:');
    expect(result).toContain('relates_to');
    expect(result).toContain('derived_from');
  });
});

describe('parseEdgeClassificationResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
    ]);

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
    ]);
  });

  it('parses JSON in markdown code blocks', () => {
    const response = `
\`\`\`json
[
  { "source_id": "mem1", "target_id": "mem2", "relation_type": "refines", "strength": 0.9 }
]
\`\`\`
`;

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'refines', strength: 0.9 },
    ]);
  });

  it('returns empty array for invalid JSON', () => {
    const result = parseEdgeClassificationResponse('invalid json');
    expect(result).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    const result = parseEdgeClassificationResponse(JSON.stringify({ error: 'test' }));
    expect(result).toEqual([]);
  });

  it('filters invalid classifications', () => {
    const response = JSON.stringify([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
      { source_id: 'mem3', target_id: 'mem4', relation_type: 'invalid', strength: 0.7 },
      { source_id: 'mem5', target_id: 'mem6', relation_type: 'refines', strength: 1.5 },
    ]);

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
    ]);
  });
});
