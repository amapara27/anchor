//! A thin async client for the local Ollama REST API.
//!
//! Anchor is a management layer, not an inference engine — it talks to a running
//! Ollama server (default `http://localhost:11434`) to discover, pull, and remove
//! models. Everything here maps Ollama's wire shapes onto [`anchor_core::Model`].

use std::time::Duration;

use anchor_core::{ArchMeta, Model, ModelStatus};
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

/// How long to wait to connect when generating.
const GENERATE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Max idle gap between generate-stream reads. The first token can lag while a
/// large model's weights load into RAM, so this is generous; a longer stall means
/// the server is wedged.
const GENERATE_READ_TIMEOUT: Duration = Duration::from_secs(300);

/// Cap on a single generate NDJSON line. Token frames are tiny; the final frame
/// carries a `context` token array we ignore, but it stays well under this.
const MAX_GENERATE_LINE_BYTES: usize = 1 << 20; // 1 MiB

/// Default brevity preprompt for comparison runs — shorter answers mean less
/// wait time when generating both models back-to-back.
pub const DEFAULT_SYSTEM_PROMPT: &str = "Answer concisely and directly.";

/// Default hard cap on generated tokens for comparison runs.
pub const DEFAULT_NUM_PREDICT: u64 = 256;

/// The running server's version string, from `GET /api/version`.
///
/// Recorded on benchmark results: throughput changes between Ollama releases, so
/// a number without its version isn't comparable.
pub async fn version(host: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct VersionResponse {
        #[serde(default)]
        version: String,
    }
    let resp: VersionResponse = request_client()?
        .get(format!("{host}/api/version"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp.version)
}

/// Content digest for an installed model, or `None` if it isn't installed.
pub async fn digest_of(host: &str, id: &str) -> Result<Option<String>> {
    let url = format!("{host}/api/tags");
    let resp: TagsResponse = request_client()?
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp
        .models
        .into_iter()
        .find(|m| m.name == id)
        .and_then(|m| m.digest))
}

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
    /// Content digest. The model's true identity — a tag can be re-pointed at a
    /// different build, so benchmark results are keyed on this, not the name.
    #[serde(default)]
    digest: Option<String>,
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
    ///
    /// Defaults to empty: Ollama's mid-stream error frame is a bare
    /// `{"error": ...}` with no `status`, and this must still parse so the error
    /// is surfaced rather than skipped as an unparseable line.
    #[serde(default)]
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

/// Parameters for a streaming `POST /api/generate` call.
#[derive(Debug, Clone)]
pub struct GenerateRequest {
    /// Model id (Ollama name, e.g. `"llama3.1:8b"`).
    pub model: String,
    /// The user prompt to run.
    pub prompt: String,
    /// System preprompt (e.g. a brevity instruction). `None` omits it.
    pub system: Option<String>,
    /// Hard cap on generated tokens (`options.num_predict`). `None` leaves it to Ollama.
    pub num_predict: Option<u64>,
    /// `keep_alive` in seconds. `0` evicts the model's weights immediately after
    /// responding (used so a comparison can free RAM before loading the next model).
    pub keep_alive_secs: i64,
    /// Whether a thinking-capable model should emit its reasoning. `Some(false)`
    /// makes such models answer directly (reasoning otherwise streams in a
    /// separate `thinking` field, leaving `response` empty — see [`generate`]).
    /// Ignored by models that don't support thinking. `None` omits the field.
    pub think: Option<bool>,
    /// Context window to load with (`options.num_ctx`). `None` leaves Ollama's
    /// default. A benchmark must pin this — throughput and memory both depend
    /// on it, so an unpinned run isn't comparable to anyone else's.
    pub num_ctx: Option<u32>,
    /// Sampling temperature (`options.temperature`). `None` leaves the default.
    pub temperature: Option<f32>,
}

impl GenerateRequest {
    /// A comparison-tuned request: brevity preprompt, capped length, and
    /// `keep_alive: 0` so the weights are evicted the instant the model finishes,
    /// freeing RAM for the next model in a side-by-side comparison.
    ///
    /// `think: false` keeps thinking-capable models (e.g. qwen3) answering
    /// directly — otherwise their reasoning eats the whole `num_predict` budget
    /// and `response` comes back empty.
    pub fn for_comparison(model: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            prompt: prompt.into(),
            system: Some(DEFAULT_SYSTEM_PROMPT.to_string()),
            num_predict: Some(DEFAULT_NUM_PREDICT),
            keep_alive_secs: 0,
            think: Some(false),
            num_ctx: None,
            temperature: None,
        }
    }

    /// A measurement-tuned request.
    ///
    /// Differs from [`for_comparison`](Self::for_comparison) on every axis that
    /// affects a number: no brevity preprompt (it shortens the answer, and we
    /// want a fixed token count), `temperature: 0` so the same prompt does the
    /// same work every time, and an explicit `num_ctx` because throughput
    /// depends on it. `keep_alive` is held open so the caller can read the
    /// resident size out of `/api/ps` before the weights are evicted.
    pub fn for_benchmark(
        model: impl Into<String>,
        prompt: impl Into<String>,
        num_predict: u64,
        num_ctx: u32,
    ) -> Self {
        Self {
            model: model.into(),
            prompt: prompt.into(),
            system: None,
            num_predict: Some(num_predict),
            keep_alive_secs: 60,
            think: Some(false),
            num_ctx: Some(num_ctx),
            temperature: Some(0.0),
        }
    }
}

/// One NDJSON frame from a streaming `POST /api/generate`. Intermediate frames
/// carry a `response` token; the final frame has `done: true` plus the timing
/// fields below (all in nanoseconds). Unknown fields (e.g. `context`) are ignored.
#[derive(Debug, Default, Deserialize)]
struct GenerateChunk {
    #[serde(default)]
    response: String,
    /// Reasoning text from a thinking model. Normally suppressed via
    /// `think: false`; captured so a thinking-only stream can still surface text.
    #[serde(default)]
    thinking: String,
    #[serde(default)]
    done: bool,
    /// An error Ollama reported mid-stream (HTTP 200), same shape as a pull error.
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    total_duration: Option<u64>,
    #[serde(default)]
    load_duration: Option<u64>,
    #[serde(default)]
    prompt_eval_count: Option<u64>,
    #[serde(default)]
    prompt_eval_duration: Option<u64>,
    #[serde(default)]
    eval_count: Option<u64>,
    #[serde(default)]
    eval_duration: Option<u64>,
}

impl GenerateChunk {
    /// Pulls the timing fields out of a final (`done`) frame.
    fn into_stats(self) -> GenerationStats {
        GenerationStats {
            total_duration_ns: self.total_duration,
            load_duration_ns: self.load_duration,
            prompt_eval_count: self.prompt_eval_count,
            prompt_eval_duration_ns: self.prompt_eval_duration,
            eval_count: self.eval_count,
            eval_duration_ns: self.eval_duration,
        }
    }
}

/// Timing/throughput stats from a completed generation, surfaced to the UI.
///
/// Raw nanosecond durations and token counts — the frontend formats them (e.g.
/// tok/sec = `eval_count / (eval_duration_ns / 1e9)`). Mirrored on the frontend
/// as `GenerationStats` in `types.ts`.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct GenerationStats {
    /// Total wall time for the request, in nanoseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_duration_ns: Option<u64>,
    /// Time spent loading the model's weights into RAM, in nanoseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_duration_ns: Option<u64>,
    /// Tokens in the prompt that were evaluated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_eval_count: Option<u64>,
    /// Time spent evaluating the prompt, in nanoseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_eval_duration_ns: Option<u64>,
    /// Tokens generated in the response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_count: Option<u64>,
    /// Time spent generating the response, in nanoseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_duration_ns: Option<u64>,
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
        arch: None,
    }
}

/// Best-effort extra metadata pulled from `POST /api/show`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ShowDetails {
    /// Maximum context window in tokens, if exposed.
    pub context_tokens: Option<u64>,
    /// Producing lab / organisation, if exposed in the GGUF metadata.
    pub publisher: Option<String>,
    /// Architecture fields driving exact KV-cache math. Empty when the GGUF
    /// exposes none of them.
    pub arch: ArchMeta,
}

/// Reads a `u64` out of the GGUF `model_info` map by key suffix.
///
/// Keys are architecture-prefixed (`llama.block_count`, `qwen3.attention.
/// head_count_kv`). When the architecture is known, the exact `{arch}.{suffix}`
/// key is tried first: multimodal GGUFs carry a second tower whose keys share
/// these suffixes (`clip.vision.block_count`), and a bare suffix scan would take
/// whichever happened to sort first in the map rather than the text tower.
fn info_u64(
    info: &serde_json::Map<String, serde_json::Value>,
    arch: Option<&str>,
    suffix: &str,
) -> Option<u64> {
    let dotted = format!(".{suffix}");
    arch.and_then(|a| info.get(&format!("{a}.{suffix}")))
        .or_else(|| {
            info.iter()
                .find(|(k, _)| k.ends_with(&dotted))
                .map(|(_, v)| v)
        })
        .and_then(serde_json::Value::as_u64)
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
///   (e.g. `"llama.context_length"`), so we look it up by suffix.
/// - Publisher: pulled from `general.organization`, falling back to
///   `general.author`. Many models omit these, so both stay `None` then.
/// - Architecture: the layer/head/head-dim fields that make exact KV-cache
///   sizing possible (see [`ArchMeta`]).
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

    Ok(details_from_info(&resp.model_info))
}

/// The pure half of [`show_details`]: `model_info` map in, [`ShowDetails`] out.
///
/// Split out so it can be tested against real wire payloads without a live
/// server, and so the tests exercise the shipped extraction rather than a copy.
fn details_from_info(info: &serde_json::Map<String, serde_json::Value>) -> ShowDetails {
    let architecture = info
        .get("general.architecture")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let a = architecture.as_deref();

    let publisher = info
        .get("general.organization")
        .or_else(|| info.get("general.author"))
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .filter(|s| !s.is_empty());

    let context_tokens = info_u64(info, a, "context_length");
    let arch = ArchMeta {
        block_count: info_u64(info, a, "block_count"),
        head_count: info_u64(info, a, "attention.head_count"),
        head_count_kv: info_u64(info, a, "attention.head_count_kv"),
        embedding_length: info_u64(info, a, "embedding_length"),
        key_length: info_u64(info, a, "attention.key_length"),
        value_length: info_u64(info, a, "attention.value_length"),
        sliding_window: info_u64(info, a, "attention.sliding_window"),
        key_length_swa: info_u64(info, a, "attention.key_length_swa"),
        value_length_swa: info_u64(info, a, "attention.value_length_swa"),
        kv_lora_rank: info_u64(info, a, "attention.kv_lora_rank"),
        architecture,
    };

    ShowDetails {
        context_tokens,
        publisher,
        arch,
    }
}

/// Drains an NDJSON response body, invoking `on_line` for each complete
/// non-blank line (including a trailing line with no terminating newline).
///
/// Bounds the per-line buffer at `max_line_bytes`: a single line past the cap
/// means a malformed/hostile stream — bail rather than buffer unboundedly.
/// Callers skip lines that don't parse, so one odd frame can't abort an
/// otherwise-healthy stream.
async fn for_each_ndjson_line<F>(
    resp: reqwest::Response,
    max_line_bytes: usize,
    mut on_line: F,
) -> Result<()>
where
    F: FnMut(&[u8]) -> Result<()> + Send,
{
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk?);
        // Drain every complete line from the buffer, leaving any partial tail.
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let line = &line[..line.len() - 1];
            if !line.iter().all(u8::is_ascii_whitespace) {
                on_line(line)?;
            }
        }
        if buf.len() > max_line_bytes {
            return Err(Error::Ollama(format!(
                "stream line exceeded {max_line_bytes} bytes"
            )));
        }
    }
    // Flush a trailing line with no terminating newline.
    if !buf.iter().all(u8::is_ascii_whitespace) {
        on_line(&buf)?;
    }
    Ok(())
}

/// Pulls a model, invoking `on_progress` for each streamed NDJSON event.
pub async fn pull<F>(host: &str, id: &str, mut on_progress: F) -> Result<()>
where
    F: FnMut(PullProgress) + Send,
{
    let url = format!("{host}/api/pull");
    // A pull can run for many minutes, so no total timeout — just bound the
    // connect and the idle gap between reads so a wedged server can't hang us.
    let client = reqwest::Client::builder()
        .connect_timeout(PULL_CONNECT_TIMEOUT)
        .read_timeout(PULL_READ_TIMEOUT)
        .build()?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "name": id, "stream": true }))
        .send()
        .await?
        .error_for_status()?;

    for_each_ndjson_line(resp, MAX_PULL_LINE_BYTES, |line| {
        if let Ok(event) = serde_json::from_slice::<PullProgress>(line) {
            // Ollama reports failures as a `{"error": ...}` frame on an
            // HTTP-200 stream, so surface it rather than report success.
            if let Some(err) = &event.error {
                return Err(Error::Ollama(err.clone()));
            }
            on_progress(event);
        }
        Ok(())
    })
    .await
}

/// Runs a streaming generation, invoking `on_token` for each non-empty response
/// delta and returning the full text plus the final [`GenerationStats`].
///
/// A mid-stream `{"error": ...}` frame (HTTP 200) surfaces as an error.
/// `keep_alive: 0` (set via [`GenerateRequest`]) makes Ollama evict the weights
/// as soon as this returns.
pub async fn generate<F>(
    host: &str,
    req: &GenerateRequest,
    mut on_token: F,
) -> Result<(String, GenerationStats)>
where
    F: FnMut(&str) + Send,
{
    let url = format!("{host}/api/generate");
    // Like a pull, a generation has no useful total deadline (it depends on the
    // answer length); bound the connect and the idle gap between reads instead.
    let client = reqwest::Client::builder()
        .connect_timeout(GENERATE_CONNECT_TIMEOUT)
        .read_timeout(GENERATE_READ_TIMEOUT)
        .build()?;

    let mut body = serde_json::json!({
        "model": req.model,
        "prompt": req.prompt,
        "stream": true,
        "keep_alive": req.keep_alive_secs,
    });
    if let Some(system) = &req.system {
        body["system"] = serde_json::Value::String(system.clone());
    }
    let mut options = serde_json::Map::new();
    if let Some(num_predict) = req.num_predict {
        options.insert("num_predict".into(), num_predict.into());
    }
    if let Some(num_ctx) = req.num_ctx {
        options.insert("num_ctx".into(), num_ctx.into());
    }
    if let Some(temperature) = req.temperature {
        options.insert("temperature".into(), temperature.into());
    }
    if !options.is_empty() {
        body["options"] = serde_json::Value::Object(options);
    }
    if let Some(think) = req.think {
        body["think"] = serde_json::Value::Bool(think);
    }

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    let mut text = String::new();
    // Reasoning text, kept only as a fallback for a model that thinks anyway.
    let mut thinking = String::new();
    let mut stats = GenerationStats::default();

    for_each_ndjson_line(resp, MAX_GENERATE_LINE_BYTES, |line| {
        // Fold one parsed frame into text/thinking/stats; an error frame bails.
        if let Ok(frame) = serde_json::from_slice::<GenerateChunk>(line) {
            if let Some(err) = frame.error {
                return Err(Error::Ollama(err));
            }
            if !frame.response.is_empty() {
                on_token(&frame.response);
                text.push_str(&frame.response);
            }
            if !frame.thinking.is_empty() {
                thinking.push_str(&frame.thinking);
            }
            if frame.done {
                stats = frame.into_stats();
            }
        }
        Ok(())
    })
    .await?;

    // A thinking model can ignore `think: false` and spend its whole budget on
    // reasoning, leaving `response` empty — fall back to the reasoning so the
    // caller never gets a blank answer when the model clearly produced output.
    if text.is_empty() && !thinking.is_empty() {
        text = thinking;
    }
    Ok((text, stats))
}

/// Removes a model from the local Ollama server via `DELETE /api/delete`.
pub async fn delete(host: &str, id: &str) -> Result<()> {
    let url = format!("{host}/api/delete");
    request_client()?
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
