// Runtime memory sizing from a model's real GGUF architecture metadata.
//
// Two terms grow with context length, and both are verified byte-exact against
// a live Ollama server by kv.verify.ts:
//
//   KV cache      n_layers × n_kv_heads × (key_len + value_len) × 2      per token
//   compute buffer  n_batch × 4 × (n_head + 1)                          per token
//
// None of those terms is the parameter count, which is what this module's
// predecessor bucketed on — exact on the Llama-3 family it was calibrated
// against, wrong by up to 5x elsewhere. `estimateKvBytesPerToken` keeps that
// old behaviour as the fallback for when metadata is unavailable.
//
// The compute buffer is not a rounding error: on llama3.2:1b it is *twice* the
// KV cache (2.1 GiB vs 1.0 GiB at 32k context). Omitting it — as the fit math
// previously did — understates long-context memory by more than half.
//
// Pure and dependency-free, like fit.ts, so the selfcheck and the live verifier
// can both import it directly.
import type { ArchMeta } from "../types";

/** Bytes per KV element. Ollama defaults to an f16 cache. */
const F16_BYTES = 2;

/**
 * Ollama's default batch size (`num_batch`), which sets the compute buffer's
 * width. Not exposed in any API response, so it's mirrored here.
 * ponytail: bump if Ollama's default changes; kv.verify.ts catches it.
 */
const DEFAULT_BATCH = 512;

/**
 * How a memory figure was arrived at:
 * - `metadata`: computed from the model's own architecture fields — trustworthy.
 * - `estimated`: bucketed from parameter count because metadata was missing or
 *   didn't describe this architecture. Label it as an estimate in the UI.
 */
export type KvSource = "metadata" | "estimated";

export interface KvEstimate {
  bytes: number;
  source: KvSource;
}

/**
 * Fraction of a sliding-window model's layers that keep a full-context KV cache;
 * the rest never exceed `sliding_window` tokens.
 *
 * GGUF carries `sliding_window` but the layer *pattern* is array-valued, and
 * Ollama serialises array metadata as JSON null — so it never reaches us and has
 * to be known per architecture.
 *
 * `gemma4` is measured (kv.verify.ts sees exactly zero KV growth past the
 * window). The Gemma 2/3 ratios are from their published 1:1 and 5:1
 * local-to-global layer patterns and have not been measured here.
 * ponytail: the only hardcoded table left; an architecture missing from it falls
 * back to an estimate rather than guessing.
 */
const GLOBAL_LAYER_FRACTION: Record<string, number> = {
  gemma2: 1 / 2,
  gemma3: 1 / 6,
  gemma3n: 1 / 6,
  gemma4: 0,
};

/** Per-head key/value dims, preferring explicit lengths over hidden/heads. */
function headDims(a: ArchMeta): { k: number; v: number } | null {
  if (a.key_length && a.value_length) return { k: a.key_length, v: a.value_length };
  // Fallback: square heads derived from hidden size. Only needed for models that
  // omit the explicit lengths, which modern GGUFs generally carry.
  if (a.embedding_length && a.head_count) {
    const d = a.embedding_length / a.head_count;
    return { k: d, v: d };
  }
  return null;
}

/**
 * KV bytes per token of context, from architecture metadata, ignoring any
 * sliding window. Null when the metadata can't support an exact answer:
 *
 * - a missing layer or KV-head count — note Ollama reports array-valued
 *   metadata as JSON null, so `head_count_kv` is absent on models whose value
 *   varies per layer (qwen3.5), not only on old GGUFs;
 * - an MLA model (DeepSeek), whose compressed latent cache this formula does
 *   not describe and would badly over-report.
 */
export function metadataKvBytesPerToken(a: ArchMeta | null | undefined): number | null {
  if (!a || a.kv_lora_rank) return null;
  const dims = headDims(a);
  if (!a.block_count || !a.head_count_kv || !dims) return null;
  return a.block_count * a.head_count_kv * (dims.k + dims.v) * F16_BYTES;
}

/**
 * Fallback KV bytes per token, bucketed by parameter count.
 *
 * Seeded from typical Llama-3-family GQA architectures, which it matches
 * exactly; treat everything else as a rough lower bound. Only reached when a
 * model's architecture metadata is unavailable.
 */
export function estimateKvBytesPerToken(params_b: number): number {
  if (params_b <= 2) return 48 * 1024;
  if (params_b <= 4) return 80 * 1024;
  if (params_b <= 9) return 128 * 1024;
  if (params_b <= 16) return 192 * 1024;
  if (params_b <= 34) return 256 * 1024;
  return 320 * 1024;
}

/**
 * Bytes the inference graph holds alongside the weights and KV cache.
 *
 * Without flash attention llama.cpp materialises the attention scores for a
 * whole batch — `n_batch × n_head × ctx` floats — plus a `n_batch × ctx` mask.
 * Both scale linearly with context, so this does not wash out of a memory
 * budget the way a fixed overhead would.
 *
 * Returns 0 when the head count is unknown; the caller then under-reports
 * rather than inventing a number.
 */
export function computeBufferBytes(
  arch: ArchMeta | null | undefined,
  contextLength: number,
): number {
  if (!arch?.head_count) return 0;
  return contextLength * DEFAULT_BATCH * 4 * (arch.head_count + 1);
}

/**
 * Total KV-cache bytes at a context length.
 *
 * On sliding-window architectures most layers only ever hold `sliding_window`
 * tokens, so their cost stops growing once context passes the window and only
 * the full-attention layers keep scaling. Treating every layer as full-context
 * overstates a Gemma-class model several-fold at long context.
 */
export function kvCacheBytes(
  arch: ArchMeta | null | undefined,
  contextLength: number,
  params_b: number,
): KvEstimate {
  const perToken = metadataKvBytesPerToken(arch);
  if (perToken === null || !arch) {
    return { bytes: contextLength * estimateKvBytesPerToken(params_b), source: "estimated" };
  }
  if (!arch.sliding_window) {
    return { bytes: contextLength * perToken, source: "metadata" };
  }

  // Windowed model: we need to know how many layers escape the window.
  const globalFraction = arch.architecture
    ? GLOBAL_LAYER_FRACTION[arch.architecture]
    : undefined;
  if (globalFraction === undefined) {
    return { bytes: contextLength * estimateKvBytesPerToken(params_b), source: "estimated" };
  }

  const dims = headDims(arch)!;
  // Windowed layers can carry narrower heads than the full-attention ones.
  const swa =
    arch.key_length_swa && arch.value_length_swa
      ? { k: arch.key_length_swa, v: arch.value_length_swa }
      : dims;
  const perLayerToken = (d: { k: number; v: number }) =>
    arch.head_count_kv! * (d.k + d.v) * F16_BYTES;

  const globalLayers = Math.round(arch.block_count! * globalFraction);
  const localLayers = arch.block_count! - globalLayers;
  const bytes =
    globalLayers * perLayerToken(dims) * contextLength +
    localLayers * perLayerToken(swa) * Math.min(contextLength, arch.sliding_window);
  return { bytes, source: "metadata" };
}
