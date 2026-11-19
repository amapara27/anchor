//! Runtime memory sizing: KV cache, weights, and whether a model fits the host.
//!
//! **Mirror of `apps/desktop/src/lib/kv.ts` + `fit.ts` + `quant.ts`.** The GUI
//! recomputes this live as the context slider moves, so it keeps its own pure-TS
//! copy rather than paying an IPC round-trip per tick; this is the same math for
//! the CLI and anything else headless. The two are pinned together by fixtures:
//! `tests/e2e/fixtures/fit.json` is exercised through the CLI and rendered GUI.
//! Change both engines, or neither.
//!
//! Two terms grow with context length:
//!
//!   KV cache        n_layers × n_kv_heads × (key_len + value_len) × 2   per token
//!   compute buffer  n_batch × 4                                        per token
//!
//! Neither is the parameter count, which is what a naive estimate buckets on —
//! wrong by up to 8x on MHA models. [`estimate_kv_bytes_per_token`] keeps that
//! bucketing as the fallback for when architecture metadata is unavailable.
//!
//! Pure and dependency-free (serde aside), like the TS it mirrors.

use serde::{Deserialize, Serialize};

use crate::ArchMeta;

/// Bytes per KV element. Ollama defaults to an f16 cache.
/// ponytail: halve/quarter this under `OLLAMA_KV_CACHE_TYPE=q8_0`/`q4_0`; Anchor
/// doesn't set that variable, so the default is the only case handled.
const F16_BYTES: u64 = 2;

/// Ollama's batch size (`-b`/`-ub`) for a context. Sets both the compute
/// buffer's width and the padding on a sliding-window cache.
///
/// Ollama 0.40 proposes 512 up to 4K, 1024 up to 32K and 2048 beyond
/// (`server/sched.go` `generationBatchForContext`), then steps down only when its
/// own memory estimate is tight against free memory at load time — which no API
/// predicts. Taking the proposal over-predicts under memory pressure, the safe
/// direction for a fit check.
pub fn batch_for_context(context_length: u64) -> u64 {
    match context_length {
        c if c > 32768 => 2048,
        c if c > 4096 => 1024,
        _ => 512,
    }
}

/// Context length to judge at-a-glance fit at. Ollama loads a model with a small
/// default `num_ctx` (~4K), NOT its advertised maximum — a 128K-context model's
/// KV cache at full length can exceed total RAM and falsely read "won't fit".
/// ponytail: mirrors Ollama's num_ctx default; bump if that default changes.
pub const DEFAULT_CONTEXT: u64 = 4096;

/// Headroom below this fraction of total memory counts as a "tight" fit.
const TIGHT_HEADROOM_RATIO: f64 = 0.15;

const GIB: f64 = (1024 * 1024 * 1024) as f64;

/// Cell granularity: llama.cpp pads every cache to a multiple of 256 cells.
const CELL_PAD: u64 = 256;

fn pad(n: u64) -> u64 {
    n.div_ceil(CELL_PAD) * CELL_PAD
}

/// A hardcoded sliding-window layout from llama.cpp's `load_swa_pattern(ml, N,
/// dense_first)`. Mirrors `SWA_LAYOUT` in kv.ts, where each entry is sourced.
struct SwaLayout {
    period: u64,
    dense_first: bool,
    /// A span llama.cpp forces regardless of the GGUF.
    window: Option<u64>,
}

/// Layer `i` is windowed when `i % N < N - 1` (every Nth layer global), or
/// `i % N != 0` when dense-first; N = 0 windows every layer. A GGUF
/// `sliding_window_pattern` array overrides the period — gemma4's differs by
/// size (e2b 5, e4b 6). Confirmed against llama.cpp's allocation lines (gemma2:2b
/// 13+13 layers, gemma3:4b 5+29, gemma4:e2b 3+12). An architecture absent here
/// with no array is dense: llama.cpp ignores a `sliding_window` it has no layout
/// for (qwen2, mistral, phi3).
fn swa_table(architecture: &str) -> Option<SwaLayout> {
    let (period, dense_first, window) = match architecture {
        "gemma2" | "gpt-oss" => (2, false, None),
        "gemma3" | "gemma4" => (6, false, None),
        "gemma3n" => (5, false, None),
        "cohere2" | "exaone-moe" | "exaone4" | "olmo2" => (4, false, None),
        "cohere2moe" => (4, true, None),
        "smallthinker" => (4, true, Some(4096)),
        // Chunked attention, 3 chunked : 1 full; same cache sizing as a window.
        "llama4" => (4, false, Some(8192)),
        "lfm2" | "lfm2moe" => (0, false, None),
        _ => return None,
    };
    Some(SwaLayout { period, dense_first, window })
}

/// Whether layer `i` is windowed.
type IsSwa<'a> = Box<dyn Fn(u64) -> bool + 'a>;

/// The window span and which layers it applies to; `None` for a dense model.
fn swa_layout(a: &ArchMeta) -> Option<(u64, IsSwa<'_>)> {
    let arch = a.architecture.as_deref().unwrap_or("");
    // exaone4 windows only its 32B (64-layer) variant; llama4 opts out with 0.
    if (arch == "exaone4" && a.block_count != Some(64)) || (arch == "llama4" && a.sliding_window == Some(0)) {
        return None;
    }
    let layout = swa_table(arch);
    let window = layout.as_ref().and_then(|l| l.window).or(a.sliding_window).filter(|&w| w > 0)?;
    if let Some(pattern) = &a.sliding_window_pattern {
        return Some((window, Box::new(move |i| pattern.get(i as usize).copied().unwrap_or(false))));
    }
    let SwaLayout { period: n, dense_first, .. } = layout?;
    Some((
        window,
        Box::new(move |i| n == 0 || if dense_first { i % n != 0 } else { i % n < n - 1 }),
    ))
}

/// Architectures llama.cpp runs with no KV cache at all: every layer recurrent.
/// ponytail: rwkv6/rwkv7 belong here too, but need their own state formula.
const PURE_RECURRENT: &[&str] = &["mamba", "mamba2"];

/// Ollama's load-time shim (`llama/compat/llama-ollama-compat.cpp`) rewrites its
/// own `glm4moelite` GGUFs into llama.cpp's `deepseek2` MLA layout: one KV head,
/// `key_length` = the latent width (`kv_lora_rank + rope`, Ollama's
/// `key_length_mla`), and the per-head dims moved to the `_mla` keys. The cache
/// is then the K-only latent.
fn ollama_compat(a: &ArchMeta) -> std::borrow::Cow<'_, ArchMeta> {
    if a.architecture.as_deref() != Some("glm4moelite") {
        return std::borrow::Cow::Borrowed(a);
    }
    std::borrow::Cow::Owned(ArchMeta {
        head_count_kv: Some(1),
        head_count_kv_layers: None,
        key_length: a.key_length_mla,
        value_length: a.value_length_mla,
        key_length_mla: a.key_length,
        value_length_mla: a.value_length,
        ..a.clone()
    })
}

/// Hybrids whose recurrent layers are exactly the ones without KV heads.
const RECURRENT_WHERE_NO_KV: &[&str] = &[
    "qwen35", "qwen35moe", "qwen3next", "jamba", "granitehybrid", "plamo2", "lfm2", "lfm2moe",
];

fn is_pure_recurrent(a: &ArchMeta) -> bool {
    a.architecture.as_deref().is_some_and(|x| PURE_RECURRENT.contains(&x))
}

/// MLA models whose GGUF carries `key_length_mla`/`value_length_mla` cache the
/// compressed latent: llama.cpp allocates K only (`has_v = !is_mla`), at
/// `head_count_kv × key_length`. Older GGUFs without those keys (Ollama's
/// deepseek-v2) take the decompressed path the dense formula already covers.
fn is_mla(a: &ArchMeta) -> bool {
    a.key_length_mla.is_some_and(|k| k > 0) && a.value_length_mla.is_some_and(|v| v > 0)
}

/// How a memory figure was arrived at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KvSource {
    /// Computed from the model's own architecture fields — trustworthy.
    Metadata,
    /// Bucketed from parameter count because metadata was missing or didn't
    /// describe this architecture. Label it as an estimate in any UI.
    Estimated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvEstimate {
    pub bytes: u64,
    pub source: KvSource,
}

/// Ceiling on layer counts taken from a GGUF header. Real models stay under a
/// few hundred; a corrupt or hostile header must not drive a per-layer loop.
const MAX_LAYERS: u64 = 4096;

/// Layers in the main model: MTP draft heads (`nextn_predict_layers`) excluded.
fn main_layer_count(a: &ArchMeta) -> Option<u64> {
    let blocks = a.block_count.filter(|&b| b <= MAX_LAYERS)?;
    Some(blocks.saturating_sub(a.nextn_predict_layers.unwrap_or(0)))
}

/// Layers that actually hold a KV cache: main layers minus those that reuse
/// another's (`shared_kv_layers`). The owners are the *first* layers — gemma4:e2b
/// caches 15 of 35, and the window pattern is read over those 15. gemma3n
/// hardcodes 20 owners in llama.cpp rather than reading the key.
fn kv_layer_count(a: &ArchMeta) -> Option<u64> {
    let n = main_layer_count(a)?;
    if a.architecture.as_deref() == Some("gemma3n") && a.shared_kv_layers.is_none() {
        return Some(n.min(20));
    }
    Some(n.saturating_sub(a.shared_kv_layers.unwrap_or(0)))
}

/// KV heads per main layer, 0 on layers without attention.
///
/// Hybrid SSM/attention models hold KV only on their attention layers. Three
/// encodings mark those, all seen in the wild: a `recurrent_layers` bool array
/// (qwen3.5:0.8b), a per-layer `head_count_kv` array with 0 on recurrent layers
/// (qwen3.5:9b, granite4-h, lfm2), or just `full_attention_interval` (every Nth
/// layer attends). `None` when the KV-head count is unknown.
fn layer_heads(a: &ArchMeta, layers: std::ops::Range<u64>) -> Option<Vec<u64>> {
    layers
        .map(|i| {
            let idx = i as usize;
            let heads = a
                .head_count_kv_layers
                .as_ref()
                .and_then(|h| h.get(idx).copied())
                .or(a.head_count_kv)?;
            let attends = match (&a.recurrent_layers, &a.head_count_kv_layers, a.full_attention_interval) {
                (Some(recurrent), _, _) => !recurrent.get(idx).copied().unwrap_or(false),
                (None, None, Some(every)) if every > 0 => (i + 1) % every == 0,
                _ => true,
            };
            Some(if attends { heads } else { 0 })
        })
        .collect()
}

/// One layer that owns a KV cache.
struct CacheLayer {
    heads: u64,
    swa: bool,
}

/// Every cache-owning layer, or `None` when the metadata can't say.
fn cache_layers(a: &ArchMeta) -> Option<Vec<CacheLayer>> {
    let n = kv_layer_count(a).filter(|&n| n > 0)?;
    layers_in(a, 0..n)
}

/// A draft model's cache-owning layers. llama.cpp runs a drafter as an MTP
/// context, which caches only its trailing `nextn_predict_layers` layers and
/// ignores `shared_kv_layers`: qwen3.5's drafter (25 layers, 1 nextn) caches one
/// attention layer, gemma4-assistant (4 of 4 nextn) caches all four.
fn draft_cache_layers(d: &ArchMeta) -> Option<Vec<CacheLayer>> {
    let blocks = d.block_count.filter(|&b| b > 0 && b <= MAX_LAYERS)?;
    let nextn = d.nextn_predict_layers.unwrap_or(blocks).min(blocks);
    layers_in(d, blocks - nextn..blocks)
}

fn layers_in(a: &ArchMeta, range: std::ops::Range<u64>) -> Option<Vec<CacheLayer>> {
    let heads = layer_heads(a, range.clone())?;
    if !heads.iter().any(|&h| h > 0) {
        return None;
    }
    let layout = swa_layout(a);
    Some(
        range
            .zip(heads)
            .map(|(i, heads)| CacheLayer {
                heads,
                swa: layout.as_ref().is_some_and(|(_, is_swa)| is_swa(i)),
            })
            .collect(),
    )
}

/// Per-head key/value dims, preferring explicit lengths over hidden/heads.
fn head_dims(a: &ArchMeta) -> Option<(u64, u64)> {
    if let (Some(k), Some(v)) = (a.key_length, a.value_length) {
        return Some((k, v));
    }
    // Fallback: square heads derived from hidden size. Only needed for models
    // that omit the explicit lengths, which modern GGUFs generally carry.
    match (a.embedding_length, a.head_count) {
        (Some(embed), Some(heads)) if heads > 0 => Some((embed / heads, embed / heads)),
        _ => None,
    }
}

/// KV bytes per token of context, from architecture metadata, ignoring any
/// sliding window. `None` when the metadata can't support an exact answer —
/// notably a missing layer or KV-head count.
///
/// MLA without the `_mla` keys (deepseek-v2 from Ollama's library) needs no
/// special case: llama.cpp caches the decompressed per-head K/V, so the dense
/// formula is exact — 27 × 16 × (192 + 128) × 2 = 270 KiB/token, matching
/// `size = 1080.00 MiB (4096 cells, 27 layers)` on Ollama 0.40.15.
pub fn metadata_kv_bytes_per_token(arch: Option<&ArchMeta>) -> Option<u64> {
    let a = &*ollama_compat(arch?);
    if is_pure_recurrent(a) {
        return Some(0);
    }
    let (k, v) = head_dims(a)?;
    let heads = cache_layers(a)?.iter().fold(0, |sum: u64, l| sum.saturating_add(l.heads));
    let width = if is_mla(a) { k } else { k.saturating_add(v) };
    Some(heads.saturating_mul(width).saturating_mul(F16_BYTES))
}

/// Fallback KV bytes per token, bucketed by parameter count.
///
/// Seeded from typical Llama-3-family GQA architectures, which it matches
/// exactly; treat everything else as a rough lower bound. Only reached when a
/// model's architecture metadata is unavailable.
pub fn estimate_kv_bytes_per_token(params_b: f64) -> u64 {
    let kib = 1024;
    match params_b {
        p if p <= 2.0 => 48 * kib,
        p if p <= 4.0 => 80 * kib,
        p if p <= 9.0 => 128 * kib,
        p if p <= 16.0 => 192 * kib,
        p if p <= 34.0 => 256 * kib,
        _ => 320 * kib,
    }
}

/// Bytes the inference graph holds alongside the weights and KV cache: the
/// attention mask, `n_batch × ctx` f32.
///
/// Ollama enables flash attention by default, which never materialises the
/// `n_batch × n_head × ctx` attention-scores matrix llama.cpp would otherwise
/// allocate — including that term over-predicted by 33x. Measured from
/// llama.cpp's `compute buffer size` lines on llama3.2:1b at n_batch=1024:
/// 160.04 MiB at 8k and 256.04 MiB at 32k, a slope of exactly 4096 bytes/token.
/// ponytail: revisit if Ollama ever ships with flash attention off by default.
pub fn compute_buffer_bytes(context_length: u64) -> u64 {
    context_length * batch_for_context(context_length) * 4
}

/// Total KV-cache bytes at a context length.
///
/// On sliding-window architectures most layers only ever hold `sliding_window`
/// tokens, so their cost stops growing once context passes the window and only
/// the full-attention layers keep scaling. Treating every layer as full-context
/// overstates a Gemma-class model several-fold at long context.
pub fn kv_cache_bytes(arch: Option<&ArchMeta>, context_length: u64, params_b: f64) -> KvEstimate {
    let estimated = || KvEstimate {
        bytes: context_length * estimate_kv_bytes_per_token(params_b),
        source: KvSource::Estimated,
    };
    if arch.is_some_and(is_pure_recurrent) {
        return KvEstimate { bytes: 0, source: KvSource::Metadata };
    }
    let compat = arch.map(ollama_compat);
    let Some((arch, layers, (k, v))) = compat.as_deref().and_then(|a| Some((a, cache_layers(a)?, head_dims(a)?))) else {
        return estimated();
    };
    KvEstimate {
        bytes: layer_bytes(arch, &layers, (k, v), context_length),
        source: KvSource::Metadata,
    }
}

/// KV bytes of `layers` at a context length.
fn layer_bytes(arch: &ArchMeta, layers: &[CacheLayer], (k, v): (u64, u64), context_length: u64) -> u64 {
    // Windowed layers can carry narrower heads than the full-attention ones.
    let swa_dims = match (arch.key_length_swa, arch.value_length_swa) {
        (Some(ks), Some(vs)) => (ks, vs),
        _ => (k, v),
    };
    // Saturating: every factor comes from an untrusted header, and a wrapped
    // product would read as a tiny cache — a false "fits".
    let width = |(k, v): (u64, u64)| if is_mla(arch) { k } else { k.saturating_add(v) };
    // llama.cpp pads the context to 256 cells, and sizes a windowed cache at the
    // window plus one micro-batch, so it can hold the batch being processed
    // alongside the tokens still in scope: gemma4 allocates 1536 cells against a
    // 512-token window at batch 1024. A window wider than the context never binds.
    let cells = pad(context_length);
    let window = swa_layout(arch).map_or(0, |(w, _)| w);
    let window_cells = pad(cells.min(window + batch_for_context(context_length)));
    layers
        .iter()
        .map(|l| {
            let (w, n) = if l.swa { (width(swa_dims), window_cells) } else { (width((k, v)), cells) };
            l.heads.saturating_mul(w).saturating_mul(F16_BYTES).saturating_mul(n)
        })
        .fold(0, u64::saturating_add)
}

/// KV bytes of the speculative draft model, 0 when there is none or its
/// metadata can't say. gemma4-assistant allocates nothing: llama.cpp aliases its
/// layers onto the target's last two (`sharing with layer 34`). Verified on
/// gemma4:e2b's and qwen3.5:0.8b's drafters.
pub fn draft_kv_cache_bytes(arch: Option<&ArchMeta>, context_length: u64) -> u64 {
    let Some(d) = arch.and_then(|a| a.draft.as_deref()) else {
        return 0;
    };
    if d.architecture.as_deref() == Some("gemma4-assistant") {
        return 0;
    }
    match (draft_cache_layers(d), head_dims(d)) {
        (Some(layers), Some(dims)) => layer_bytes(d, &layers, dims, context_length),
        _ => 0,
    }
}

/// Bytes of recurrent (SSM) state on hybrid and recurrent models: f32, fixed in
/// size, independent of context. llama.cpp allocates one row per recurrent layer
/// per sequence (`llama_memory_recurrent`):
///
///   Mamba family  (d_conv − 1)·(d_inner + 2·n_group·d_state) + d_state·d_inner
///   LFM2          n_embd·(l_cache − 1)
///
/// While a drafter is loaded llama-server keeps `n_max` extra rows per sequence
/// to roll back rejected drafts (`1 + n_rs_seq`). Verified on qwen3.5:0.8b:
/// 18 layers × 280,576 floats × 4 B = 19.27 MiB, × 3 = 57.80 MiB with its drafter.
/// 0 when the architecture or its keys are unknown.
/// ponytail: nemotron_h (needs per-layer feed_forward_length), rwkv and kimi
/// linear are uncounted.
pub fn recurrent_state_bytes(arch: Option<&ArchMeta>) -> u64 {
    let Some((a, name, n)) = arch.and_then(|a| Some((a, a.architecture.as_deref()?, main_layer_count(a)?))) else {
        return 0;
    };
    let layers = if PURE_RECURRENT.contains(&name) || name == "falcon-h1" {
        n
    } else if RECURRENT_WHERE_NO_KV.contains(&name) {
        layer_heads(a, 0..n).map_or(0, |h| h.iter().filter(|&&h| h == 0).count() as u64)
    } else {
        return 0;
    };
    let floats = if matches!(name, "lfm2" | "lfm2moe") {
        match (a.embedding_length, a.shortconv_l_cache) {
            (Some(embed), Some(l)) => embed.saturating_mul(l.saturating_sub(1)),
            _ => 0,
        }
    } else {
        match (a.ssm_conv_kernel, a.ssm_inner_size, a.ssm_state_size) {
            (Some(conv), Some(inner), Some(state)) => conv
                .saturating_sub(1)
                .saturating_mul(inner.saturating_add(a.ssm_group_count.unwrap_or(0).saturating_mul(2).saturating_mul(state)))
                .saturating_add(state.saturating_mul(inner)),
            _ => 0,
        }
    };
    // Only architectures llama.cpp can roll back (`llm_arch_supports_rs_rollback`)
    // keep the extra rows; elsewhere `n_rs_seq` is clamped to 0.
    let rollback = a.draft.is_some() && matches!(name, "qwen35" | "qwen35moe");
    let rows = if rollback { 1 + a.draft_num_predict.unwrap_or(DRAFT_N_MAX) } else { 1 };
    layers.saturating_mul(floats).saturating_mul(4).saturating_mul(rows)
}

/// Ollama's default `draft_num_predict` (`--spec-draft-n-max`) when a model's
/// parameters don't set one; qwen3.5:0.8b sets 2, gemma4:e2b 3.
const DRAFT_N_MAX: u64 = 4;

/// The supported quants, smallest → largest. `bpw` (bits per weight) is what
/// turns a parameter count into a weights size; the values are the common
/// effective rates for llama.cpp k-quants.
pub const QUANTS: &[(&str, f64)] = &[
    ("Q3_K_S", 3.5),
    ("Q4_K_M", 4.8),
    ("Q5_K_M", 5.6),
    ("Q8_0", 8.5),
];

/// Bits per weight for a quant id; unknown ids fall back to Q4_K_M — which is
/// why [`estimate_fit`] prefers a real `size_bytes` whenever it has one.
pub fn quant_bpw(id: &str) -> f64 {
    QUANTS
        .iter()
        .find(|(q, _)| q.eq_ignore_ascii_case(id))
        .map(|(_, bpw)| *bpw)
        .unwrap_or(4.8)
}

/// How well a model fits the host's memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FitTier {
    /// Fits comfortably.
    Ok,
    /// Fits, but leaves little headroom for the OS and other apps.
    Tight,
    /// Needs more memory than the machine has.
    WontFit,
    /// Host memory (or the model's parameter count) isn't known.
    Unknown,
}

/// The terms behind a fit verdict, all in GiB.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FitBreakdown {
    pub weights_gb: f64,
    pub kv_cache_gb: f64,
    pub compute_buffer_gb: f64,
    pub os_reserve_gb: f64,
    pub total_needed_gb: f64,
    pub available_gb: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FitResult {
    pub tier: FitTier,
    pub fits: bool,
    pub headroom_gb: f64,
    pub breakdown: FitBreakdown,
    /// Whether the KV term came from metadata or a parameter-count bucket.
    pub kv_source: KvSource,
}

/// Realistic context for the default fit check: [`DEFAULT_CONTEXT`], capped by
/// the model's own maximum (some models advertise less).
pub fn fit_context(max_context: u64) -> u64 {
    if max_context == 0 {
        DEFAULT_CONTEXT
    } else {
        max_context.min(DEFAULT_CONTEXT)
    }
}

/// Estimate whether a model fits, and expose the math behind it.
///
/// Pass `arch` whenever it's known: with architecture metadata the KV term is
/// exact, and without it it falls back to a parameter-count bucket —
/// [`FitResult::kv_source`] says which happened. `size_bytes` is the model's
/// real on-disk GGUF size and is preferred over `params_b × bpw / 8`, which goes
/// badly wrong for any quant outside [`QUANTS`].
pub fn estimate_fit(
    params_b: f64,
    quant: &str,
    context_length: u64,
    memory_bytes: Option<u64>,
    arch: Option<&ArchMeta>,
    size_bytes: Option<u64>,
) -> FitResult {
    let available_gb = memory_bytes.unwrap_or(0) as f64 / GIB;
    let weights_gb = match size_bytes.filter(|&b| b > 0) {
        Some(bytes) => bytes as f64 / GIB,
        None => params_b * 1e9 * (quant_bpw(quant) / 8.0) / GIB,
    };
    let kv = kv_cache_bytes(arch, context_length, params_b);
    // Hybrid models' fixed recurrent state and the speculative drafter's cache
    // ride with the KV cache: all are per-sequence memory allocated at load.
    let kv_cache_gb =
        (kv.bytes + recurrent_state_bytes(arch) + draft_kv_cache_bytes(arch, context_length)) as f64 / GIB;
    // The attention mask. Grows with context like the KV cache but far slower —
    // ~128 MiB at 32k — so it's a rounding error next to the OS reserve. Kept
    // separate because the breakdown shows it, not because it moves a verdict.
    let compute_buffer_gb = compute_buffer_bytes(context_length) as f64 / GIB;
    let os_reserve_gb = (0.15 * available_gb).max(2.0);
    let total_needed_gb = weights_gb + kv_cache_gb + compute_buffer_gb + os_reserve_gb;
    let headroom_gb = available_gb - total_needed_gb;

    let breakdown = FitBreakdown {
        weights_gb,
        kv_cache_gb,
        compute_buffer_gb,
        os_reserve_gb,
        total_needed_gb,
        available_gb,
    };

    if memory_bytes.unwrap_or(0) == 0 || params_b <= 0.0 {
        return FitResult {
            tier: FitTier::Unknown,
            fits: false,
            headroom_gb,
            breakdown,
            kv_source: kv.source,
        };
    }
    let tier = if headroom_gb < 0.0 {
        FitTier::WontFit
    } else if headroom_gb < available_gb * TIGHT_HEADROOM_RATIO {
        FitTier::Tight
    } else {
        FitTier::Ok
    };
    FitResult {
        tier,
        fits: headroom_gb >= 0.0,
        headroom_gb,
        breakdown,
        kv_source: kv.source,
    }
}

/// Parameter count in billions from a tag's size suffix: `llama3.1:8b` → 8,
/// `smollm2:135m` → 0.135.
///
/// `mixtral:8x7b` → 56, experts × size. That is the figure that governs memory:
/// every expert is resident even though only two run per token, so the "47B"
/// marketing number would under-report what has to be loaded.
pub fn parse_tag_params(tag: &str) -> Option<f64> {
    let suffix = tag.split(':').nth(1)?.trim().to_ascii_lowercase();
    if let Some(rest) = suffix.strip_suffix('b') {
        // `8x7b`: experts × size.
        if let Some((experts, size)) = rest.split_once('x') {
            return Some(experts.parse::<f64>().ok()? * size.parse::<f64>().ok()?);
        }
        return rest.parse::<f64>().ok();
    }
    // The only other unit is millions; anything else (`:latest`) has no count.
    Some(suffix.strip_suffix('m')?.parse::<f64>().ok()? / 1000.0)
}

/// Parse Ollama's parameter-size label (e.g. `"8.0B"`, `"137M"`) into a count in
/// billions. `None` when it can't be parsed.
pub fn parse_param_size(label: &str) -> Option<f64> {
    let label = label.trim();
    let (digits, scale) = match label.chars().last()?.to_ascii_uppercase() {
        'B' => (&label[..label.len() - 1], 1.0),
        'M' => (&label[..label.len() - 1], 1e-3),
        'K' => (&label[..label.len() - 1], 1e-6),
        // No unit: billions, matching the TS default.
        _ => (label, 1.0),
    };
    let value: f64 = digits.trim().parse().ok()?;
    Some(value * scale)
}
