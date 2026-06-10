//! Core domain logic for Anchor.
//!
//! This crate is intentionally free of any UI or Tauri dependencies so it can
//! be reused from the desktop app, a future CLI, or a headless service, and so
//! it can be tested without spinning up a webview.

use serde::{Deserialize, Serialize};

/// A local AI model that Anchor knows about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Model {
    /// Stable identifier, e.g. `"llama-3.1-8b-instruct"`.
    pub id: String,
    /// Human-friendly display name.
    pub name: String,
    /// Model family / architecture, e.g. `"llama"` or `"qwen"`.
    pub family: String,
    /// On-disk size in bytes, if known.
    pub size_bytes: Option<u64>,
    /// Whether the model is installed locally or merely available to install.
    pub status: ModelStatus,
    /// Ollama's parameter-size label, e.g. `"8.0B"`, if known.
    #[serde(default)]
    pub parameter_size: Option<String>,
    /// Quantisation level reported by Ollama, e.g. `"Q4_K_M"`, if known.
    #[serde(default)]
    pub quantization: Option<String>,
    /// Maximum context window in tokens, if known (from Ollama's `/api/show`).
    #[serde(default)]
    pub context_tokens: Option<u64>,
    /// Last-modified timestamp Ollama reports (ISO 8601), if known.
    #[serde(default)]
    pub modified_at: Option<String>,
    /// Producing lab / organisation, e.g. `"Meta"`, when the model's GGUF
    /// metadata exposes it (`general.organization` / `general.author`).
    #[serde(default)]
    pub publisher: Option<String>,
}

/// Installation state of a [`Model`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelStatus {
    /// Present on disk and ready to run.
    Installed,
    /// Known to Anchor but not yet downloaded.
    Available,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_status_serializes_lowercase() {
        let json = serde_json::to_string(&ModelStatus::Installed).unwrap();
        assert_eq!(json, "\"installed\"");
    }
}
