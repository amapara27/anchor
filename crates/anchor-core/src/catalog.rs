//! The curated model catalog: authored display specs and GGUF architecture
//! metadata for suggested models, bundled into the binary at compile time.

use serde::{Deserialize, Serialize};

use crate::ArchMeta;

/// Authored, shipped data — not user state — so embedding it is correct.
const PROFILES_JSON: &str = include_str!("../profiles/models.json");

/// What a model can do. Surfaced as badges and filters in the UI.
/// Mirrors the frontend `Capability` (serialised lowercase).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Vision,
    Code,
    Embedding,
    Reasoning,
    General,
}

/// One catalogued model. Mirrors the entries in `profiles/models.json` and the
/// frontend `ModelProfile`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProfile {
    /// Canonical Ollama tag, e.g. `"qwen2.5-coder:7b"`.
    pub id: String,
    /// Human-friendly display name.
    pub name: String,
    /// Model family / architecture, e.g. `"llama"` or `"qwen"`.
    pub family: String,
    /// Producing lab / organisation, e.g. `"Meta"`.
    pub publisher: String,
    /// Parameter count in billions.
    pub params_b: f32,
    /// Maximum context window in tokens.
    pub context_tokens: u64,
    /// Quantisation of the default Ollama variant, e.g. `"Q4_K_M"` or `"F16"`.
    pub quant: String,
    /// Catalog estimate of the download size in gigabytes (binary, GiB). The
    /// real on-disk size from Ollama overrides this once installed. Kept in GB
    /// (not bytes) so the JSON stays human-authorable; the frontend converts.
    pub download_gb: f32,
    /// GGUF architecture fields, read from the model's real header by
    /// `tools/generate-arch.mjs` and shipped with the catalog.
    ///
    /// Exists because `/api/show` only answers for *installed* models, so
    /// without this an uninstalled model's KV cache falls back to a
    /// parameter-count bucket — wrong by up to 8x on MHA, in the optimistic
    /// direction. `None` when the generator couldn't read a model's header;
    /// that degrades to the bucket, which the UI labels as an estimate.
    #[serde(default)]
    pub arch: Option<ArchMeta>,
    /// One-line summary shown in the UI.
    pub blurb: String,
    /// Short task tags, e.g. `["Code review", "Refactoring"]`.
    pub use_cases: Vec<String>,
    /// What the model can do — at least one entry.
    pub capabilities: Vec<Capability>,
}

/// Parse the bundled catalog. Runs offline.
pub fn load_profiles() -> Result<Vec<ModelProfile>, serde_json::Error> {
    serde_json::from_str(PROFILES_JSON)
}
