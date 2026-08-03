//! The PDF Q&A agent: answer questions about one document.
//!
//! Single-document, stuffed into context — deliberately no retrieval. A corpus
//! that needs retrieval is what the Knowledge Base agent is for, and keeping the
//! split sharp keeps both agents simple.

use anchor_hub::Registry;
use serde::Deserialize;

use super::AgentEvent;

/// User-supplied configuration for a document Q&A run.
///
/// Mirrored on the frontend as `PdfQaConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct PdfQaConfig {
    /// Model id to run (e.g. `"qwen2.5:14b"`).
    pub model: String,
    /// Absolute path to the document.
    pub path: String,
    /// The question to answer about it.
    pub question: String,
    /// Context window to size the document budget against. `None` uses a default.
    #[serde(default)]
    pub num_ctx: Option<u32>,
}

/// Runs the agent, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(registry: &Registry, cfg: &PdfQaConfig, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let _ = (registry, cfg);
    on_event(AgentEvent::failed("The PDF Q&A agent isn't built yet."));
}
