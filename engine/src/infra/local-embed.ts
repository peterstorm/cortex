/**
 * Local embedding fallback using Hugging Face transformers.
 *
 * Provides local embedding when Voyage AI unavailable.
 * Uses all-MiniLM-L6-v2 model (384 dimensions, Float32Array).
 *
 * Requirements:
 * - FR-110: Support fallback to local embedding model
 * - NFR-014: Support keyword search when embedding API unavailable
 */

// Functional Core: Pure types
type ModelAvailabilityResult =
  | { ok: true }
  | { ok: false; error: string };

// Dynamic import with error handling
let transformersModule: typeof import('@huggingface/transformers') | null = null;
let importError: Error | null = null;

async function getTransformers() {
  if (transformersModule) return transformersModule;
  if (importError) throw importError;

  try {
    transformersModule = await import('@huggingface/transformers');
    return transformersModule;
  } catch (err) {
    importError = err instanceof Error ? err : new Error(String(err));
    throw importError;
  }
}

// Imperative Shell: Cached state
let cachedPipeline: any | null = null;
let modelAvailabilityCache: ModelAvailabilityResult | null = null;

/**
 * Load the local embedding model (lazy initialization).
 * Caches the pipeline for reuse.
 */
async function loadModel(): Promise<ModelAvailabilityResult> {
  if (cachedPipeline) {
    return { ok: true };
  }

  try {
    const { pipeline } = await getTransformers();
    cachedPipeline = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true }
    );
    return { ok: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to load local embedding model: ${errorMsg}` };
  }
}

/**
 * Mean pooling: average embeddings across all tokens.
 * Pure function for embedding transformation.
 */
function meanPooling(embeddings: number[][][]): Float32Array {
  // embeddings shape: [batch_size, sequence_length, hidden_size]
  // We process batch_size=1, so take first element
  const tokenEmbeddings = embeddings[0];
  const numTokens = tokenEmbeddings.length;
  const hiddenSize = tokenEmbeddings[0].length;

  const pooled = new Float32Array(hiddenSize);

  // Sum across tokens
  for (let i = 0; i < numTokens; i++) {
    for (let j = 0; j < hiddenSize; j++) {
      pooled[j] += tokenEmbeddings[i][j];
    }
  }

  // Average
  for (let j = 0; j < hiddenSize; j++) {
    pooled[j] /= numTokens;
  }

  return pooled;
}

/**
 * Check if local embedding model is available (synchronous).
 * Returns true only if model has been successfully loaded and cached.
 * Use ensureModelLoaded() to trigger async loading if needed.
 */
export function isLocalModelAvailable(): boolean {
  return modelAvailabilityCache?.ok === true;
}

/**
 * Ensure the local embedding model is loaded.
 * Attempts to load the model if not already cached.
 * Returns true if model is available, false otherwise.
 */
// Track when a failure was cached, so we can retry after TTL
let failureCachedAt: number | null = null;
const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 min TTL on failure cache

export async function ensureModelLoaded(): Promise<boolean> {
  if (modelAvailabilityCache !== null) {
    // On success, return cached result forever
    if (modelAvailabilityCache.ok) return true;
    // On failure, retry after TTL expires
    if (failureCachedAt !== null && Date.now() - failureCachedAt < FAILURE_TTL_MS) {
      return false;
    }
    // TTL expired — clear cache and retry
    modelAvailabilityCache = null;
    failureCachedAt = null;
  }

  const result = await loadModel();
  modelAvailabilityCache = result;
  if (!result.ok) {
    failureCachedAt = Date.now();
  }
  return result.ok;
}

/**
 * Embed text using local transformer model.
 * Returns Float32Array of 384 dimensions.
 *
 * Throws if model unavailable or embedding fails.
 */
export async function embedLocal(text: string): Promise<Float32Array> {
  // Validate input
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new Error('text must not be empty');
  }

  // Ensure model loaded
  const loadResult = await loadModel();
  if (!loadResult.ok) {
    throw new Error(loadResult.error);
  }

  if (!cachedPipeline) {
    throw new Error('Model loaded but pipeline is null (unexpected state)');
  }

  try {
    // Generate embeddings
    const output = await cachedPipeline(trimmed, {
      pooling: 'none',
      normalize: false,
    });

    // Extract raw embeddings (nested array)
    const rawEmbeddings = output.tolist() as number[][][];

    // Apply mean pooling
    const embedding = meanPooling(rawEmbeddings);

    // Validate dimensions
    if (embedding.length !== 384) {
      throw new Error(`Expected 384 dimensions, got ${embedding.length}`);
    }

    return embedding;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to generate local embedding: ${errorMsg}`);
  }
}

/**
 * Reset cached state (for testing).
 * Clears all module-level state including import errors.
 */
export function resetLocalEmbedCache(): void {
  cachedPipeline = null;
  modelAvailabilityCache = null;
  failureCachedAt = null;
  transformersModule = null;
  importError = null;
}
