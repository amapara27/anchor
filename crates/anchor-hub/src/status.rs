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
    #[serde(default)]
    digest: Option<String>,
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
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct RunningModel {
    pub name: String,
    pub digest: Option<String>,
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
            digest: e.digest,
            size_vram: e.size_vram,
            size: e.size,
            context_length: e.context_length,
        })
        .collect())
}
