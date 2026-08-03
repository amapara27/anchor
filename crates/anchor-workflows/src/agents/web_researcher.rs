//! The Web Researcher agent: answer a question from live web search, with links.
//!
//! The Research Assistant's pipeline minus the query-planning generation — it
//! searches the question directly, so it is one generation instead of two.

use anchor_hub::Registry;
use serde::Deserialize;

use super::AgentEvent;

/// User-supplied configuration for a web research run.
///
/// Mirrored on the frontend as `WebResearcherConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct WebResearcherConfig {
    /// Model id to run (e.g. `"llama3.1:8b"`).
    pub model: String,
    /// The question to answer.
    pub question: String,
    /// Tavily API key. Falls back to `TAVILY_API_KEY` when absent.
    #[serde(default)]
    pub api_key: Option<String>,
}

/// Runs the agent, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(registry: &Registry, cfg: &WebResearcherConfig, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let _ = (registry, cfg);
    on_event(AgentEvent::failed("The Web Researcher agent isn't built yet."));
}
