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
    /// Total resident bytes: weights + KV cache + compute buffers.
    #[serde(default)]
    size: Option<u64>,
    /// The `num_ctx` Ollama actually loaded this model with — which is not the
    /// model's advertised maximum, and not necessarily what was requested
    /// (Ollama clamps). The only trustworthy context figure for a loaded model.
    #[serde(default)]
    context_length: Option<u64>,
}

/// A model Ollama currently has loaded, with its resident size if reported.
///
/// Mirrored on the frontend as `RunningModel` in `types.ts` — the residency
/// readout renders these directly.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RunningModel {
    pub name: String,
    pub size_vram: Option<u64>,
    /// Total resident bytes (weights + KV + compute buffers), when reported.
    pub size: Option<u64>,
    /// The context length this model is actually loaded with, when reported.
    pub context_length: Option<u64>,
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
            size: e.size,
            context_length: e.context_length,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ps_wire_shape() {
        // Trimmed real `GET /api/ps` body; a missing field must stay None.
        let body = r#"{"models":[
            {"name":"llama3:latest","size":6979321856,"size_vram":5368709120,"context_length":8192},
            {"name":"qwen3:8b"}
        ]}"#;
        let resp: PsResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.models.len(), 2);
        assert_eq!(resp.models[0].name, "llama3:latest");
        assert_eq!(resp.models[0].size_vram, Some(5368709120));
        assert_eq!(resp.models[0].size, Some(6979321856));
        assert_eq!(resp.models[0].context_length, Some(8192));
        assert_eq!(resp.models[1].size_vram, None);
        assert_eq!(resp.models[1].size, None);
        assert_eq!(resp.models[1].context_length, None);
    }

    #[test]
    fn empty_body_yields_no_models() {
        let resp: PsResponse = serde_json::from_str("{}").unwrap();
        assert!(resp.models.is_empty());
    }
}
