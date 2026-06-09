//! The Model Hub: scans Ollama blob storage and the Hugging Face cache into a
//! single registry, deduplicates storage via a symlink manager, and keeps the
//! registry in sync with on-disk changes.
//!
//! This is a stub. The real implementation will back the registry with SQLite
//! (`rusqlite`) and walk the model caches (`walkdir`).

use anchor_core::Model;

/// The unified registry of locally known models.
#[derive(Debug, Default)]
pub struct Registry {
    models: Vec<Model>,
}

impl Registry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns every model currently in the registry.
    pub fn models(&self) -> &[Model] {
        &self.models
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_registry_is_empty() {
        assert!(Registry::new().models().is_empty());
    }
}
