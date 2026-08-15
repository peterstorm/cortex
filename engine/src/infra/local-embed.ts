/**
 * Local embedding via Hugging Face transformers.js, on CPU.
 *
 * Model, dimensionality, and task prefixes all come from config
 * (LOCAL_EMBED_MODEL, LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBED_*_PREFIX) rather
 * than being inlined here — the previous implementation hardcoded both the
 * model id and a `!== 384` dimension check, which pinned the module to one
 * model and would have thrown on every call after a swap.
 *
 * Retrieval is asymmetric: queries and documents must carry different
 * prefixes to land in the same space. Callers pick a side via embedLocalQuery
 * or embedLocalDocument; embedLocal defaults to the document side, which is
 * what stored memories are.
 *
 * Requirements:
 * - FR-110: Support fallback to local embedding model
 * - NFR-014: Support keyword search when embedding API unavailable
 */

import {
  LOCAL_EMBED_MODEL,
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBED_QUERY_PREFIX,
  LOCAL_EMBED_DOCUMENT_PREFIX,
} from '../config.js';

// Functional Core: Pure types
type ModelAvailabilityResult =
  | { ok: true }
  | { ok: false; error: string };

/** The tensor shape transformers.js returns from a feature-extraction call. */
interface FeatureExtractionOutput {
  tolist(): number[][];
}

/**
 * Structural type for the loaded pipeline — only what this module calls.
 * Narrower than the library's exported type on purpose: it documents the exact
 * contract relied on, so a breaking change upstream surfaces here rather than
 * as an `any` that silently accepts anything.
 *
 * `dispose` belongs to that contract: disposeLocalModel() must release the ONNX
 * native handles before process exit or Bun crashes during C++ teardown.
 */
type FeatureExtractionPipeline = ((
  text: string,
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<FeatureExtractionOutput>) & {
  dispose(): Promise<void>;
};

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
let cachedPipeline: FeatureExtractionPipeline | null = null;
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
    // transformers.js overloads `pipeline()` across every task, so its return
    // type is a union large enough that TypeScript gives up on it (TS2590)
    // before it can be narrowed. Cast once, here, to the contract this module
    // actually uses — every call site downstream stays fully checked against
    // FeatureExtractionPipeline, which is where the type earns its keep.
    cachedPipeline = (await pipeline('feature-extraction', LOCAL_EMBED_MODEL, {
      dtype: 'q8',
    })) as unknown as FeatureExtractionPipeline;
    return { ok: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to load local embedding model: ${errorMsg}${remedyFor(errorMsg)}` };
  }
}

/**
 * Map a known load failure to its one correct fix, appended at the point of
 * failure.
 *
 * Callers degrade to Jaccard-only similarity when the model will not load, and
 * that fallback is quiet by design — so a bare cause like
 * "libstdc++.so.6: cannot open shared object file" surfaces once in a log line
 * nobody reads, and local embeddings simply never work. Stating the fix where
 * the failure happens is the difference between a silent degradation and an
 * actionable one.
 */
function remedyFor(errorMsg: string): string {
  if (errorMsg.includes('libstdc++')) {
    return (
      ' — onnxruntime-node needs libstdc++ at runtime, which is not on the default' +
      ' library path on NixOS. Set LD_LIBRARY_PATH to a gcc lib output' +
      ' (e.g. `nix-build \'<nixpkgs>\' -A stdenv.cc.cc.lib --no-out-link`/lib)' +
      ' for the process that runs extraction.'
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(errorMsg)) {
    return (
      ` — the model is downloaded from Hugging Face on first use (${LOCAL_EMBED_MODEL}).` +
      ' Run once with network access to populate the cache, or pre-seed it.'
    );
  }
  return '';
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
  return embedWithPrefix(text, LOCAL_EMBED_DOCUMENT_PREFIX);
}

/**
 * Embed a stored memory (the document side of retrieval).
 * Explicit alias for embedLocal — prefer it at call sites so the asymmetry is
 * visible in the code rather than implied by a default.
 */
export async function embedLocalDocument(text: string): Promise<Float32Array> {
  return embedWithPrefix(text, LOCAL_EMBED_DOCUMENT_PREFIX);
}

/**
 * Embed a search query (the query side of retrieval).
 *
 * Must be used for queries. Embedding a query with the document prefix places
 * it in the wrong region of the space, and the only symptom is quietly worse
 * recall — no error is raised anywhere.
 */
export async function embedLocalQuery(text: string): Promise<Float32Array> {
  return embedWithPrefix(text, LOCAL_EMBED_QUERY_PREFIX);
}

async function embedWithPrefix(text: string, prefix: string): Promise<Float32Array> {
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
    // Mean pooling + L2 normalization, so cosine similarity is a dot product.
    const output = await cachedPipeline(prefix + trimmed, {
      pooling: 'mean',
      normalize: true,
    });

    // Extract embedding (already pooled + normalized by pipeline)
    const rawEmbedding = output.tolist();
    const embedding = new Float32Array(rawEmbedding[0]);

    // Validate against the configured dimensionality, never a literal: a
    // hardcoded number silently pins this module to one model.
    if (embedding.length !== LOCAL_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Expected ${LOCAL_EMBEDDING_DIMENSIONS} dimensions from ${LOCAL_EMBED_MODEL}, got ${embedding.length}`
      );
    }

    return embedding;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to generate local embedding: ${errorMsg}`);
  }
}

/**
 * Dispose the cached pipeline to release ONNX native resources.
 * Must be called before process exit to avoid Bun C++ teardown crashes.
 * Safe to call even if no model is loaded.
 */
export async function disposeLocalModel(): Promise<void> {
  if (cachedPipeline) {
    try {
      await cachedPipeline.dispose();
    } catch {
      // Best-effort — ignore errors during disposal
    }
    cachedPipeline = null;
  }
}

/**
 * Reset cached state (for testing).
 * Disposes the ONNX pipeline (if loaded) to prevent native resource leaks,
 * then clears all module-level state including import errors.
 */
export async function resetLocalEmbedCache(): Promise<void> {
  await disposeLocalModel();
  modelAvailabilityCache = null;
  failureCachedAt = null;
  transformersModule = null;
  importError = null;
}
