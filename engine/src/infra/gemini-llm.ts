/**
 * Gemini API client for memory extraction and edge classification.
 * Pure functional API wrapper with no side effects beyond API calls.
 *
 * FR-001: Extract memories automatically at session end
 * FR-002: Parse transcripts to identify decisions, patterns, gotchas, etc.
 * FR-056: Support typed edges between memories
 */

import type { EdgeRelation } from '../core/types.js';
import { EDGE_RELATIONS, isEdgeRelation } from '../core/types.js';

const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const TEMPERATURE = 0;

/**
 * Memory pair for edge classification.
 */
export interface MemoryPair {
  readonly source: {
    readonly id: string;
    readonly content: string;
    readonly summary: string;
    readonly memory_type: string;
  };
  readonly target: {
    readonly id: string;
    readonly content: string;
    readonly summary: string;
    readonly memory_type: string;
  };
}

/**
 * Edge classification result from Gemini.
 */
export interface EdgeClassification {
  readonly source_id: string;
  readonly target_id: string;
  readonly relation_type: EdgeRelation;
  readonly strength: number;
}

/**
 * Check if Gemini API is available (has valid key).
 *
 * @param apiKey - API key (may be undefined)
 * @returns true if key is non-empty string
 */
export function isGeminiLlmAvailable(apiKey: string | undefined): boolean {
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

/**
 * Extract memories from transcript using Gemini.
 * Sends extraction prompt and returns raw response text.
 * Caller is responsible for parsing via parseExtractionResponse.
 *
 * FR-001: Memory extraction from transcripts
 * FR-002: Parse transcript format
 *
 * @param prompt - Extraction prompt (from buildExtractionPrompt)
 * @param apiKey - Gemini API key
 * @returns Raw Gemini response text
 * @throws Error if API call fails
 */
export async function extractMemories(
  prompt: string,
  apiKey: string
): Promise<string> {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: TEMPERATURE,
        },
      }),
    });

    // Handle HTTP errors
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Gemini API authentication failed (${response.status}): ${errorText}`);
      }

      if (response.status === 429) {
        throw new Error(`Gemini API rate limit exceeded (429): ${errorText}`);
      }

      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Extract text from response
    const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textContent) {
      throw new Error('No text content in Gemini response');
    }

    return textContent;
  } catch (error) {
    // Re-throw if already wrapped
    if (error instanceof Error && error.message.startsWith('Gemini')) {
      throw error;
    }

    // Network failures
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network failure calling Gemini API: ${message}`);
  }
}

/**
 * Classify edges between memory pairs using Gemini.
 * Returns typed edge relationships with strength scores.
 *
 * FR-056: Typed edges between memories
 *
 * @param pairs - Memory pairs to classify
 * @param apiKey - Gemini API key
 * @returns Array of edge classifications
 * @throws Error if API call fails
 */
export async function classifyEdges(
  pairs: readonly MemoryPair[],
  apiKey: string
): Promise<readonly EdgeClassification[]> {
  // Empty input - return empty array without API call
  if (pairs.length === 0) {
    return [];
  }

  const prompt = buildEdgeClassificationPrompt(pairs);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: TEMPERATURE,
        },
      }),
    });

    // Handle HTTP errors
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Gemini API authentication failed (${response.status}): ${errorText}`);
      }

      if (response.status === 429) {
        throw new Error(`Gemini API rate limit exceeded (429): ${errorText}`);
      }

      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Extract text from response
    const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textContent) {
      throw new Error('No text content in Gemini response');
    }

    return parseEdgeClassificationResponse(textContent);
  } catch (error) {
    // Re-throw if already wrapped
    if (error instanceof Error && error.message.startsWith('Gemini')) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Gemini edge classification failed: ${message}`);
  }
}

/**
 * Build prompt for edge classification.
 * Pure function - no side effects.
 * Exported for testing.
 */
export function buildEdgeClassificationPrompt(
  pairs: readonly MemoryPair[]
): string {
  const pairDescriptions = pairs
    .map(
      (pair, idx) => `
Pair ${idx + 1}:
  Source [${pair.source.id}]:
    Type: ${pair.source.memory_type}
    Summary: ${pair.source.summary}
    Content: ${pair.source.content}

  Target [${pair.target.id}]:
    Type: ${pair.target.memory_type}
    Summary: ${pair.target.summary}
    Content: ${pair.target.content}
`
    )
    .join('\n');

  return `Classify relationships between memory pairs.

Memory Pairs:
${pairDescriptions}

Edge Relation Types:
- relates_to: General semantic connection
- derived_from: Target derived from source
- contradicts: Target contradicts source
- exemplifies: Target is example of source
- refines: Target refines/improves source
- supersedes: Target replaces source
- source_of: Source is origin of target

Rules:
1. Assign relation_type based on semantic relationship
2. Assign strength 0-1 based on relationship strength:
   - 0.8-1.0: Strong, clear relationship
   - 0.5-0.79: Moderate relationship
   - 0.3-0.49: Weak relationship
3. Only return edges with strength >= 0.3

Return JSON array:
[
  {
    "source_id": "id1",
    "target_id": "id2",
    "relation_type": "relates_to",
    "strength": 0.75
  }
]

If no strong relationships, return empty array [].`;
}

/**
 * Parse edge classification response from Gemini.
 * Pure function - returns parsed edges or empty array on failure.
 * Exported for testing.
 */
export function parseEdgeClassificationResponse(
  response: string
): readonly EdgeClassification[] {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || [
      null,
      response,
    ];
    const jsonText = jsonMatch[1] || response;

    const parsed = JSON.parse(jsonText.trim());

    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate and filter classifications
    return parsed
      .filter(isValidEdgeClassification)
      .map((c) => ({
        source_id: String(c.source_id),
        target_id: String(c.target_id),
        relation_type: c.relation_type,
        strength: Number(c.strength),
      }));
  } catch (e) {
    process.stderr.write(`WARNING: Failed to parse edge classification response: ${(e as Error).message}\n`);
    return [];
  }
}

/**
 * Validate edge classification object.
 * Type guard for runtime validation.
 */
function isValidEdgeClassification(
  obj: unknown
): obj is EdgeClassification {
  if (typeof obj !== 'object' || obj === null) return false;

  const classification = obj as Record<string, unknown>;

  // Check required fields exist
  if (
    typeof classification.source_id !== 'string' ||
    typeof classification.target_id !== 'string' ||
    typeof classification.relation_type !== 'string' ||
    typeof classification.strength !== 'number'
  ) {
    return false;
  }

  // Validate relation_type using type guard
  if (!isEdgeRelation(classification.relation_type)) {
    return false;
  }

  // Validate strength range
  if (classification.strength < 0 || classification.strength > 1) {
    return false;
  }

  return true;
}
