//! The Batch Processor agent: one instruction applied across many files.
//!
//! The only agent whose output is a table rather than prose — N documents fan in,
//! one row each fans out. Extraction runs per file so a single bad document
//! degrades one row instead of failing the run.

use anchor_hub::Registry;
use serde::Deserialize;

use super::AgentEvent;

/// User-supplied configuration for a batch run.
///
/// Mirrored on the frontend as `BatchProcessorConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct BatchProcessorConfig {
    /// Model id to run (e.g. `"qwen2.5:14b"`).
    pub model: String,
    /// Absolute paths of the files to process, straight from the native picker.
    pub paths: Vec<String>,
    /// What to pull out of each file, in the user's words.
    pub instruction: String,
    /// Column names every row must fill, in order.
    pub columns: Vec<String>,
}

/// Runs the agent, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(registry: &Registry, cfg: &BatchProcessorConfig, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let _ = (registry, cfg);
    on_event(AgentEvent::failed("The Batch Processor agent isn't built yet."));
}
