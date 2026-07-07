//! Running-model status: which installed models Ollama currently has resident.
//!
//! Backs the menu-bar tray: a light `GET /api/ps` against the live server tells
//! us which weights are loaded right now (distinct from `/api/tags`, which lists
//! everything *installed*).

use std::time::Duration;

use serde::Deserialize;

use crate::{Error, Registry, Result};

/// Timeout for the quick `/api/ps` poll. Mirrors `ollama::REQUEST_TIMEOUT`'s
/// intent but kept local so the tray poll can't hang; it's a tiny response.
const PS_TIMEOUT: Duration = Duration::from_secs(5);

/// Response shape of `GET /api/ps`.
#[derive(Debug, Default, Deserialize)]
struct PsResponse {
    #[serde(default)]
    models: Vec<PsEntry>,
}

/// One resident model as reported by `/api/ps`.
#[derive(Debug, Deserialize)]
struct PsEntry {
    name: String,
    /// Bytes of the model currently held in VRAM/RAM, when reported.
    #[serde(default)]
    size_vram: Option<u64>,
}

/// A model Ollama currently has loaded, with its resident size if reported.
#[derive(Debug, Clone)]
pub struct RunningModel {
    pub name: String,
    pub size_vram: Option<u64>,
}

/// Returns the models Ollama currently has resident in memory, with each one's
/// resident size when reported (the tray shows both).
pub async fn running(registry: &Registry) -> Result<Vec<RunningModel>> {
    let url = format!("{}/api/ps", registry.host);
    let resp: PsResponse = reqwest::Client::builder()
        .timeout(PS_TIMEOUT)
        .build()
        .map_err(|e| Error::Http(e.to_string()))?
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp
        .models
        .into_iter()
        .map(|e| RunningModel {
            name: e.name,
            size_vram: e.size_vram,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ps_wire_shape() {
        // Trimmed real `GET /api/ps` body; a missing `size_vram` must stay None.
        let body = r#"{"models":[
            {"name":"llama3:latest","size_vram":5368709120},
            {"name":"qwen3:8b"}
        ]}"#;
        let resp: PsResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.models.len(), 2);
        assert_eq!(resp.models[0].name, "llama3:latest");
        assert_eq!(resp.models[0].size_vram, Some(5368709120));
        assert_eq!(resp.models[1].size_vram, None);
    }

    #[test]
    fn empty_body_yields_no_models() {
        let resp: PsResponse = serde_json::from_str("{}").unwrap();
        assert!(resp.models.is_empty());
    }
}
