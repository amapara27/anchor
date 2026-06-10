//! A thin async client for the local Ollama REST API.
//!
//! Anchor is a management layer, not an inference engine — it talks to a running
//! Ollama server (default `http://localhost:11434`) to discover, pull, and remove
//! models. Everything here maps Ollama's wire shapes onto [`anchor_core::Model`].

use std::time::Duration;

use anchor_core::{Model, ModelStatus};
use futures_util::StreamExt;
use serde::Deserialize;

use crate::{Error, Result};

/// Timeout for the quick request/response calls (`/api/tags`, `/api/show`,
/// `/api/delete`). The streaming pull uses its own timeouts (see [`pull`]).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait to connect when pulling.
const PULL_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Max idle gap between pull-stream reads before we give up. Ollama emits
/// progress frequently, so a long stall means the server is wedged.
const PULL_READ_TIMEOUT: Duration = Duration::from_secs(120);

/// Cap on a single NDJSON line. Ollama progress frames are tiny (<1 KiB), so a
/// line past this is a malformed/hostile stream, not real progress — bail rather
/// than buffer unboundedly.
const MAX_PULL_LINE_BYTES: usize = 1 << 20; // 1 MiB

/// A reqwest client with a total timeout, for the non-streaming endpoints.
fn request_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()?)
}

/// Response shape of `GET /api/tags`.
#[derive(Debug, Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagEntry>,
}

/// One installed model as reported by `/api/tags`.
#[derive(Debug, Deserialize)]
struct TagEntry {
    name: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    modified_at: Option<String>,
    #[serde(default)]
    details: TagDetails,
}

/// The `details` sub-object of a `/api/tags` entry.
#[derive(Debug, Default, Deserialize)]
struct TagDetails {
    #[serde(default)]
    family: Option<String>,
    #[serde(default)]
    parameter_size: Option<String>,
    #[serde(default)]
    quantization_level: Option<String>,
}

/// Response shape of `POST /api/show` (only the bits we use).
#[derive(Debug, Deserialize)]
struct ShowResponse {
    /// Architecture-keyed metadata, e.g. `{ "llama.context_length": 131072 }`.
    ///
    /// Some models report this as an explicit JSON `null` rather than omitting
    /// it; `deserialize_with` coalesces both an absent key and a `null` to an
    /// empty map so a missing field can't fail the whole parse (and thus lose
    /// the model's enrichment).
    #[serde(default, deserialize_with = "null_as_empty_map")]
    model_info: serde_json::Map<String, serde_json::Value>,
}

/// Deserialises a possibly-`null` JSON object as an empty map.
fn null_as_empty_map<'de, D>(
    de: D,
) -> std::result::Result<serde_json::Map<String, serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::deserialize(de)?.unwrap_or_default())
}

/// A single progress event from a streaming `POST /api/pull`.
///
/// Mirrored on the frontend as `PullProgress` in `types.ts`.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct PullProgress {
    /// Human-readable phase, e.g. `"pulling manifest"`, `"downloading"`, `"success"`.
    pub status: String,
    /// Layer digest being transferred, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// Total bytes for the current layer, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Bytes transferred so far for the current layer, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    /// An error Ollama reported mid-stream (e.g. unknown model). Ollama sends
    /// these with HTTP 200, so without this the pull would look successful.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Maps a `/api/tags` entry onto an Anchor [`Model`] marked installed.
fn tag_to_model(entry: TagEntry) -> Model {
    Model {
        id: entry.name.clone(),
        name: entry.name,
        family: entry.details.family.unwrap_or_default(),
        size_bytes: entry.size,
        status: ModelStatus::Installed,
        parameter_size: entry.details.parameter_size,
        quantization: entry.details.quantization_level,
        context_tokens: None,
        modified_at: entry.modified_at,
        publisher: None,
    }
}

/// Best-effort extra metadata pulled from `POST /api/show`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ShowDetails {
    /// Maximum context window in tokens, if exposed.
    pub context_tokens: Option<u64>,
    /// Producing lab / organisation, if exposed in the GGUF metadata.
    pub publisher: Option<String>,
}

/// Lists every model installed in the local Ollama server.
pub async fn list_local_models(host: &str) -> Result<Vec<Model>> {
    let url = format!("{host}/api/tags");
    let resp: TagsResponse = request_client()?
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp.models.into_iter().map(tag_to_model).collect())
}

/// Fetches best-effort extra metadata for a model via `POST /api/show`.
///
/// - Context window: Ollama keys this as `"<arch>.context_length"`
///   (e.g. `"llama.context_length"`), so we scan `model_info` for that suffix.
/// - Publisher: pulled from `general.organization`, falling back to
///   `general.author`. Many models omit these, so both stay `None` then.
///
/// Missing fields are returned as `None` rather than erroring — all of this is
/// enrichment, never required.
pub async fn show_details(host: &str, id: &str) -> Result<ShowDetails> {
    let url = format!("{host}/api/show");
    let resp: ShowResponse = request_client()?
        .post(&url)
        .json(&serde_json::json!({ "name": id }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let context_tokens = resp
        .model_info
        .iter()
        .find(|(k, _)| k.ends_with(".context_length"))
        .and_then(|(_, v)| v.as_u64());

    let publisher = resp
        .model_info
        .get("general.organization")
        .or_else(|| resp.model_info.get("general.author"))
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .filter(|s| !s.is_empty());

    Ok(ShowDetails {
        context_tokens,
        publisher,
    })
}

/// Pulls a model, invoking `on_progress` for each streamed NDJSON event.
///
/// The HTTP body is a stream of newline-delimited JSON objects; we buffer bytes
/// and parse each complete line. Malformed lines are skipped so one odd frame
/// can't abort an otherwise-healthy download.
pub async fn pull<F>(host: &str, id: &str, mut on_progress: F) -> Result<()>
where
    F: FnMut(PullProgress) + Send,
{
    let url = format!("{host}/api/pull");
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "name": id, "stream": true }))
        .send()
        .await?
        .error_for_status()?;

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk?);
        // Drain every complete line from the buffer, leaving any partial tail.
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let line = &line[..line.len() - 1];
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            if let Ok(event) = serde_json::from_slice::<PullProgress>(line) {
                on_progress(event);
            }
        }
    }
    // Flush a trailing line with no terminating newline.
    if !buf.iter().all(u8::is_ascii_whitespace) {
        if let Ok(event) = serde_json::from_slice::<PullProgress>(&buf) {
            on_progress(event);
        }
    }
    Ok(())
}

/// Removes a model from the local Ollama server via `DELETE /api/delete`.
pub async fn delete(host: &str, id: &str) -> Result<()> {
    let url = format!("{host}/api/delete");
    reqwest::Client::new()
        .delete(&url)
        .json(&serde_json::json!({ "name": id }))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

// `Error` needs `From<reqwest::Error>`; declared in lib.rs via thiserror.
impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Http(e.to_string())
    }
}

#[cfg(test)]
mod tests;
