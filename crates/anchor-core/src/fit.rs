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

/// Ollama's batch size (`num_batch`). Sets both the compute buffer's width and
/// the padding on a sliding-window cache, and is exposed by no API response.
///
/// Not actually a constant: Ollama passes `-b 1024` when the model has room and
/// drops to `-b 512` under memory pressure. 1024 is the larger, so both terms
/// over-predict rather than under-predict — the safe direction for a fit check,
/// and worth at most ~64 MiB either way.
const DEFAULT_BATCH: u64 = 1024;

/// Context length to judge at-a-glance fit at. Ollama loads a model with a small
/// default `num_ctx` (~4K), NOT its advertised maximum — a 128K-context model's
/// KV cache at full length can exceed total RAM and falsely read "won't fit".
/// ponytail: mirrors Ollama's num_ctx default; bump if that default changes.
pub const DEFAULT_CONTEXT: u64 = 4096;

/// Headroom below this fraction of total memory counts as a "tight" fit.
const TIGHT_HEADROOM_RATIO: f64 = 0.15;

const GIB: f64 = (1024 * 1024 * 1024) as f64;

/// Fraction of a sliding-window model's *cached* layers that keep a
/// full-context KV cache; the rest never exceed `sliding_window` tokens.
///
/// Held as `(numerator, denominator)` so the split floors exactly — the pattern
/// is "every Nth layer is global", so a partial trailing cycle contributes no
/// global layer (gemma3:4b has 34 cached layers at 1/6 and llama.cpp allocates
/// 5, not 6).
///
/// GGUF carries `sliding_window` but the layer *pattern* is array-valued, and
/// Ollama serialises array metadata as JSON null — so it never reaches us and
/// has to be known per architecture. All three gemma entries are confirmed
/// against llama.cpp's own allocation lines; `gemma3n` is carried over from
/// Gemma 3's published 5:1 pattern.
/// ponytail: the only hardcoded table left; an architecture missing from it
/// falls back to an estimate rather than guessing.
fn global_layer_fraction(architecture: &str) -> Option<(u64, u64)> {
    match architecture {
        "gemma2" => Some((1, 2)),
        "gemma3" | "gemma3n" | "gemma4" => Some((1, 6)),
        _ => None,
    }
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

/// Layers that actually hold a KV cache: `block_count` minus the layers that
/// reuse another's (`shared_kv_layers`). Gemma 4 shares 18 of 42, so 24 cache.
fn kv_layer_count(a: &ArchMeta) -> Option<u64> {
    let blocks = a.block_count?;
    Some(blocks.saturating_sub(a.shared_kv_layers.unwrap_or(0)))
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
/// notably a missing layer or KV-head count. Ollama reports array-valued
/// metadata as JSON null, so `head_count_kv` is absent on models whose value
/// varies per layer (qwen3.5), not only on old GGUFs.
///
/// MLA (deepseek2) needs no special case: llama.cpp caches the *decompressed*
/// per-head K/V, not the compressed latent, so the dense formula is already
/// exact. Measured on deepseek-v2:16b — 27 × 16 × (192 + 128) × 2 = 270
/// KiB/token, matching `size = 8640.00 MiB (32768 cells, 27 layers)`.
pub fn metadata_kv_bytes_per_token(arch: Option<&ArchMeta>) -> Option<u64> {
    let a = arch?;
    let (k, v) = head_dims(a)?;
    let layers = kv_layer_count(a).filter(|&l| l > 0)?;
    let kv_heads = a.head_count_kv.filter(|&h| h > 0)?;
    Some(layers * kv_heads * (k + v) * F16_BYTES)
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
    context_length * DEFAULT_BATCH * 4
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
    let (Some(arch), Some(per_token)) = (arch, metadata_kv_bytes_per_token(arch)) else {
        return estimated();
    };
    let exact = KvEstimate {
        bytes: context_length * per_token,
        source: KvSource::Metadata,
    };
    let Some(window) = arch.sliding_window.filter(|&w| w > 0) else {
        return exact;
    };
    // A window at least as wide as the context never binds — every layer holds
    // the full context, which is plain dense attention. phi3 declares a 262144
    // window against a 131072 maximum, so it is never windowed in practice;
    // without this check it falls through to the parameter bucket and
    // under-reports by 8x. This runs first only to rescue the architectures the
    // windowed branch below has no fraction for; for a known one it computes
    // the same number.
    if context_length <= window {
        return exact;
    }

    // Windowed model: we need to know how many layers escape the window.
    let Some((num, den)) = arch
        .architecture
        .as_deref()
        .and_then(global_layer_fraction)
    else {
        return estimated();
    };

    let (k, v) = head_dims(arch).expect("head dims exist: per_token was computed");
    // Windowed layers can carry narrower heads than the full-attention ones.
    let swa = match (arch.key_length_swa, arch.value_length_swa) {
        (Some(ks), Some(vs)) => (ks, vs),
        _ => (k, v),
    };
    let kv_heads = arch.head_count_kv.expect("kv heads exist: per_token was computed");
    let per_layer_token = |(k, v): (u64, u64)| kv_heads * (k + v) * F16_BYTES;

    let layers = kv_layer_count(arch).expect("layers exist: per_token was computed");
    // Integer division floors, which is the point: a partial trailing cycle
    // contributes no global layer.
    let global_layers = layers * num / den;
    let local_layers = layers - global_layers;
    // llama.cpp sizes a windowed cache at the window plus one batch, so it can
    // hold the batch being processed alongside the tokens still in scope:
    // gemma4 allocates 1024 cells against a declared 512-token window.
    let window_cells = context_length.min(window + DEFAULT_BATCH);
    KvEstimate {
        bytes: global_layers * per_layer_token((k, v)) * context_length
            + local_layers * per_layer_token(swa) * window_cells,
        source: KvSource::Metadata,
    }
}

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
    let kv_cache_gb = kv.bytes as f64 / GIB;
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
