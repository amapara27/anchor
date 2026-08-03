//! The Knowledge Base agent: semantic Q&A over a corpus of ingested documents.
//!
//! Two entry points, because ingest and ask have different shapes: [`ingest`]
//! reads → chunks → embeds → stores, and [`run`] embeds the question, scans
//! stored vectors by cosine, and answers from the top matches.
//!
//! Embeddings come from `anchor_search::Embedder` (BGE-small, 384-dim) — the same
//! model Discover already downloads and uses, so this costs no new dependency.

use std::path::PathBuf;

use anchor_hub::Registry;
use serde::Deserialize;

use super::AgentEvent;

/// The agent id its runs are filed under. Matches the frontend template id.
pub const AGENT_ID: &str = "knowledge-base";

/// User-supplied configuration for a knowledge-base question.
///
/// Mirrored on the frontend as `KnowledgeBaseConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct KnowledgeBaseConfig {
    /// Model id to run (e.g. `"qwen2.5:14b"`).
    pub model: String,
    /// The question to answer from the corpus.
    pub question: String,
    /// How many chunks to retrieve. `None` uses the agent's default.
    #[serde(default)]
    pub top_k: Option<usize>,
}

/// A document to add to the corpus.
///
/// Mirrored on the frontend as `KbIngestConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct KbIngestConfig {
    /// Absolute path to the document.
    pub path: String,
    /// Display title. Falls back to the file name when absent.
    #[serde(default)]
    pub title: Option<String>,
}

/// Ingests one document into the corpus, streaming progress via `on_event`.
///
/// Streaming rather than request/response because embedding a long PDF is
/// hundreds of chunks and the panel needs something to show meanwhile.
pub async fn ingest<F>(registry: &Registry, cfg: &KbIngestConfig, cache_dir: PathBuf, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let _ = (registry, cfg, cache_dir);
    on_event(AgentEvent::failed("Knowledge Base ingest isn't built yet."));
}

/// Answers a question from the corpus, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(
    registry: &Registry,
    cfg: &KnowledgeBaseConfig,
    cache_dir: PathBuf,
    mut on_event: F,
) where
    F: FnMut(AgentEvent) + Send,
{
    let _ = (registry, cfg, cache_dir);
    on_event(AgentEvent::failed("The Knowledge Base agent isn't built yet."));
}
