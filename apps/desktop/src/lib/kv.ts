// Runtime memory sizing from a model's real GGUF architecture metadata.
//
// Two terms grow with context length:
//
//   KV cache      n_layers × n_kv_heads × (key_len + value_len) × 2      per token
//   compute buffer  n_batch × 4                                         per token
//
// The KV term is verified byte-exact against a live Ollama server by
// kv.verify.ts. The compute buffer is only the attention mask — see
// `computeBufferBytes` for why the attention-scores term isn't there.
//
// Neither term is the parameter count, which is what this module's predecessor
// bucketed on — exact on the Llama-3 family it was calibrated against, wrong by
// up to 5x elsewhere. `estimateKvBytesPerToken` keeps that old behaviour as the
// fallback for when metadata is unavailable.
//
// Pure and dependency-free, like fit.ts, so the selfcheck and the live verifier
// can both import it directly.
import type { ArchMeta } from "../types";

/**
 * Bytes per KV element. Ollama defaults to an f16 cache.
 * ponytail: halve/quarter this under `OLLAMA_KV_CACHE_TYPE=q8_0`/`q4_0`; Anchor
 * doesn't set that variable, so the default is the only case handled.
 */
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
 * `gemma4`'s 1/6 is confirmed against llama.cpp's own allocation lines, which
 * report `512 MiB (32768 cells, 4 layers)` global + `40 MiB (1024 cells, 20
 * layers)` local — i.e. 4:20 out of the 24 cached layers, the same 5:1 pattern
 * Gemma 3 publishes. The Gemma 2/3 ratios are from their published 1:1 and 5:1
 * patterns and have not been measured here.
 *
 * Do NOT re-derive these by differencing `/api/ps` size. gemma4's resident
 * figure swings ~6 GiB between loads because llama.cpp splits weights across
 * Metal and CPU based on free VRAM at load time (`CPU model buffer 5901 MiB /
 * MTL0 2829 MiB` on one load, all-GPU on the next) and `/api/ps` counts only
 * the GPU side. That noise buried this term's real 512 MiB and is what made an
 * earlier pass conclude, wrongly, that gemma4 had zero global layers.
 * ponytail: the only hardcoded table left; an architecture missing from it falls
 * back to an estimate rather than guessing.
 */
const GLOBAL_LAYER_FRACTION: Record<string, number> = {
  gemma2: 1 / 2,
  gemma3: 1 / 6,
  gemma3n: 1 / 6,
  gemma4: 1 / 6,
};

/**
 * Layers that actually hold a KV cache: `block_count` minus the layers that
 * reuse another's (`shared_kv_layers`). Gemma 4 shares 18 of 42, so 24 cache.
 *
 * This is the denominator `GLOBAL_LAYER_FRACTION` applies to — llama.cpp splits
 * the *cached* layers 1:5 global:local, not all `block_count` of them.
 */
function kvLayerCount(a: ArchMeta): number | null {
  if (!a.block_count) return null;
  return a.block_count - (a.shared_kv_layers ?? 0);
}

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
 * sliding window. Null when the metadata can't support an exact answer —
 * notably a missing layer or KV-head count. Ollama reports array-valued
 * metadata as JSON null, so `head_count_kv` is absent on models whose value
 * varies per layer (qwen3.5, a hybrid SSM/attention model), not only on old
 * GGUFs.
 */
export function metadataKvBytesPerToken(a: ArchMeta | null | undefined): number | null {
  if (!a) return null;
  // MLA (DeepSeek) caches one compressed latent plus the RoPE half per *layer*,
  // not per head — head_count_kv is deliberately absent from this branch. The
  // dense formula below would say 320 KiB/token for a 671B where the real
  // figure is 61 × (512 + 64) × 2 ≈ 69 KiB.
  if (a.kv_lora_rank) {
    if (!a.block_count || !a.rope_dimension_count) return null;
    return a.block_count * (a.kv_lora_rank + a.rope_dimension_count) * F16_BYTES;
  }
  const dims = headDims(a);
  const layers = kvLayerCount(a);
  if (!layers || !a.head_count_kv || !dims) return null;
  return layers * a.head_count_kv * (dims.k + dims.v) * F16_BYTES;
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
 * Bytes the inference graph holds alongside the weights and KV cache: the
 * attention mask, `n_batch × ctx` f32.
 *
 * This used to carry an `n_batch × n_head × ctx` attention-scores term as well,
 * which is what llama.cpp allocates *without* flash attention. Ollama enables
 * flash attention by default and it never materialises that matrix, so the term
 * over-predicted by 33x — 2.06 GiB against a real 64 MiB at 32k on llama3.2:1b.
 *
 * Measured: llama3.2:1b grows 34 KiB/token total, of which the KV cache is
 * exactly 32 KiB, leaving 2 KiB = `512 × 4`. gemma4 grows ~1 KiB/token, so this
 * is an upper bound on a term that tops out around 64 MiB.
 *
 * Architecture-independent, hence no `ArchMeta`: whether the scores buffer
 * exists is a property of the kernel Ollama chose, not of the model.
 * ponytail: revisit if Ollama ever ships with flash attention off by default.
 */
export function computeBufferBytes(contextLength: number): number {
  return contextLength * DEFAULT_BATCH * 4;
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

  const layers = kvLayerCount(arch)!;
  const globalLayers = Math.round(layers * globalFraction);
  const localLayers = layers - globalLayers;
  // llama.cpp sizes a windowed cache at the window plus one batch, so it can
  // hold the batch being processed alongside the tokens still in scope: gemma4
  // allocates 1024 cells against a declared 512-token window.
  const windowCells = Math.min(contextLength, arch.sliding_window + DEFAULT_BATCH);
  const bytes =
    globalLayers * perLayerToken(dims) * contextLength +
    localLayers * perLayerToken(swa) * windowCells;
  return { bytes, source: "metadata" };
}
