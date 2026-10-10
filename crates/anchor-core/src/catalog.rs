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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The bundled catalog parses cleanly and every entry is well-formed.
    #[test]
    fn load_profiles_parses_catalog() {
        let profiles = load_profiles().expect("catalog parses");
        assert!(
            profiles.len() >= 30,
            "expected a substantial catalog, got {}",
            profiles.len()
        );

        let mut ids = HashSet::new();
        for p in &profiles {
            assert!(!p.id.is_empty(), "a model has an empty id");
            assert!(!p.name.is_empty(), "{} has an empty name", p.id);
            assert!(!p.blurb.is_empty(), "{} has an empty blurb", p.id);
            assert!(!p.use_cases.is_empty(), "{} has no use cases", p.id);
            assert!(ids.insert(p.id.clone()), "duplicate id in catalog: {}", p.id);
        }
    }

    /// Every catalog entry carries the architecture metadata that `tools/
    /// generate-arch.mjs` writes, and each one is internally consistent.
    ///
    /// An entry may legitimately be `None` (the generator couldn't read that
    /// model's header), which degrades to a labelled size-bucket estimate. What
    /// must never happen is a *populated* entry that can't support exact KV math —
    /// that would present a guess as a measurement.
    #[test]
    fn catalog_carries_usable_arch_metadata() {
        let profiles = load_profiles().expect("catalog parses");
        let with_arch = profiles.iter().filter(|p| p.arch.is_some()).count();
        assert!(
            with_arch * 10 >= profiles.len() * 9,
            "expected nearly every catalog entry to carry arch metadata, got {with_arch}/{}",
            profiles.len()
        );
        for p in profiles.iter() {
            let Some(a) = &p.arch else { continue };
            assert!(a.architecture.is_some(), "{} has arch with no architecture", p.id);
            assert!(a.block_count.unwrap_or(0) > 0, "{} has no block_count", p.id);
            // KV sizing needs a per-head dimension: either the explicit key/value
            // lengths or enough to derive them as embedding_length / head_count.
            // Models with no KV heads at all (embedding models) are exempt.
            if a.head_count_kv.is_some() {
                let explicit = a.key_length.is_some() && a.value_length.is_some();
                let derivable = a.embedding_length.is_some() && a.head_count.is_some();
                assert!(explicit || derivable, "{} can't resolve a head dimension", p.id);
            }
        }
    }
}
