//! Semantic model search for Anchor.
//!
//! Owns the curated model catalog (`profiles/models.json`), turns each model's
//! authored profile into a vector embedding via a local sentence-transformer
//! (`fastembed`, in-process ONNX — no Ollama needed for search), and holds the
//! result in an in-memory [`SemanticIndex`]. The cosine-similarity query itself
//! lands in a later phase; this module establishes the catalog, the embedder,
//! and the in-RAM index that ranking will read from.

use std::path::PathBuf;
use std::sync::Mutex;

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use serde::{Deserialize, Serialize};

/// The sentence-transformer used to embed profiles (and, later, queries).
/// BGE-small is a 384-dimensional model with a strong quality-to-size ratio.
const EMBED_MODEL: EmbeddingModel = EmbeddingModel::BGESmallENV15;

/// The curated catalog, bundled into the binary at compile time. This is
/// authored, shipped data — not user state — so embedding it is correct.
const PROFILES_JSON: &str = include_str!("../profiles/models.json");

/// Errors building or querying the semantic index.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("failed to parse bundled model profiles: {0}")]
    Profiles(#[from] serde_json::Error),
    // `fastembed::Error` is `anyhow::Error`, which doesn't implement
    // `std::error::Error`, so we can't `#[from]` it — carry the message instead.
    #[error("embedding model error: {0}")]
    Embed(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// A catalogued model and the authored description used to match it to a query.
///
/// Mirrors the entries in `profiles/models.json`. The richer counterpart of the
/// frontend `ModelSpec`/catalog; once this backend catalog is wired through,
/// `apps/desktop/src/lib/catalog.ts` can be retired.
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
    /// One-line summary shown in the UI.
    pub blurb: String,
    /// Short task tags, e.g. `["Code review", "Refactoring"]`.
    pub use_cases: Vec<String>,
    /// Rich, natural-language description of what the model is good for. This is
    /// the text that gets embedded for semantic matching against a user's query.
    pub profile: String,
}

/// Parse the bundled catalog. Runs offline (no model download).
pub fn load_profiles() -> Result<Vec<ModelProfile>> {
    Ok(serde_json::from_str(PROFILES_JSON)?)
}

/// Compose the text fed to the embedder for a profile. Centralised so query
/// embedding (next phase) stays consistent with how profiles were indexed.
fn embedding_text(p: &ModelProfile) -> String {
    format!(
        "{name} by {publisher}. {blurb} {profile} Use cases: {use_cases}.",
        name = p.name,
        publisher = p.publisher,
        blurb = p.blurb,
        profile = p.profile,
        use_cases = p.use_cases.join(", "),
    )
}

/// Thin wrapper over the local embedding model.
pub struct Embedder {
    model: TextEmbedding,
}

impl Embedder {
    /// Initialise the embedder, caching model files under `cache_dir` so they
    /// download only once (first launch) and persist across runs.
    pub fn new(cache_dir: PathBuf) -> Result<Self> {
        let options = InitOptions::new(EMBED_MODEL)
            .with_cache_dir(cache_dir)
            .with_show_download_progress(false);
        let model = TextEmbedding::try_new(options).map_err(|e| Error::Embed(e.to_string()))?;
        Ok(Self { model })
    }

    /// Embed a batch of texts into vectors (one per input, all the same length).
    pub fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.model
            .embed(texts, None)
            .map_err(|e| Error::Embed(e.to_string()))
    }
}

/// A model profile paired with its embedding vector.
#[derive(Debug, Clone)]
pub struct IndexEntry {
    pub profile: ModelProfile,
    pub embedding: Vec<f32>,
}

/// The in-RAM index built at launch: every catalogued profile plus its vector,
/// alongside the embedder (kept so a query can be embedded the same way without
/// reloading the model).
pub struct SemanticIndex {
    entries: Vec<IndexEntry>,
    // Used by the upcoming `search` step to embed the query; behind a `Mutex`
    // because `TextEmbedding::embed` takes `&mut self`.
    #[allow(dead_code)]
    embedder: Mutex<Embedder>,
}

impl SemanticIndex {
    /// Build the index: load the catalog, init the embedder (downloading the
    /// model on first run), embed every profile, and pair them up.
    pub fn build(cache_dir: PathBuf) -> Result<Self> {
        let profiles = load_profiles()?;
        let mut embedder = Embedder::new(cache_dir)?;
        let texts: Vec<String> = profiles.iter().map(embedding_text).collect();
        let embeddings = embedder.embed(&texts)?;
        let entries = profiles
            .into_iter()
            .zip(embeddings)
            .map(|(profile, embedding)| IndexEntry { profile, embedding })
            .collect();
        Ok(Self {
            entries,
            embedder: Mutex::new(embedder),
        })
    }

    /// Number of indexed models.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the index holds no models.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// All indexed entries (read access for the upcoming ranking step).
    pub fn entries(&self) -> &[IndexEntry] {
        &self.entries
    }

    // TODO(next phase): `search(&self, query: &str, k: usize) -> Vec<ScoredModel>`
    // — embed `query` via `self.embedder` and rank `entries` by cosine
    // similarity, returning the top-k profiles.
}

#[cfg(test)]
mod tests;
