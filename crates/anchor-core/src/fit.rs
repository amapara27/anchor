//! Runtime memory sizing: KV cache, weights, and whether a model fits the host.
//!
//! **Mirror of `apps/desktop/src/lib/kv.ts` + `fit.ts` + `quant.ts`.** The GUI
//! recomputes this live as the context slider moves, so it keeps its own pure-TS
//! copy rather than paying an IPC round-trip per tick; this is the same math for
//! the CLI and anything else headless. The two are pinned together by fixtures:
//! the tests below replicate `apps/desktop/src/lib/engine.selfcheck.ts`, so a
//! change to one side that the other doesn't get fails here or there. Change
//! both, or neither.
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

#[cfg(test)]
mod tests {
    use super::*;

    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * 1024;
    /// 16 GB (decimal), matching the selfcheck's `GB16`.
    const GB16: Option<u64> = Some(16_000_000_000);

    fn arch(f: impl FnOnce(&mut ArchMeta)) -> ArchMeta {
        let mut a = ArchMeta::default();
        f(&mut a);
        a
    }

    // --- KV math -----------------------------------------------------------
    // Mirrors apps/desktop/src/lib/engine.selfcheck.ts. Each per-token figure is
    // n_layers × n_kv_heads × (key_len + value_len) × 2 bytes, and each differs
    // from what a parameter-count bucket would say.

    #[test]
    fn per_token_kv_matches_measured_architectures() {
        let llama31_8b = arch(|a| {
            a.block_count = Some(32);
            a.head_count_kv = Some(8);
            a.key_length = Some(128);
            a.value_length = Some(128);
        });
        assert_eq!(metadata_kv_bytes_per_token(Some(&llama31_8b)), Some(128 * KIB));

        // Small GQA model: KV barely shrinks with parameter count (bucket: 48 KiB).
        let qwen3_1_7b = arch(|a| {
            a.block_count = Some(28);
            a.head_count_kv = Some(8);
            a.key_length = Some(128);
            a.value_length = Some(128);
        });
        assert_eq!(metadata_kv_bytes_per_token(Some(&qwen3_1_7b)), Some(112 * KIB));

        assert_eq!(metadata_kv_bytes_per_token(Some(&llama32_1b())), Some(32 * KIB));

        // MLA takes the ordinary dense path: llama.cpp caches the decompressed
        // per-head K/V, not the compressed latent. Asymmetric k/v dims are the
        // only thing it needs from this code.
        let deepseek_v2 = arch(|a| {
            a.architecture = Some("deepseek2".into());
            a.block_count = Some(27);
            a.head_count = Some(16);
            a.head_count_kv = Some(16);
            a.key_length = Some(192);
            a.value_length = Some(128);
        });
        assert_eq!(metadata_kv_bytes_per_token(Some(&deepseek_v2)), Some(270 * KIB));
        assert_eq!(kv_cache_bytes(Some(&deepseek_v2), 32768, 15.7).bytes, 8640 * MIB);
    }

    /// MHA with an unreachable window: head dim comes from embedding/heads, and
    /// the 262144 window against a 131072 maximum can never bind. Before the
    /// dense shortcut this fell to the parameter bucket — 48 KiB/token guessed
    /// against 384 measured, 8x under on a model wanting 12 GiB of KV at 32k.
    #[test]
    fn a_window_wider_than_the_context_is_dense_not_windowed() {
        let phi3_mini = arch(|a| {
            a.architecture = Some("phi3".into());
            a.block_count = Some(32);
            a.head_count = Some(32);
            a.head_count_kv = Some(32);
            a.embedding_length = Some(3072);
            a.sliding_window = Some(262144);
        });
        assert_eq!(metadata_kv_bytes_per_token(Some(&phi3_mini)), Some(384 * KIB));
        let kv = kv_cache_bytes(Some(&phi3_mini), 8192, 3.8);
        assert_eq!(kv.bytes, 8192 * 384 * KIB);
        assert_eq!(kv.source, KvSource::Metadata, "phi3 uses metadata, not a bucket");
    }

    #[test]
    fn compute_buffer_is_the_attention_mask_only() {
        assert_eq!(compute_buffer_bytes(1), 4096, "4 KiB/token");
        assert_eq!(compute_buffer_bytes(32768), 128 * MIB, "128 MiB at 32k");
        assert!(
            compute_buffer_bytes(32768) < kv_cache_bytes(Some(&llama32_1b()), 32768, 1.0).bytes,
            "compute buffer is small beside KV even on a 1B model",
        );
    }

    fn llama32_1b() -> ArchMeta {
        arch(|a| {
            a.architecture = Some("llama".into());
            a.block_count = Some(16);
            a.head_count = Some(32);
            a.head_count_kv = Some(8);
            a.key_length = Some(64);
            a.value_length = Some(64);
        })
    }

    /// 42 blocks − 18 shared = 24 cached, split 4:20 global:local. Ground truth
    /// is llama.cpp at n_ctx=32768: 512.00 MiB (32768 cells, 4 layers) +
    /// 40.00 MiB (1024 cells, 20 layers). We predict 572/188 against 552/168
    /// measured because the windowed term assumes the larger n_batch — the
    /// deliberate over-predict documented on DEFAULT_BATCH.
    #[test]
    fn windowed_layers_stop_growing_past_the_window() {
        let gemma4 = arch(|a| {
            a.architecture = Some("gemma4".into());
            a.block_count = Some(42);
            a.head_count = Some(8);
            a.head_count_kv = Some(2);
            a.key_length = Some(512);
            a.value_length = Some(512);
            a.key_length_swa = Some(256);
            a.value_length_swa = Some(256);
            a.sliding_window = Some(512);
            a.shared_kv_layers = Some(18);
        });
        let at_32k = kv_cache_bytes(Some(&gemma4), 32768, 4.0);
        let at_8k = kv_cache_bytes(Some(&gemma4), 8192, 4.0);
        assert_eq!(at_32k.bytes, 572 * MIB, "512 MiB global + 60 MiB local");
        assert_eq!(at_8k.bytes, 188 * MIB, "128 MiB global + 60 MiB local");
        assert_eq!(at_8k.source, KvSource::Metadata);
        // Growth past the window is global-only: 4 layers × 2 heads × 1024 × 2.
        assert_eq!(at_32k.bytes - at_8k.bytes, 24576 * 16 * KIB);

        // Shared layers are not optional bookkeeping: ignoring them inflates 75%.
        let unshared = ArchMeta { shared_kv_layers: None, ..gemma4 };
        assert!(kv_cache_bytes(Some(&unshared), 32768, 4.0).bytes > at_32k.bytes);
    }

    /// gemma2 alternates 1:1 (13 of 26 global); gemma3 runs 5:1 (5 of 34 — note
    /// 34/6 is 5.67, so this is the case that proves the split floors).
    #[test]
    fn the_global_local_split_floors() {
        let gemma2_2b = arch(|a| {
            a.architecture = Some("gemma2".into());
            a.block_count = Some(26);
            a.head_count = Some(8);
            a.head_count_kv = Some(4);
            a.key_length = Some(256);
            a.value_length = Some(256);
            a.sliding_window = Some(4096);
        });
        assert_eq!(
            kv_cache_bytes(Some(&gemma2_2b), 8192, 2.6).bytes,
            676 * MIB,
            "gemma2:2b @8k = 416 global + 260 local",
        );

        let gemma3_4b = arch(|a| {
            a.architecture = Some("gemma3".into());
            a.block_count = Some(34);
            a.head_count = Some(8);
            a.head_count_kv = Some(4);
            a.key_length = Some(256);
            a.value_length = Some(256);
            a.sliding_window = Some(1024);
        });
        assert_eq!(kv_cache_bytes(Some(&gemma3_4b), 8192, 4.3).bytes, 392 * MIB);
        assert_eq!(kv_cache_bytes(Some(&gemma3_4b), 32768, 4.3).bytes, 872 * MIB);
        // Rounding instead of flooring would bill a 6th global layer here, which
        // is 32768 × 4 KiB = 128 MiB llama.cpp never allocates.
        let with_36 = ArchMeta { block_count: Some(36), ..gemma3_4b.clone() };
        assert!(
            kv_cache_bytes(Some(&gemma3_4b), 32768, 4.3).bytes
                < kv_cache_bytes(Some(&with_36), 32768, 4.3).bytes,
            "a 36-layer gemma3 gets a 6th global layer, a 34-layer one does not",
        );
    }

    /// No metadata, an unknown windowed arch, and array-valued (null) fields all
    /// fall back to the bucket and say so, rather than returning a confident
    /// wrong number.
    #[test]
    fn missing_metadata_degrades_to_an_estimate() {
        assert_eq!(kv_cache_bytes(None, 4096, 8.0).source, KvSource::Estimated);
        assert_eq!(
            metadata_kv_bytes_per_token(Some(&arch(|a| a.block_count = Some(32)))),
            None,
            "missing kv heads",
        );
        let mystery = arch(|a| {
            a.architecture = Some("mystery".into());
            a.block_count = Some(32);
            a.head_count_kv = Some(8);
            a.key_length = Some(64);
            a.value_length = Some(64);
            a.sliding_window = Some(4096);
        });
        assert_eq!(
            kv_cache_bytes(Some(&mystery), 8192, 8.0).source,
            KvSource::Estimated,
            "unknown windowed arch",
        );
        // Ollama serialises array-valued metadata as JSON null, so a
        // present-but-null head_count_kv (qwen3.5) must degrade, not panic.
        let qwen35 = arch(|a| {
            a.block_count = Some(32);
            a.key_length = Some(256);
            a.value_length = Some(256);
        });
        assert_eq!(metadata_kv_bytes_per_token(Some(&qwen35)), None);
    }

    // --- Fit ---------------------------------------------------------------

    #[test]
    fn fit_verdicts_track_context_and_quant() {
        let small = estimate_fit(8.0, "Q4_K_M", 4096, GB16, None, None);
        assert_eq!(small.tier, FitTier::Ok);
        assert!(small.fits);
        assert!(small.breakdown.weights_gb > 4.0 && small.breakdown.weights_gb < 5.0);

        // The same model at full 128K context blows past memory.
        let huge = estimate_fit(8.0, "Q4_K_M", 131072, GB16, None, None);
        assert_eq!(huge.tier, FitTier::WontFit);
        assert!(!huge.fits);
        assert!(huge.breakdown.kv_cache_gb > small.breakdown.kv_cache_gb);

        assert!(
            estimate_fit(8.0, "Q8_0", 4096, GB16, None, None).breakdown.weights_gb
                > estimate_fit(8.0, "Q3_K_S", 4096, GB16, None, None).breakdown.weights_gb,
        );
    }

    #[test]
    fn default_context_keeps_long_context_models_fitting() {
        assert_eq!(fit_context(131072), 4096);
        assert_eq!(fit_context(2048), 2048, "a model advertising less keeps its own max");
        let qwen = estimate_fit(7.0, "Q4_K_M", fit_context(131072), GB16, None, None);
        assert!(qwen.fits && qwen.tier != FitTier::WontFit);
    }

    #[test]
    fn unknown_memory_or_params_is_unknown() {
        assert_eq!(
            estimate_fit(8.0, "Q4_K_M", 4096, None, None, None).tier,
            FitTier::Unknown,
        );
        assert_eq!(
            estimate_fit(0.0, "Q4_K_M", 4096, GB16, None, None).tier,
            FitTier::Unknown,
        );
    }

    /// Real on-disk size wins over params × bpw. This matters most for a quant
    /// the table doesn't know: `quant_bpw` coerces those to Q4_K_M, which would
    /// size an F16 model at ~40% of its true weight.
    #[test]
    fn size_bytes_overrides_the_bpw_estimate() {
        let real = estimate_fit(8.0, "F16", 4096, GB16, None, Some(16 * 1024_u64.pow(3)));
        assert_eq!(real.breakdown.weights_gb, 16.0);
    }

    #[test]
    fn fit_reports_how_the_kv_term_was_derived() {
        assert_eq!(
            estimate_fit(1.2, "Q4_K_M", 8192, GB16, Some(&llama32_1b()), None).kv_source,
            KvSource::Metadata,
        );
        assert_eq!(
            estimate_fit(8.0, "Q4_K_M", 8192, GB16, None, None).kv_source,
            KvSource::Estimated,
        );
    }

    #[test]
    fn quants_are_ordered_and_look_up() {
        assert!(QUANTS[0].1 < QUANTS[QUANTS.len() - 1].1);
        assert_eq!(quant_bpw("Q4_K_M"), 4.8);
        assert_eq!(quant_bpw("nonsense"), 4.8, "unknown quants fall back to Q4_K_M");
    }

    // --- Parameter-count parsing -------------------------------------------

    #[test]
    fn tag_suffixes_parse_into_billions() {
        assert_eq!(parse_tag_params("llama3.1:8b"), Some(8.0));
        assert_eq!(parse_tag_params("phi3.5:3.8b"), Some(3.8));
        assert_eq!(parse_tag_params("smollm2:135m"), Some(0.135));
        // MoE: every expert is resident, so memory follows experts × size — 56
        // here, not the 47 the model card advertises.
        assert_eq!(parse_tag_params("mixtral:8x7b"), Some(56.0));
        assert_eq!(parse_tag_params("nomic-embed-text"), None, "untagged id");
        assert_eq!(parse_tag_params("llama3.2-vision:11b"), Some(11.0));
        assert_eq!(parse_tag_params("llama3.1:latest"), None, "non-numeric tag");
    }

    #[test]
    fn ollama_parameter_labels_parse_into_billions() {
        assert_eq!(parse_param_size("8.0B"), Some(8.0));
        assert_eq!(parse_param_size("137M"), Some(0.137));
        assert_eq!(parse_param_size("1.2"), Some(1.2), "no unit ⇒ billions");
        assert_eq!(parse_param_size("unknown"), None);
        assert_eq!(parse_param_size(""), None);
    }
}
