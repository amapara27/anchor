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
// Pure and dependency-free, like fit.ts, so the UI and the live verifier
// can both import it directly.
//
// MIRRORED IN RUST: `crates/anchor-core/src/fit.rs` carries the same math for
// the CLI (`anchor fit`) and anything else headless. The GUI keeps this copy
// because it recomputes on every context-slider tick, which an IPC round-trip
// would make janky. The same reference fixtures run through CLI and rendered
// inspector E2E flows. Change both engines, or neither.
import type { ArchMeta } from "../types";

/**
 * Bytes per KV element. Ollama defaults to an f16 cache.
 * ponytail: halve/quarter this under `OLLAMA_KV_CACHE_TYPE=q8_0`/`q4_0`; Anchor
 * doesn't set that variable, so the default is the only case handled.
 */
const F16_BYTES = 2;

/**
 * Ollama's batch size (`-b`/`-ub`) for a context. Sets both the compute
 * buffer's width and the padding on a sliding-window cache.
 *
 * Ollama 0.40 proposes 512 up to 4K, 1024 up to 32K and 2048 beyond
 * (`server/sched.go` `generationBatchForContext`), then steps down only when its
 * own memory estimate is tight against free memory at load time — which no API
 * predicts. Taking the proposal over-predicts under memory pressure, the safe
 * direction for a fit check.
 */
export function batchForContext(contextLength: number): number {
  return contextLength > 32768 ? 2048 : contextLength > 4096 ? 1024 : 512;
}

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

/** Cell granularity: llama.cpp pads every cache to a multiple of 256 cells. */
const CELL_PAD = 256;
const pad = (n: number) => Math.ceil(n / CELL_PAD) * CELL_PAD;

/**
 * Hardcoded sliding-window layouts, from each architecture's `load_hparams` in
 * llama.cpp (`load_swa_pattern(ml, N, dense_first)`). Layer `i` is windowed when
 * `i % N < N - 1` (every Nth layer global), or `i % N != 0` when dense-first;
 * N = 0 windows every layer. A GGUF `sliding_window_pattern` array overrides
 * the period — gemma4's differs by size (e2b 5, e4b 6). `window` is a span
 * llama.cpp forces regardless of the GGUF.
 *
 * Confirmed against llama.cpp's allocation lines, which name the layer counts:
 *   gemma2:2b   416 MiB ( 8192 cells, 13 layers) + 260 MiB (5120 cells, 13)
 *   gemma3:4b   160 MiB ( 8192 cells,  5 layers) + 232 MiB (2048 cells, 29)
 *   gemma4:e2b  192 MiB (32768 cells,  3 layers) +  18 MiB (1536 cells, 12)
 *
 * An architecture absent here with no pattern array is dense: llama.cpp ignores
 * a declared `sliding_window` it has no layout for (qwen2, mistral, phi3).
 * Do NOT re-derive layouts by differencing `/api/ps` size: llama.cpp re-splits
 * weights between Metal and CPU per load, swinging that figure by GiBs.
 */
const SWA_LAYOUT: Record<string, { period: number; denseFirst?: boolean; window?: number }> = {
  gemma2: { period: 2 },
  gemma3: { period: 6 },
  gemma3n: { period: 5 },
  gemma4: { period: 6 },
  "gpt-oss": { period: 2 },
  cohere2: { period: 4 },
  cohere2moe: { period: 4, denseFirst: true },
  smallthinker: { period: 4, denseFirst: true, window: 4096 },
  "exaone-moe": { period: 4 },
  exaone4: { period: 4 },
  olmo2: { period: 4 },
  // Chunked attention, 3 chunked : 1 full; same cache sizing as a window.
  llama4: { period: 4, window: 8192 },
  lfm2: { period: 0 },
  lfm2moe: { period: 0 },
};

/** The window span and per-layer windowed test, or null for a dense model. */
function swaLayout(a: ArchMeta): { window: number; isSwa: (i: number) => boolean } | null {
  const layout = a.architecture ? SWA_LAYOUT[a.architecture] : undefined;
  // exaone4 windows only its 32B (64-layer) variant; llama4 opts out with 0.
  if (a.architecture === "exaone4" && a.block_count !== 64) return null;
  if (a.architecture === "llama4" && a.sliding_window === 0) return null;
  const window = layout?.window ?? a.sliding_window ?? 0;
  if (window <= 0) return null;
  const pattern = a.sliding_window_pattern;
  if (pattern) return { window, isSwa: (i) => pattern[i] ?? false };
  if (!layout) return null;
  const n = layout.period;
  return {
    window,
    isSwa: (i) => n === 0 || (layout.denseFirst ? i % n !== 0 : i % n < n - 1),
  };
}

/**
 * Architectures llama.cpp runs with no KV cache at all: every layer recurrent.
 * ponytail: rwkv6/rwkv7 belong here too, but need their own state formula.
 */
const PURE_RECURRENT = new Set(["mamba", "mamba2"]);

/**
 * Ceiling on layer counts taken from a GGUF header. Real models stay under a
 * few hundred; a corrupt or hostile header must not drive a per-layer loop.
 */
const MAX_LAYERS = 4096;

/** Layers in the main model: MTP draft heads (`nextn_predict_layers`) excluded. */
function mainLayerCount(a: ArchMeta): number | null {
  if (!a.block_count || a.block_count > MAX_LAYERS) return null;
  return a.block_count - (a.nextn_predict_layers ?? 0);
}

/**
 * Layers that actually hold a KV cache: main layers minus those that reuse
 * another's (`shared_kv_layers`). The owners are the *first* layers — gemma4:e2b
 * caches 15 of 35, and the window pattern is read over those 15. gemma3n
 * hardcodes 20 owners in llama.cpp rather than reading the key.
 */
function kvLayerCount(a: ArchMeta): number | null {
  const n = mainLayerCount(a);
  if (n === null) return null;
  if (a.architecture === "gemma3n" && a.shared_kv_layers == null) return Math.min(n, 20);
  return n - (a.shared_kv_layers ?? 0);
}

/**
 * KV heads per main layer, 0 on layers without attention.
 *
 * Hybrid SSM/attention models hold KV only on their attention layers. Three
 * encodings mark those, all seen in the wild: a `recurrent_layers` bool array
 * (qwen3.5:0.8b), a per-layer `head_count_kv` array with 0 on recurrent layers
 * (qwen3.5:9b, granite4-h, lfm2), or just `full_attention_interval` (every Nth
 * layer attends). Null when the KV-head count is unknown.
 */
function layerHeads(a: ArchMeta, from: number, to: number): number[] | null {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    let heads = a.head_count_kv_layers?.[i] ?? a.head_count_kv;
    if (heads == null) return null;
    if (a.recurrent_layers) {
      if (a.recurrent_layers[i]) heads = 0;
    } else if (!a.head_count_kv_layers && a.full_attention_interval) {
      if ((i + 1) % a.full_attention_interval !== 0) heads = 0;
    }
    out.push(heads);
  }
  return out;
}

/** One layer that owns a KV cache: its KV heads, and whether it is windowed. */
interface CacheLayer {
  heads: number;
  swa: boolean;
}

/** Every cache-owning layer, or null when the metadata can't say. */
function cacheLayers(a: ArchMeta): CacheLayer[] | null {
  const n = kvLayerCount(a);
  if (!n || n <= 0) return null;
  return layersIn(a, 0, n);
}

/**
 * A draft model's cache-owning layers. llama.cpp runs a drafter as an MTP
 * context, which caches only its trailing `nextn_predict_layers` layers and
 * ignores `shared_kv_layers`: qwen3.5's drafter (25 layers, 1 nextn) caches one
 * attention layer, gemma4-assistant (4 of 4 nextn) caches all four.
 */
function draftCacheLayers(d: ArchMeta): CacheLayer[] | null {
  if (!d.block_count || d.block_count > MAX_LAYERS) return null;
  const nextn = Math.min(d.nextn_predict_layers ?? d.block_count, d.block_count);
  return layersIn(d, d.block_count - nextn, d.block_count);
}

function layersIn(a: ArchMeta, from: number, to: number): CacheLayer[] | null {
  const heads = layerHeads(a, from, to);
  if (!heads || !heads.some((h) => h > 0)) return null;
  const layout = swaLayout(a);
  return heads.map((h, j) => ({ heads: h, swa: layout?.isSwa(from + j) ?? false }));
}

/**
 * MLA models whose GGUF carries `key_length_mla`/`value_length_mla` cache the
 * compressed latent: llama.cpp allocates K only (`has_v = !is_mla`), at
 * `head_count_kv × key_length`. Older GGUFs without those keys (Ollama's
 * deepseek-v2) take the decompressed path the dense formula already covers.
 */
const isMla = (a: ArchMeta) => !!(a.key_length_mla && a.value_length_mla);

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
 * notably a missing layer or KV-head count.
 */
export function metadataKvBytesPerToken(raw: ArchMeta | null | undefined): number | null {
  if (!raw) return null;
  const a = ollamaCompat(raw);
  if (a.architecture && PURE_RECURRENT.has(a.architecture)) return 0;
  // MLA without the `_mla` keys (deepseek-v2 from Ollama's library) needs no
  // special case: llama.cpp caches the decompressed per-head K/V, so the dense
  // formula is exact — 27 × 16 × (192 + 128) × 2 = 270 KiB/token, matching
  // `size = 1080.00 MiB (4096 cells, 27 layers)` on Ollama 0.40.15.
  const dims = headDims(a);
  const layers = cacheLayers(a);
  if (!layers || !dims) return null;
  const width = isMla(a) ? dims.k : dims.k + dims.v;
  return layers.reduce((sum, l) => sum + l.heads, 0) * width * F16_BYTES;
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
 * Measured directly from llama.cpp's `compute buffer size` lines on llama3.2:1b
 * at n_batch=1024: 160.04 MiB at 8k and 256.04 MiB at 32k, a slope of exactly
 * 4096 bytes/token = `n_batch × 4`. The ~128 MiB intercept is context-
 * independent graph overhead and belongs to the fixed reserve, not here.
 *
 * Architecture-independent, hence no `ArchMeta`: whether the scores buffer
 * exists is a property of the kernel Ollama chose, not of the model. The log
 * says which — `llama_context: flash_attn = auto` resolving to
 * `resolve_fused_ops: Flash Attention enabled` is the case modelled here.
 * ponytail: revisit if Ollama ever ships with flash attention off by default;
 * kv.verify.ts warns when a load reports it disabled.
 */
export function computeBufferBytes(contextLength: number): number {
  return contextLength * batchForContext(contextLength) * 4;
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
  const estimated = (): KvEstimate => ({
    bytes: contextLength * estimateKvBytesPerToken(params_b),
    source: "estimated",
  });
  if (arch?.architecture && PURE_RECURRENT.has(arch.architecture)) return { bytes: 0, source: "metadata" };
  if (arch) arch = ollamaCompat(arch);
  const layers = arch ? cacheLayers(arch) : null;
  const dims = arch ? headDims(arch) : null;
  if (!arch || !layers || !dims) return estimated();
  return { bytes: layerBytes(arch, layers, dims, contextLength), source: "metadata" };
}

/** KV bytes of `layers` at a context length. */
function layerBytes(arch: ArchMeta, layers: CacheLayer[], dims: { k: number; v: number }, contextLength: number): number {
  // Windowed layers can carry narrower heads than the full-attention ones.
  const swaDims =
    arch.key_length_swa && arch.value_length_swa
      ? { k: arch.key_length_swa, v: arch.value_length_swa }
      : dims;
  const width = (d: { k: number; v: number }) => (isMla(arch) ? d.k : d.k + d.v);
  // llama.cpp pads the context to 256 cells, and sizes a windowed cache at the
  // window plus one micro-batch, so it can hold the batch being processed
  // alongside the tokens still in scope: gemma4 allocates 1536 cells against a
  // 512-token window at batch 1024. A window wider than the context never binds.
  const cells = pad(contextLength);
  const windowCells = pad(Math.min(cells, (swaLayout(arch)?.window ?? 0) + batchForContext(contextLength)));
  let bytes = 0;
  for (const l of layers) {
    bytes += l.swa
      ? l.heads * width(swaDims) * F16_BYTES * windowCells
      : l.heads * width(dims) * F16_BYTES * cells;
  }
  return bytes;
}

/**
 * KV bytes of the speculative draft model, 0 when there is none or its
 * metadata can't say. gemma4-assistant allocates nothing: llama.cpp aliases its
 * layers onto the target's last two (`sharing with layer 34`). Verified on
 * gemma4:e2b's and qwen3.5:0.8b's drafters.
 */
export function draftKvCacheBytes(arch: ArchMeta | null | undefined, contextLength: number): number {
  const d = arch?.draft;
  if (d?.architecture === "gemma4-assistant") return 0;
  const layers = d ? draftCacheLayers(d) : null;
  const dims = d ? headDims(d) : null;
  return d && layers && dims ? layerBytes(d, layers, dims, contextLength) : 0;
}

/**
 * Ollama's default `draft_num_predict` (`--spec-draft-n-max`) when a model's
 * parameters don't set one; qwen3.5:0.8b sets 2, gemma4:e2b 3.
 */
const DRAFT_N_MAX = 4;

/**
 * Bytes of recurrent (SSM) state on hybrid and recurrent models: f32, fixed in
 * size, independent of context. llama.cpp allocates one row per recurrent layer
 * per sequence (`llama_memory_recurrent`):
 *
 *   Mamba family  (d_conv − 1)·(d_inner + 2·n_group·d_state) + d_state·d_inner
 *   LFM2          n_embd·(l_cache − 1)
 *
 * While a drafter is loaded llama-server keeps `n_max` extra rows per sequence
 * to roll back rejected drafts (`1 + n_rs_seq`). Verified on qwen3.5:0.8b:
 * 18 layers × 280,576 floats × 4 B = 19.27 MiB, × 3 = 57.80 MiB with its drafter.
 * 0 when the architecture or its keys are unknown.
 * ponytail: nemotron_h (needs per-layer feed_forward_length), rwkv and kimi
 * linear are uncounted.
 */
export function recurrentStateBytes(a: ArchMeta | null | undefined): number {
  const arch = a?.architecture;
  const n = a ? mainLayerCount(a) : null;
  if (!a || !arch || !n) return 0;
  let layers: number;
  if (PURE_RECURRENT.has(arch) || arch === "falcon-h1") layers = n;
  else if (RECURRENT_WHERE_NO_KV.has(arch)) layers = (layerHeads(a, 0, n) ?? []).filter((h) => h === 0).length;
  else return 0;
  let floats = 0;
  if (arch === "lfm2" || arch === "lfm2moe") {
    if (a.embedding_length && a.shortconv_l_cache) floats = a.embedding_length * (a.shortconv_l_cache - 1);
  } else if (a.ssm_conv_kernel && a.ssm_inner_size && a.ssm_state_size) {
    const groups = a.ssm_group_count ?? 0;
    floats =
      (a.ssm_conv_kernel - 1) * (a.ssm_inner_size + 2 * groups * a.ssm_state_size) +
      a.ssm_state_size * a.ssm_inner_size;
  }
  // Only architectures llama.cpp can roll back (`llm_arch_supports_rs_rollback`)
  // keep the extra rows; elsewhere `n_rs_seq` is clamped to 0.
  const rollback = !!a.draft && (arch === "qwen35" || arch === "qwen35moe");
  return layers * floats * 4 * (rollback ? 1 + (a.draft_num_predict ?? DRAFT_N_MAX) : 1);
}

/**
 * Ollama's load-time shim (`llama/compat/llama-ollama-compat.cpp`) rewrites its
 * own `glm4moelite` GGUFs into llama.cpp's `deepseek2` MLA layout: one KV head,
 * `key_length` = the latent width (`kv_lora_rank + rope`, Ollama's
 * `key_length_mla`), and the per-head dims moved to the `_mla` keys. The cache
 * is then the K-only latent.
 */
function ollamaCompat(a: ArchMeta): ArchMeta {
  if (a.architecture !== "glm4moelite") return a;
  return {
    ...a,
    head_count_kv: 1,
    head_count_kv_layers: null,
    key_length: a.key_length_mla ?? null,
    value_length: a.value_length_mla ?? null,
    key_length_mla: a.key_length,
    value_length_mla: a.value_length,
  };
}

/** Hybrids whose recurrent layers are exactly the ones without KV heads. */
const RECURRENT_WHERE_NO_KV = new Set([
  "qwen35", "qwen35moe", "qwen3next", "jamba", "granitehybrid", "plamo2", "lfm2", "lfm2moe",
]);
