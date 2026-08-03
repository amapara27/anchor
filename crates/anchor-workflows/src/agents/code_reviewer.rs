//! The Code Reviewer agent: focused feedback on a file or a diff.

use anchor_hub::Registry;
use serde::Deserialize;

use super::AgentEvent;

/// User-supplied configuration for a review run.
///
/// Exactly one of `path` / `diff` is expected; the agent reports a usable error
/// when both or neither arrive.
///
/// Mirrored on the frontend as `CodeReviewerConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct CodeReviewerConfig {
    /// Model id to run (e.g. `"qwen2.5-coder:7b"`).
    pub model: String,
    /// Absolute path to a source file to review.
    #[serde(default)]
    pub path: Option<String>,
    /// A pasted unified diff to review instead of a file.
    #[serde(default)]
    pub diff: Option<String>,
    /// Optional extra instructions ("focus on error handling").
    #[serde(default)]
    pub focus: Option<String>,
}

/// Runs the agent, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(registry: &Registry, cfg: &CodeReviewerConfig, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let _ = (registry, cfg);
    on_event(AgentEvent::failed("The Code Reviewer agent isn't built yet."));
}
