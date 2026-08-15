/**
 * Local embedding via Hugging Face transformers.js, on CPU.
 *
 * This is cortex's ONLY embedding provider. It must therefore be cheap enough
 * to run in a cold process, because the prompt-recall hook spawns a fresh `bun`
 * per user prompt — a model that takes seconds to load is unusable there no
 * matter how good its vectors are.
 *
 * That constraint selects a STATIC embedding model (model2vec / potion). Rather
 * than running a transformer, model2vec stores one vector per token and averages
 * them, which is why load and inference are ~1000x cheaper than a transformer of
 * comparable quality. Measured on this machine against EmbeddingGemma-300M:
 *
 *   load        12,026 ms -> 422 ms
 *   warm embed     132 ms -> 0.15 ms
 *   resident      1604 MB -> 300 MB
 *
 * Consequences of the static architecture that matter here:
 *
 * - There is NO query/document asymmetry. A transformer encodes the whole
 *   string in context, so instruction prefixes shift the result; model2vec just
 *   averages token vectors, so a prefix only dilutes the average with the
 *   prefix's own tokens. Queries and documents are embedded identically.
 * - The ONNX export is an EmbeddingBag graph taking `input_ids` (flat, all
 *   tokens concatenated) plus `offsets` (start index per sequence). The
 *   `pipeline('feature-extraction')` helper supplies neither, and fails with
 *   "Missing the following inputs: offsets" — hence the explicit
 *   AutoModel/AutoTokenizer path below.
 *
 * Model and dimensionality come from config, never inlined: an earlier version
 * hardcoded both the model id and a `!== 384` check, which pinned the module to
 * one model and would have thrown on every call after a swap.
 */

import { LOCAL_EMBED_MODEL, LOCAL_EMBEDDING_DIMENSIONS } from '../config.js';

// Functional Core: Pure types
type ModelAvailabilityResult =
  | { ok: true }
  | { ok: false; error: string };

/** Minimal shape of a transformers.js tensor this module reads. */
interface OnnxTensor {
  readonly data: ArrayLike<number>;
}

/** Tokenizer output — only `input_ids` is used. */
interface TokenizerOutput {
  readonly input_ids: number[] | number[][];
}

/**
 * Structural types for the loaded model and tokenizer — only what this module
 * calls. Narrower than the library's exported types on purpose: they document
 * the exact contract relied on, so a breaking change upstream surfaces here
 * rather than as an `any` that silently accepts anything.
 *
 * `dispose` belongs to the contract: disposeLocalModel() must release the ONNX
 * native handles before process exit or Bun crashes during C++ teardown.
 */
type EmbeddingBagModel = ((inputs: {
  input_ids: unknown;
  offsets: unknown;
}) => Promise<Record<string, OnnxTensor>>) & {
  dispose(): Promise<void>;
};

type StaticTokenizer = (
  text: string,
  options: { add_special_tokens: boolean; return_tensor: boolean }
) => Promise<TokenizerOutput>;

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
let cachedModel: EmbeddingBagModel | null = null;
let cachedTokenizer: StaticTokenizer | null = null;
let modelAvailabilityCache: ModelAvailabilityResult | null = null;

/**
 * Load the local embedding model (lazy initialization).
 * Caches model and tokenizer for reuse.
 */
async function loadModel(): Promise<ModelAvailabilityResult> {
  if (cachedModel && cachedTokenizer) {
    return { ok: true };
  }

  try {
    const { AutoModel, AutoTokenizer } = await getTransformers();
    // transformers.js overloads these factories across every task, producing
    // union types large enough that TypeScript gives up (TS2590) before they
    // can be narrowed. Cast once, here, to the contract this module actually
    // uses — every call site downstream stays fully checked.
    cachedTokenizer = (await AutoTokenizer.from_pretrained(
      LOCAL_EMBED_MODEL
    )) as unknown as StaticTokenizer;
    cachedModel = (await AutoModel.from_pretrained(
      LOCAL_EMBED_MODEL
    )) as unknown as EmbeddingBagModel;
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
 * Embed text with the local static model, L2-normalized so cosine similarity is
 * a plain dot product.
 *
 * The same function serves queries and stored memories: model2vec averages
 * per-token vectors, so there is no context in which a query would be encoded
 * differently from a document, and an instruction prefix would only dilute the
 * average with its own tokens.
 *
 * Throws if the model is unavailable or embedding fails.
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

  if (!cachedModel || !cachedTokenizer) {
    throw new Error('Model loaded but model/tokenizer is null (unexpected state)');
  }

  try {
    const { Tensor } = await getTransformers();

    // No special tokens: they carry no meaning in a static average and would
    // pull every embedding toward a common point.
    const encoded = await cachedTokenizer(trimmed, {
      add_special_tokens: false,
      return_tensor: false,
    });
    const raw = encoded.input_ids;
    const flat: number[] = Array.isArray(raw[0]) ? (raw[0] as number[]) : (raw as number[]);

    // A string that tokenizes to nothing (punctuation, an unknown script) would
    // otherwise hand EmbeddingBag an empty bag and produce NaNs downstream.
    if (flat.length === 0) {
      throw new Error(`text produced no tokens: ${JSON.stringify(trimmed.slice(0, 40))}`);
    }

    // EmbeddingBag contract: all token ids concatenated, plus the start offset
    // of each sequence. One sequence here, so a single offset of 0.
    const output = await cachedModel({
      input_ids: new Tensor('int64', BigInt64Array.from(flat.map((id) => BigInt(id))), [flat.length]),
      offsets: new Tensor('int64', BigInt64Array.from([0n]), [1]),
    });

    const tensor = Object.values(output)[0];
    if (!tensor?.data) {
      throw new Error('Model returned no output tensor');
    }
    const embedding = Float32Array.from(tensor.data);

    // Validate against the configured dimensionality, never a literal: a
    // hardcoded number silently pins this module to one model.
    if (embedding.length !== LOCAL_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Expected ${LOCAL_EMBEDDING_DIMENSIONS} dimensions from ${LOCAL_EMBED_MODEL}, got ${embedding.length}`
      );
    }

    // The graph pools but does not normalize; every consumer treats cosine as a
    // dot product, so normalize here rather than at each call site.
    let norm = 0;
    for (const value of embedding) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0 || !Number.isFinite(norm)) {
      throw new Error('Model returned a zero or non-finite vector');
    }
    for (let i = 0; i < embedding.length; i++) embedding[i] /= norm;

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
  if (cachedModel) {
    try {
      await cachedModel.dispose();
    } catch {
      // Best-effort — ignore errors during disposal
    }
    cachedModel = null;
  }
  // The tokenizer holds no native handles, but clearing it keeps the "both set
  // or both null" invariant loadModel() checks.
  cachedTokenizer = null;
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
