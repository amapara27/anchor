//! Core domain logic for Anchor.
//!
//! This crate is intentionally free of any UI or Tauri dependencies so it can
//! be reused from the desktop app, a future CLI, or a headless service, and so
//! it can be tested without spinning up a webview.

use serde::{Deserialize, Serialize};

/// A local AI model that Anchor knows about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Model {
    /// Stable identifier, e.g. `"llama-3.1-8b-instruct"`.
    pub id: String,
    /// Human-friendly display name.
    pub name: String,
    /// Model family / architecture, e.g. `"llama"` or `"qwen"`.
    pub family: String,
    /// On-disk size in bytes, if known.
    pub size_bytes: Option<u64>,
    /// Whether the model is installed locally or merely available to install.
    pub status: ModelStatus,
    /// Ollama's parameter-size label, e.g. `"8.0B"`, if known.
    #[serde(default)]
    pub parameter_size: Option<String>,
    /// Quantisation level reported by Ollama, e.g. `"Q4_K_M"`, if known.
    #[serde(default)]
    pub quantization: Option<String>,
    /// Maximum context window in tokens, if known (from Ollama's `/api/show`).
    #[serde(default)]
    pub context_tokens: Option<u64>,
    /// Last-modified timestamp Ollama reports (ISO 8601), if known.
    #[serde(default)]
    pub modified_at: Option<String>,
    /// Producing lab / organisation, e.g. `"Meta"`, when the model's GGUF
    /// metadata exposes it (`general.organization` / `general.author`).
    #[serde(default)]
    pub publisher: Option<String>,
    /// GGUF architecture metadata, when Ollama exposes it. Drives exact KV-cache
    /// math; `None` makes the caller fall back to a size-bucketed estimate.
    #[serde(default)]
    pub arch: Option<ArchMeta>,
}

/// The GGUF architecture fields that determine KV-cache size, as reported by
/// Ollama's `/api/show` `model_info` map.
///
/// Exists because KV cost per token is
/// `block_count × head_count_kv × (key_length + value_length) × bytes_per_elem`
/// — and *none* of those terms is the parameter count, so sizing a model's KV
/// cache from its parameter count is wrong by up to 5x (worst on MHA models,
/// where `head_count_kv == head_count`).
///
/// Every field is optional: older and unusual GGUFs omit some, and a missing
/// field must degrade to an estimate rather than fail the model's enrichment.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchMeta {
    /// `general.architecture`, e.g. `"llama"`, `"qwen3"`, `"gemma3"`.
    #[serde(default)]
    pub architecture: Option<String>,
    /// Transformer layer count (`{arch}.block_count`).
    #[serde(default)]
    pub block_count: Option<u64>,
    /// Attention query heads (`{arch}.attention.head_count`). Only needed to
    /// derive head dimension when `key_length`/`value_length` are absent.
    #[serde(default)]
    pub head_count: Option<u64>,
    /// Attention key/value heads (`{arch}.attention.head_count_kv`). Equal to
    /// `head_count` on MHA models; smaller under GQA.
    #[serde(default)]
    pub head_count_kv: Option<u64>,
    /// Hidden size (`{arch}.embedding_length`).
    #[serde(default)]
    pub embedding_length: Option<u64>,
    /// Per-head key dimension (`{arch}.attention.key_length`).
    #[serde(default)]
    pub key_length: Option<u64>,
    /// Per-head value dimension (`{arch}.attention.value_length`). Can differ
    /// from `key_length`, which is why the two are summed rather than doubled.
    #[serde(default)]
    pub value_length: Option<u64>,
    /// Sliding-window span (`{arch}.attention.sliding_window`). Present on
    /// Gemma 2/3/4 and similar, where most layers cap their KV at this width
    /// instead of holding the full context.
    #[serde(default)]
    pub sliding_window: Option<u64>,
    /// Per-head key dimension on sliding-window layers
    /// (`{arch}.attention.key_length_swa`), when it differs from the global
    /// layers'. Gemma 4 uses 512 globally and 256 on windowed layers.
    #[serde(default)]
    pub key_length_swa: Option<u64>,
    /// Per-head value dimension on sliding-window layers
    /// (`{arch}.attention.value_length_swa`).
    #[serde(default)]
    pub value_length_swa: Option<u64>,
    /// Layers that reuse another layer's KV cache instead of holding their own
    /// (`{arch}.attention.shared_kv_layers`). Gemma 4 shares 18 of 42, so only
    /// 24 layers are actually cached — counting all `block_count` layers
    /// over-reports, and applying the global/local split to the wrong
    /// denominator under-reports. Verified against llama.cpp's own
    /// `llama_kv_cache:` allocation lines.
    #[serde(default)]
    pub shared_kv_layers: Option<u64>,
}

impl ArchMeta {
    /// True when no field was populated, i.e. nothing worth storing.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Installation state of a [`Model`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelStatus {
    /// Present on disk and ready to run.
    Installed,
    /// Known to Anchor but not yet downloaded.
    Available,
}

/// A snapshot of the host machine's static hardware specs.
///
/// Profiled once (on macOS, from `system_profiler`) and cached to disk by the
/// `anchor-system` crate, then surfaced on the home screen and used to flag
/// models too large for the machine. Every probed field is optional: a parse
/// miss degrades that field to `None` rather than failing the whole profile, so
/// the UI always has *something* to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareProfile {
    /// Marketing chip/CPU name, e.g. `"Apple M3 Pro"` or `"Intel Core i7"`.
    pub chip: Option<String>,
    /// CPU architecture from the running binary: `"aarch64"` or `"x86_64"`.
    pub arch: String,
    /// Total physical (unified, on Apple Silicon) memory in bytes.
    pub memory_bytes: Option<u64>,
    /// Total CPU cores (performance + efficiency on Apple Silicon).
    pub total_cores: Option<u32>,
    /// Performance cores, when the platform reports the split.
    pub performance_cores: Option<u32>,
    /// Efficiency cores, when the platform reports the split.
    pub efficiency_cores: Option<u32>,
    /// GPU cores, on Apple Silicon. Load-bearing for benchmark matching: an
    /// M3 Pro ships with either 14 or 18 GPU cores and they differ ~25% in
    /// throughput, so results from the two are not comparable.
    ///
    /// Deliberately *not* `#[serde(default)]`: a cache file written before this
    /// field existed must fail to parse so the profiler re-runs, rather than
    /// silently loading `None` and poisoning every hardware key derived from it.
    pub gpu_cores: Option<u32>,
    /// macOS product version, e.g. `"15.5"`.
    pub os_version: Option<String>,
    /// True on Apple Silicon (unified memory), i.e. `arch == "aarch64"`.
    pub apple_silicon: bool,
    /// Human model name, e.g. `"MacBook Pro"`.
    pub model_name: Option<String>,
}

/// The hardware facts a benchmark result is matched on.
///
/// Denormalised onto every benchmark row rather than joined, because the whole
/// point is comparing against *other people's* machines: the row has to carry
/// enough identity to be judged on its own, including after it has travelled
/// from another install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HwIdentity {
    /// Exact-match key, e.g. `"apple-m4-10c-10g-16gb"`. Unknown segments are
    /// omitted so the key stays stable for a given machine.
    pub hw_key: String,
    /// Chip-family key, e.g. `"apple-m4"`. The loosest matching tier.
    pub chip_key: String,
    /// Display chip name, e.g. `"Apple M4"`.
    pub chip: String,
    pub cpu_cores: Option<u32>,
    pub gpu_cores: Option<u32>,
    /// Unified memory rounded to whole GiB — the granularity machines are sold
    /// and compared at.
    pub memory_gb: Option<u32>,
    pub os_version: Option<String>,
}

impl HwIdentity {
    /// Derives the match identity from a profiled machine.
    pub fn from_profile(hw: &HardwareProfile) -> Self {
        let chip = hw.chip.clone().unwrap_or_else(|| "Unknown".to_string());
        let chip_key = {
            let s = slug(&chip);
            if s.is_empty() { slug(&hw.arch) } else { s }
        };
        let memory_gb = hw.memory_bytes.map(|b| (b as f64 / 1024_f64.powi(3)).round() as u32);

        let mut hw_key = chip_key.clone();
        if let Some(c) = hw.total_cores {
            hw_key.push_str(&format!("-{c}c"));
        }
        if let Some(g) = hw.gpu_cores {
            hw_key.push_str(&format!("-{g}g"));
        }
        if let Some(m) = memory_gb {
            hw_key.push_str(&format!("-{m}gb"));
        }

        Self {
            hw_key,
            chip_key,
            chip,
            cpu_cores: hw.total_cores,
            gpu_cores: hw.gpu_cores,
            memory_gb,
            os_version: hw.os_version.clone(),
        }
    }
}

/// Lowercases and collapses every run of non-alphanumerics to a single dash.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// How closely a benchmark result's machine matches the one asking.
///
/// Ordered most- to least-specific; the numeric order is the sort key, so
/// relabelling a tier in the UI can never reorder results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchQuality {
    /// Same chip, same core counts, same memory.
    Exact = 1,
    /// Same chip and memory, different core configuration.
    SameChipMemory = 2,
    /// Same chip family only.
    SameFamily = 3,
}

impl MatchQuality {
    pub fn from_tier(tier: i64) -> Self {
        match tier {
            1 => Self::Exact,
            2 => Self::SameChipMemory,
            _ => Self::SameFamily,
        }
    }
}

/// Where a benchmark row came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BenchSource {
    /// Measured on this machine.
    Local,
    /// Pulled from the shared community database.
    Community,
}

/// A live snapshot of conditions that can affect a benchmark's numbers.
///
/// Unlike [`HardwareProfile`] (static, cached forever), this is taken fresh
/// around each run — thermal state, power source, and free memory all drift
/// over the course of a session in ways a benchmark result should carry.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EnvTelemetry {
    /// `pmset -g therm`'s `CPU_Speed_Limit`, percent. 100 = unthrottled.
    pub thermal_pressure_pct: Option<u8>,
    pub on_ac_power: Option<bool>,
    pub uptime_secs: Option<u64>,
    pub free_memory_bytes: Option<u64>,
    /// Models resident *other than* the one under test, at snapshot time —
    /// what else is competing for RAM.
    pub resident_model_count: Option<u32>,
}

/// One content-addressed blob under Ollama's `blobs/` directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageBlob {
    /// Colon form, e.g. `"sha256:abcd…"` — matches what a manifest's `digest`
    /// field carries (the on-disk filename uses a dash instead: `sha256-abcd…`).
    pub digest: String,
    pub size_bytes: u64,
}

/// Result of walking Ollama's on-disk model store: what's shared between
/// manifests via content-addressing, and what nothing references anymore.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageScan {
    /// The resolved store root (`$OLLAMA_MODELS`, else `~/.ollama/models`).
    pub root: String,
    pub blobs_bytes: u64,
    pub manifests_bytes: u64,
    /// Bytes saved by content-addressed sharing: for every blob referenced by
    /// N>1 manifests, (N-1) × blob size. Ollama already dedupes at pull time —
    /// this is reporting, not new dedup logic.
    pub dedup_savings_bytes: u64,
    /// Blob files under `blobs/` no current manifest references (interrupted
    /// pulls, removal races) — safe to delete. Always empty when
    /// `unreadable_manifests > 0`: see that field.
    pub orphaned_blobs: Vec<StorageBlob>,
    pub orphaned_bytes: u64,
    /// Manifests that could not be read or parsed. A manifest we can't read
    /// contributes no references, which would make the blobs it alone points at
    /// look orphaned — so when this is non-zero the scan reports no orphans at
    /// all rather than offering live model data up for irreversible deletion.
    pub unreadable_manifests: u32,
}

/// One benchmark result: a model, a configuration, a machine, and what it did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BenchRun {
    /// Deterministic composite (see [`BenchRun::derive_id`]) so re-running a
    /// benchmark updates the existing row instead of adding another.
    pub id: String,
    pub hw: HwIdentity,

    /// Ollama model reference, e.g. `"llama3.2:1b"`.
    pub model_name: String,
    /// Content digest — the real model identity, since a tag can be re-pointed.
    pub model_digest: String,
    pub quant: Option<String>,
    pub num_ctx: u32,
    /// KV cache element type, e.g. `"f16"`. Changes memory and speed.
    pub kv_cache_type: String,
    pub flash_attn: bool,
    pub ollama_version: Option<String>,
    /// Which standard suite produced this, so results stay comparable.
    pub suite_id: String,
    pub suite_version: u32,

    /// Prompt-processing throughput, median over `repeats`.
    pub prefill_tps_median: Option<f64>,
    /// Generation throughput, median over `repeats`.
    pub decode_tps_median: Option<f64>,
    /// Cold-load time in milliseconds.
    pub load_ms: Option<u64>,
    /// Peak resident bytes while loaded, from `/api/ps`.
    pub peak_rss_bytes: Option<u64>,
    /// Measured runs behind the medians, excluding the discarded warmup.
    pub repeats: u32,

    /// Anonymous per-install id — lets someone update their own submission
    /// without any account.
    pub install_id: String,
    pub rating: Option<u8>,
    pub review: Option<String>,
    pub visible: bool,
    /// Unix epoch milliseconds.
    pub created_at: i64,
    pub updated_at: i64,

    pub source: BenchSource,
    pub synced_at: Option<i64>,

    /// Set by a match query, not stored. `None` on a row read back directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_quality: Option<MatchQuality>,

    /// Catalog id of the prompt this row measures, e.g. `"short"`,
    /// `"long_context"`, `"generation_heavy"`. `None` for `anchor-std` rows,
    /// which don't use the catalog.
    pub prompt_id: Option<String>,
    /// Version of the prompt *text*, independent of `suite_version` (which
    /// versions suite logic — the ctx set, repeat counts, cell structure).
    /// `None` for `anchor-std` rows.
    pub prompt_version: Option<u32>,
    /// Time-to-first-token proxy, in milliseconds: `prompt_eval_duration_ns`,
    /// median over repeats. On an already-warmed/loaded model, generation
    /// begins the instant prompt eval finishes, so this needs no wall-clock
    /// instrumentation of its own.
    pub ttft_ms_median: Option<f64>,
    pub env_start: Option<EnvTelemetry>,
    pub env_end: Option<EnvTelemetry>,
    /// `"sustained"` | `"throttled"` | `"unknown"`, derived from the thermal
    /// delta between `env_start` and `env_end`.
    pub thermal_label: Option<String>,
    /// Free-text anomaly notes. Auto-populated where derivable (thermal,
    /// battery), user-editable afterward.
    pub notes: Option<String>,
}

impl BenchRun {
    /// The row's deterministic primary key.
    ///
    /// One machine + one model build + one configuration + one suite version =
    /// one row, so a re-run overwrites its own previous number rather than
    /// stuffing the ballot box. Left unhashed so it stays greppable in a
    /// `sqlite3` shell.
    ///
    /// `prompt` is `(prompt_id, prompt_version)` for a Full-suite cell, `None`
    /// for the single-prompt `anchor-std` suite — omitting the segment when
    /// `None` keeps this byte-identical to every id derived before Full mode
    /// existed, so existing rows keep upserting in place. When `Some`, the
    /// segment is what keeps sibling cells that share a `num_ctx` (different
    /// prompts, same context size) from colliding on one row.
    #[allow(clippy::too_many_arguments)]
    pub fn derive_id(
        install_id: &str,
        hw_key: &str,
        model_digest: &str,
        suite_id: &str,
        suite_version: u32,
        num_ctx: u32,
        kv_cache_type: &str,
        flash_attn: bool,
        prompt: Option<(&str, u32)>,
    ) -> String {
        let base = format!(
            "{install_id}|{hw_key}|{model_digest}|{suite_id}@{suite_version}|{num_ctx}|{kv_cache_type}|{flash_attn}"
        );
        match prompt {
            Some((id, version)) => format!("{base}|{id}@{version}"),
            None => base,
        }
    }
}

/// One repeat's raw measurement behind a [`BenchRun`]'s medians — including
/// the discarded warmup. Stored so a methodology change can recompute
/// medians later instead of only ever having the aggregate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BenchSample {
    /// `"{bench_run_id}#{repeat_index}"`.
    pub id: String,
    pub bench_run_id: String,
    /// 0 = warmup, 1..=repeats = measured.
    pub repeat_index: u32,
    pub is_warmup: bool,
    pub prefill_tps: Option<f64>,
    pub decode_tps: Option<f64>,
    pub ttft_ms: Option<f64>,
    pub prompt_eval_count: Option<u64>,
    pub prompt_eval_duration_ns: Option<u64>,
    pub eval_count: Option<u64>,
    pub eval_duration_ns: Option<u64>,
    pub total_duration_ns: Option<u64>,
    pub load_duration_ns: Option<u64>,
    pub wall_start_ms: i64,
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> HardwareProfile {
        HardwareProfile {
            chip: Some("Apple M4 Pro".to_string()),
            arch: "aarch64".to_string(),
            memory_bytes: Some(24 * 1024_u64.pow(3)),
            total_cores: Some(12),
            performance_cores: Some(8),
            efficiency_cores: Some(4),
            gpu_cores: Some(16),
            os_version: Some("15.5".to_string()),
            apple_silicon: true,
            model_name: Some("MacBook Pro".to_string()),
        }
    }

    #[test]
    fn model_status_serializes_lowercase() {
        let json = serde_json::to_string(&ModelStatus::Installed).unwrap();
        assert_eq!(json, "\"installed\"");
    }

    #[test]
    fn hw_key_encodes_chip_cores_and_memory() {
        let id = HwIdentity::from_profile(&profile());
        assert_eq!(id.hw_key, "apple-m4-pro-12c-16g-24gb");
        assert_eq!(id.chip_key, "apple-m4-pro");
        assert_eq!(id.memory_gb, Some(24));
    }

    #[test]
    fn hw_key_omits_unknown_segments_and_falls_back_to_arch() {
        let bare = HardwareProfile {
            chip: None,
            memory_bytes: None,
            total_cores: None,
            gpu_cores: None,
            ..profile()
        };
        let id = HwIdentity::from_profile(&bare);
        // "Unknown" chip still slugs, so the key is stable rather than empty.
        assert_eq!(id.hw_key, "unknown");
        assert_eq!(id.chip_key, "unknown");
    }

    #[test]
    fn gpu_cores_change_the_exact_key() {
        // The reason gpu_cores had to exist before the first row was written:
        // an M4 Pro ships with 16 or 20 GPU cores and they are not comparable.
        let a = HwIdentity::from_profile(&profile());
        let b = HwIdentity::from_profile(&HardwareProfile {
            gpu_cores: Some(20),
            ..profile()
        });
        assert_ne!(a.hw_key, b.hw_key);
        assert_eq!(a.chip_key, b.chip_key, "still the same family");
    }

    #[test]
    fn match_quality_orders_most_specific_first() {
        let mut tiers = vec![
            MatchQuality::SameFamily,
            MatchQuality::Exact,
            MatchQuality::SameChipMemory,
        ];
        tiers.sort();
        assert_eq!(tiers[0], MatchQuality::Exact);
        assert_eq!(tiers[2], MatchQuality::SameFamily);
    }

    #[test]
    fn derive_id_without_prompt_matches_pre_full_mode_shape() {
        // Byte-identical to the id every anchor-std row was already stored
        // under, so introducing Full mode must not orphan existing rows.
        let id = BenchRun::derive_id(
            "install-1", "apple-m4-10c-10g-16gb", "sha256:abcdef", "anchor-std", 1, 4096, "f16",
            false, None,
        );
        assert_eq!(
            id,
            "install-1|apple-m4-10c-10g-16gb|sha256:abcdef|anchor-std@1|4096|f16|false"
        );
    }

    #[test]
    fn derive_id_with_prompt_appends_a_distinct_segment() {
        let base = BenchRun::derive_id(
            "install-1", "apple-m4-10c-10g-16gb", "sha256:abcdef", "anchor-full", 1, 8192, "f16",
            false, None,
        );
        let short = BenchRun::derive_id(
            "install-1", "apple-m4-10c-10g-16gb", "sha256:abcdef", "anchor-full", 1, 8192, "f16",
            false, Some(("short", 1)),
        );
        let gen_heavy = BenchRun::derive_id(
            "install-1", "apple-m4-10c-10g-16gb", "sha256:abcdef", "anchor-full", 1, 8192, "f16",
            false, Some(("generation_heavy", 1)),
        );
        assert_eq!(short, format!("{base}|short@1"));
        // Two prompts sharing a num_ctx must not collide on one row.
        assert_ne!(short, gen_heavy);
    }
}
