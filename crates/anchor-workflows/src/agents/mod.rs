//! The agents Anchor ships, and the one event protocol they all stream.
//!
//! Every agent is a deterministic pipeline over `anchor-hub`'s streaming
//! generation composed with the tools in [`crate::tools`] — deliberately not an
//! agentic tool loop, for the same reason the Research Assistant isn't one: it
//! stays cheap and predictable. See `crate::research` for the worked example.
//!
//! The Research Assistant predates this module and keeps its own richer
//! `ResearchEvent`; it is not worth rewriting working code to converge them.

use anchor_hub::GenerationStats;
use serde::Serialize;

pub mod code_reviewer;
pub mod knowledge_base;
pub mod memory_chat;
pub mod pdf_qa;
pub mod web_researcher;

/// One streamed event from any agent.
///
/// Mirrored on the frontend as the `AgentEvent` union in `agents/types.ts`,
/// keyed on the `kind` tag.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    /// A lifecycle transition. The frontend turns consecutive transitions into
    /// the run's trace, so emit one per real phase change and no more.
    ///
    /// ponytail: a free-form `String`, not an enum. Each agent names its own
    /// phases without touching a shared type — which is what lets them be built
    /// in parallel. The cost is no exhaustiveness check on phase names.
    Status { phase: String },
    /// Something worth showing mid-run: a query, a file read, a retrieved chunk.
    /// `label` groups them, `text` is the detail.
    Note { label: String, text: String },
    /// A citable source the answer drew on, numbered `[1..]` in emission order.
    Source { title: String, url: String },
    /// One streamed answer delta.
    Token { text: String },
    /// The finished answer and its stats. Sources are *not* repeated here — the
    /// frontend accumulates the `Source` events it already received.
    Result {
        response: String,
        stats: GenerationStats,
    },
    /// The run failed; carries a human-readable message.
    Failed { message: String },
}

impl AgentEvent {
    /// `Status` for a phase.
    pub fn phase(name: &str) -> Self {
        AgentEvent::Status {
            phase: name.to_string(),
        }
    }

    /// A labelled note.
    pub fn note(label: &str, text: impl Into<String>) -> Self {
        AgentEvent::Note {
            label: label.to_string(),
            text: text.into(),
        }
    }

    /// A failure.
    pub fn failed(message: impl Into<String>) -> Self {
        AgentEvent::Failed {
            message: message.into(),
        }
    }
}

/// Trims a maybe-empty optional string to `None` when blank — the frontend sends
/// empty strings for unset fields. Same helper the research pipeline uses.
pub fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_tag_on_kind_in_snake_case() {
        let json = serde_json::to_string(&AgentEvent::phase("retrieving")).unwrap();
        assert_eq!(json, r#"{"kind":"status","phase":"retrieving"}"#);
        let json = serde_json::to_string(&AgentEvent::note("query", "apple silicon")).unwrap();
        assert_eq!(json, r#"{"kind":"note","label":"query","text":"apple silicon"}"#);
    }

    #[test]
    fn nonempty_treats_blank_as_unset() {
        assert_eq!(nonempty(&Some("  ".into())), None);
        assert_eq!(nonempty(&Some(" hi ".into())), Some("hi"));
        assert_eq!(nonempty(&None), None);
    }
}
