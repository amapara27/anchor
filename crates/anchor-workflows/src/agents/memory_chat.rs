//! The Local Memory Chat agent: a conversation that remembers across sessions.
//!
//! Recall is bounded-recent rather than embedded — see [`crate::tools::memory`].
//! A few dozen facts fit in a prompt outright, so similarity search would be
//! machinery without a payoff.

use anchor_hub::Registry;
use serde::Deserialize;

use super::AgentEvent;

/// The agent id its memories are filed under. Matches the frontend template id.
pub const AGENT_ID: &str = "local-memory-chat";

/// User-supplied configuration for one remembered turn.
///
/// Mirrored on the frontend as `MemoryChatConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct MemoryChatConfig {
    /// Model id to run (e.g. `"mistral:7b"`).
    pub model: String,
    /// What the user just said.
    pub message: String,
    /// Partitions memories — a project or conversation name. Blank means default.
    #[serde(default)]
    pub scope: Option<String>,
}

/// Runs one turn, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(registry: &Registry, cfg: &MemoryChatConfig, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let _ = (registry, cfg);
    on_event(AgentEvent::failed("The Local Memory Chat agent isn't built yet."));
}
