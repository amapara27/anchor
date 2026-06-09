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

/// Returns the models Anchor currently knows about.
///
/// This is a placeholder until real on-disk discovery is implemented. It
/// exists so the desktop shell has a concrete command to call end-to-end.
pub fn list_models() -> Vec<Model> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_models_starts_empty() {
        assert!(list_models().is_empty());
    }

    #[test]
    fn model_status_serializes_lowercase() {
        let json = serde_json::to_string(&ModelStatus::Installed).unwrap();
        assert_eq!(json, "\"installed\"");
    }
}
