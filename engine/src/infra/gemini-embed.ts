/**
 * Google Gemini embedding client
 *
 * Thin HTTP client for generating embeddings via Google Gemini API.
 * All functions are pure (no classes) following functional core pattern.
 */

const GEMINI_EMBED_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const GEMINI_BATCH_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';

/**
 * Embedding vector dimensions for gemini-embedding-001 model.
 * Exported for downstream consumers that need to know vector size.
 */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * Maximum number of texts per API request.
 * Gemini API limit: 100 texts per batch.
 */
export const MAX_BATCH_SIZE = 100;

/**
 * Response structure from Gemini API (single embedding)
 */
type GeminiSingleResponse = {
  embedding: {
    values: number[];
  };
};

/**
 * Response structure from Gemini API (batch embeddings)
 */
type GeminiBatchResponse = {
  embeddings: Array<{
    values: number[];
  }>;
};

/**
 * Check if Gemini API is available (API key present and non-empty).
 * Does not make network calls - only validates key format.
 *
 * @param apiKey - Gemini API key (optional)
 * @returns true if key is a non-empty string
 */
export function isGeminiAvailable(apiKey: string | undefined): boolean {
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

/**
 * Embed multiple texts using Gemini API.
 * Returns Float64Array for each input text, preserving input order.
 *
 * @param texts - Array of texts to embed (readonly for immutability)
 * @param apiKey - Gemini API key
 * @returns Promise of Float64Array for each text
 * @throws Error with descriptive message on any failure
 */
export async function embedTexts(
  texts: readonly string[],
  apiKey: string
): Promise<Float64Array[]> {
  if (texts.length === 0) {
    return [];
  }

  if (texts.length > MAX_BATCH_SIZE) {
    throw new Error(`Gemini API batch limit exceeded: ${texts.length} texts (max ${MAX_BATCH_SIZE})`);
  }

  if (!isGeminiAvailable(apiKey)) {
    throw new Error('Gemini API key is required and must be non-empty');
  }

  // Single text uses different endpoint
  if (texts.length === 1) {
    return [await embedSingleText(texts[0], apiKey)];
  }

  // Multiple texts use batch endpoint
  return embedBatchTexts(texts, apiKey);
}

/**
 * Embed a single text using Gemini embedContent endpoint.
 */
async function embedSingleText(text: string, apiKey: string): Promise<Float64Array> {
  const requestBody = {
    content: {
      parts: [{ text }],
    },
    outputDimensionality: EMBEDDING_DIMENSIONS,
  };

  let response: Response;

  try {
    response = await fetch(GEMINI_EMBED_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown network error';
    throw new Error(`Network failure calling Gemini API: ${message}`);
  }

  // Handle HTTP errors
  if (!response.ok) {
    await handleHttpErrors(response);
  }

  // Parse and validate response
  let data: GeminiSingleResponse;
  try {
    data = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    throw new Error(`Malformed response from Gemini API: ${message}`);
  }

  if (!data.embedding || !Array.isArray(data.embedding.values)) {
    throw new Error('Malformed response from Gemini API: missing or invalid embedding.values field');
  }

  if (data.embedding.values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Malformed response from Gemini API: expected ${EMBEDDING_DIMENSIONS} dimensions, got ${data.embedding.values.length}`
    );
  }

  return new Float64Array(data.embedding.values);
}

/**
 * Embed multiple texts using Gemini batchEmbedContents endpoint.
 */
async function embedBatchTexts(texts: readonly string[], apiKey: string): Promise<Float64Array[]> {
  const requestBody = {
    requests: texts.map((text) => ({
      model: 'models/gemini-embedding-001',
      content: {
        parts: [{ text }],
      },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })),
  };

  let response: Response;

  try {
    response = await fetch(GEMINI_BATCH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown network error';
    throw new Error(`Network failure calling Gemini API: ${message}`);
  }

  // Handle HTTP errors
  if (!response.ok) {
    await handleHttpErrors(response);
  }

  // Parse and validate response
  let data: GeminiBatchResponse;
  try {
    data = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    throw new Error(`Malformed response from Gemini API: ${message}`);
  }

  if (!data.embeddings || !Array.isArray(data.embeddings)) {
    throw new Error('Malformed response from Gemini API: missing or invalid embeddings field');
  }

  if (data.embeddings.length !== texts.length) {
    throw new Error(
      `Malformed response from Gemini API: expected ${texts.length} embeddings, got ${data.embeddings.length}`
    );
  }

  // Convert to Float64Array and validate dimensions
  try {
    const embeddings = data.embeddings.map((item) => {
      if (!Array.isArray(item.values)) {
        throw new Error('Malformed response: embedding values is not an array');
      }
      if (item.values.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Malformed response: expected ${EMBEDDING_DIMENSIONS} dimensions, got ${item.values.length}`
        );
      }
      return new Float64Array(item.values);
    });

    return embeddings;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to process embeddings: ${message}`);
  }
}

/**
 * Handle HTTP errors from Gemini API responses.
 * Throws descriptive errors for different status codes.
 */
async function handleHttpErrors(response: Response): Promise<void> {
  if (!response.ok) {
    let errorMessage: string;
    try {
      const errorBody = await response.json();
      errorMessage = errorBody.error?.message || errorBody.message || 'Unknown error';
    } catch {
      errorMessage = response.statusText || 'Unknown error';
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Gemini API authentication failed (${response.status}): ${errorMessage}`);
    }

    if (response.status === 429) {
      throw new Error(`Gemini API rate limit exceeded (429): ${errorMessage}`);
    }

    throw new Error(`Gemini API error (${response.status}): ${errorMessage}`);
  }
}
