//! The Workflow Library and Tool System.
//!
//! Workflows are JSON-defined templates that pin a model, inject a system
//! prompt, set inference config, and toggle tools (web search, file reader,
//! memory). This is a stub describing the shape; execution lands later.

use serde::{Deserialize, Serialize};

pub mod agents;
pub mod research;
pub mod search;
pub mod tools;

pub use agents::AgentEvent;
pub use research::{run_research, Depth, Format, Phase, ResearchConfig, ResearchEvent};
pub use search::Source;

/// A tool a workflow may be allowed to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    WebSearch,
    FileReader,
    Memory,
}

/// A JSON-defined workflow template.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    /// Tools enabled for this workflow.
    pub tools: Vec<Tool>,
}

/// Returns the built-in workflow templates Anchor ships with.
///
/// Placeholder until the JSON template loader is implemented.
pub fn builtin_workflows() -> Vec<Workflow> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_serializes_snake_case() {
        let json = serde_json::to_string(&Tool::WebSearch).unwrap();
        assert_eq!(json, "\"web_search\"");
    }
}
