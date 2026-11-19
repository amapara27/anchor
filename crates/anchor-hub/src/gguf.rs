//! Reads a model's GGUF metadata header straight from the Ollama registry,
//! without downloading the model.
//!
//! Exists because `/api/show` only answers for models that are already
//! installed. Judging whether a *browsable* tag fits this Mac needs the same
//! architecture fields, and the only other place they exist is inside the GGUF
//! file itself — whose metadata section sits at the very front, so a ranged read
//! of the first megabyte is enough. Typically ~1 MB against a 4–40 GB model.
//!
//! The output is deliberately shaped as Ollama's `/api/show` `model_info` map,
//! so [`ollama::details_from_info`](crate::ollama::details_from_info) — the
//! reader already used for installed models — consumes it unchanged. One
//! extraction, two transports.

use serde_json::{Map, Number, Value};

use crate::{Error, Result};

const REGISTRY: &str = "https://registry.ollama.ai/v2/library";
const MODEL_MEDIA_TYPE: &str = "application/vnd.ollama.image.model";
const DRAFT_MEDIA_TYPE: &str = "application/vnd.ollama.image.draft";
const PARAMS_MEDIA_TYPE: &str = "application/vnd.ollama.image.params";
const MANIFEST_ACCEPT: &str = "application/vnd.docker.distribution.manifest.v2+json";

/// Identifies Anchor rather than pretending to be a browser.
const USER_AGENT: &str = concat!("anchor/", env!("CARGO_PKG_VERSION"), " (+local model manager)");

const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// First ranged read. Every model tried so far carries its architecture keys
/// well inside this; the tokenizer vocabulary that follows them does not fit,
/// and does not need to.
const FIRST_CHUNK: usize = 1024 * 1024;
/// Ceiling on paging, for a model that buries its arch keys behind a big array.
const MAX_CHUNK: usize = 16 * 1024 * 1024;
const MAX_MANIFEST: usize = 1024 * 1024;

/// Longest array kept: comfortably past any layer count, far short of a vocab.
const MAX_LAYER_ARRAY: usize = 4096;

/// GGUF metadata value types. Types 8 (string) and 9 (array) are variable-width.
const T_STRING: u32 = 8;
const T_ARRAY: u32 = 9;

/// Fixed-width types → byte width.
fn width(t: u32) -> Option<usize> {
    Some(match t {
        0 | 1 | 7 => 1,
        2 | 3 => 2,
        4 | 5 | 6 => 4,
        10 | 11 | 12 => 8,
        _ => return None,
    })
}

/// A read that ran past the end of the buffer — the caller refetches more.
struct Underrun;

/// Cursor over the ranged read, tracking whether it fell off the end.
struct Cursor<'a> {
    buf: &'a [u8],
    off: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> std::result::Result<&'a [u8], Underrun> {
        let end = self.off.checked_add(n).ok_or(Underrun)?;
        let slice = self.buf.get(self.off..end).ok_or(Underrun)?;
        self.off = end;
        Ok(slice)
    }
    fn u32(&mut self) -> std::result::Result<u32, Underrun> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> std::result::Result<u64, Underrun> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn string(&mut self) -> std::result::Result<String, Underrun> {
        let n = self.u64()? as usize;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }

    /// Reads one value, returning `None` for kinds that are never a KV-sizing
    /// input: string arrays and long arrays (tokenizer vocabularies, megabytes
    /// long). Short numeric/bool arrays are kept — per-layer patterns such as
    /// `sliding_window_pattern` and an array-valued `head_count_kv` live there.
    fn value(&mut self, t: u32) -> std::result::Result<Option<Value>, Underrun> {
        if t == T_STRING {
            return Ok(Some(Value::String(self.string()?)));
        }
        if t == T_ARRAY {
            let elem = self.u32()?;
            let count = self.u64()? as usize;
            match width(elem) {
                Some(_) if count <= MAX_LAYER_ARRAY => {
                    let mut items = Vec::with_capacity(count);
                    for _ in 0..count {
                        items.push(self.value(elem)?.unwrap_or(Value::Null));
                    }
                    return Ok(Some(Value::Array(items)));
                }
                Some(w) => {
                    self.take(w.saturating_mul(count))?;
                }
                None if elem == T_STRING => {
                    for _ in 0..count {
                        self.string()?;
                    }
                }
                // A nested or unknown array type: the layout past this point is
                // unknowable, so stop rather than misread every later key.
                None => return Err(Underrun),
            }
            return Ok(None);
        }
        let w = width(t).ok_or(Underrun)?;
        let raw = self.take(w)?;
        Ok(match t {
            0 => Some(raw[0].into()),
            1 => Some((raw[0] as i8).into()),
            2 => Some(u16::from_le_bytes(raw.try_into().unwrap()).into()),
            3 => Some(i16::from_le_bytes(raw.try_into().unwrap()).into()),
            4 => Some(u32::from_le_bytes(raw.try_into().unwrap()).into()),
            5 => Some(i32::from_le_bytes(raw.try_into().unwrap()).into()),
            6 => Number::from_f64(f32::from_le_bytes(raw.try_into().unwrap()) as f64).map(Value::Number),
            7 => Some(Value::Bool(raw[0] != 0)),
            10 => Some(u64::from_le_bytes(raw.try_into().unwrap()).into()),
            11 => Some(i64::from_le_bytes(raw.try_into().unwrap()).into()),
            12 => Number::from_f64(f64::from_le_bytes(raw.try_into().unwrap())).map(Value::Number),
            _ => None,
        })
    }
}

/// Parses a GGUF header into an Ollama-shaped `model_info` map.
///
/// `Err(Underrun)` means the buffer ended mid-header, not that the file is bad —
/// [`fetch_model_info`] responds by reading further.
fn parse_header(buf: &[u8]) -> std::result::Result<Map<String, Value>, Underrun> {
    let mut c = Cursor { buf, off: 0 };
    if c.take(4)? != b"GGUF" {
        // Not a GGUF at all: no amount of extra bytes will help, but the caller
        // can only distinguish that by re-reading, so report it as a short read
        // and let the chunk ceiling end it.
        return Err(Underrun);
    }
    let version = c.u32()?;
    if !(2..=3).contains(&version) {
        return Err(Underrun);
    }
    let _tensor_count = c.u64()?;
    let kv_count = c.u64()?;

    let mut info = Map::new();
    for _ in 0..kv_count {
        let key = c.string()?;
        let t = c.u32()?;
        if let Some(v) = c.value(t)? {
            info.insert(key, v);
        }
    }
    Ok(info)
}

/// `"mixtral:8x7b"` → `("mixtral", "8x7b")`; a bare name defaults to `latest`.
fn split_tag(tag: &str) -> (&str, &str) {
    match tag.split_once(':') {
        Some((name, t)) => (name, t),
        None => (tag, "latest"),
    }
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| Error::Http(e.to_string()))
}

async fn read_prefix(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(limit);
    while bytes.len() < limit {
        let Some(chunk) = response.chunk().await? else {
            break;
        };
        let count = chunk.len().min(limit - bytes.len());
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(bytes)
}

/// A tag's model and (optional) speculative draft layer digests — the GGUFs
/// themselves, not the template or licence layers that share the manifest.
async fn layer_digests(client: &reqwest::Client, name: &str, tag: &str) -> Result<(String, Option<String>, Option<String>)> {
    let url = format!("{REGISTRY}/{name}/manifests/{tag}");
    let res = client
        .get(&url)
        .header(reqwest::header::ACCEPT, MANIFEST_ACCEPT)
        .send()
        .await
        .map_err(|e| Error::Http(e.to_string()))?;
    if !res.status().is_success() {
        return Err(Error::Http(format!("manifest {} for {name}:{tag}", res.status())));
    }
    let bytes = read_prefix(res, MAX_MANIFEST + 1).await?;
    if bytes.len() > MAX_MANIFEST {
        return Err(Error::Http(format!("manifest exceeds {MAX_MANIFEST} bytes for {name}:{tag}")));
    }
    let manifest: Value = serde_json::from_slice(&bytes)?;
    let model = layer_digest(&manifest, MODEL_MEDIA_TYPE)
        .ok_or_else(|| Error::Ollama(format!("no model layer in manifest for {name}:{tag}")))?;
    Ok((model, layer_digest(&manifest, DRAFT_MEDIA_TYPE), layer_digest(&manifest, PARAMS_MEDIA_TYPE)))
}

fn layer_digest(manifest: &Value, media_type: &str) -> Option<String> {
    manifest["layers"]
        .as_array()?
        .iter()
        .find(|l| l["mediaType"] == media_type)?["digest"]
        .as_str()
        .map(str::to_owned)
}

/// What the registry says about a tag, without downloading its weights.
pub struct RegistryInfo {
    /// The model's GGUF metadata, shaped like `/api/show`'s `model_info`.
    pub info: Map<String, Value>,
    /// The speculative draft model's, when the manifest carries one.
    pub draft: Option<Map<String, Value>>,
    /// `draft_num_predict` from the tag's params layer.
    pub draft_num_predict: Option<u64>,
}

/// Reads `tag`'s GGUF metadata from the registry, plus its drafter's.
///
/// Grows the ranged read until the header parses, so a model whose architecture
/// keys sit behind a large array still resolves. Never downloads the weights.
pub async fn fetch_model_info(tag: &str) -> Result<RegistryInfo> {
    let (name, version) = split_tag(tag);
    let client = client()?;
    let (model, draft, params) = layer_digests(&client, name, version).await?;
    let info = fetch_header(&client, name, &model, tag).await?;
    let Some(draft) = draft else {
        return Ok(RegistryInfo { info, draft: None, draft_num_predict: None });
    };
    let draft = Some(fetch_header(&client, name, &draft, tag).await?);
    // The params layer is a small JSON object of default options; missing or
    // unreadable means Ollama's own default applies.
    let draft_num_predict = match params {
        Some(digest) => fetch_json(&client, name, &digest).await.ok().and_then(|p| p["draft_num_predict"].as_u64()),
        None => None,
    };
    Ok(RegistryInfo { info, draft, draft_num_predict })
}

async fn fetch_json(client: &reqwest::Client, name: &str, digest: &str) -> Result<Value> {
    let res = client
        .get(format!("{REGISTRY}/{name}/blobs/{digest}"))
        .send()
        .await
        .map_err(|e| Error::Http(e.to_string()))?;
    if !res.status().is_success() {
        return Err(Error::Http(format!("params blob {}", res.status())));
    }
    let bytes = read_prefix(res, MAX_MANIFEST + 1).await?;
    if bytes.len() > MAX_MANIFEST {
        return Err(Error::Http("params blob too large".into()));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

async fn fetch_header(client: &reqwest::Client, name: &str, digest: &str, tag: &str) -> Result<Map<String, Value>> {
    let url = format!("{REGISTRY}/{name}/blobs/{digest}");
    let mut size = FIRST_CHUNK;
    while size <= MAX_CHUNK {
        let res = client
            .get(&url)
            .header(reqwest::header::RANGE, format!("bytes=0-{}", size - 1))
            .send()
            .await
            .map_err(|e| Error::Http(e.to_string()))?;
        if !res.status().is_success() {
            return Err(Error::Http(format!("blob {} for {tag}", res.status())));
        }
        // A server can ignore Range and stream the entire model with a 200.
        let body = read_prefix(res, size).await?;
        let short = body.len() < size;
        if let Ok(info) = parse_header(&body) {
            return Ok(info);
        }
        // The server returned less than we asked for, so the whole file is
        // already in hand — reading again would return the same bytes.
        if short {
            break;
        }
        size *= 4;
    }
    Err(Error::Ollama(format!("could not read GGUF header for {tag}")))
}

/// An installed model's speculative draft header, read from Ollama's local
/// store: `/api/show` says nothing about the drafter. `None` when the model has
/// none, or the store isn't where Anchor looks (`storage::models_root`).
pub fn local_draft_info(model_id: &str) -> Option<Map<String, Value>> {
    let root = crate::storage::models_root()?;
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifests").join(manifest_path(model_id)?)).ok()?).ok()?;
    // The name and digest come from the server and the manifest: only a plain
    // `sha256:<64 hex>` may become a path inside blobs/.
    let digest = layer_digest(&manifest, DRAFT_MEDIA_TYPE)?;
    let hex = digest.strip_prefix("sha256:").filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let blob = root.join("blobs").join(format!("sha256-{hex}"));
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(std::fs::File::open(blob).ok()?, MAX_CHUNK as u64), &mut buf).ok()?;
    parse_header(&buf).ok()
}

/// `gemma4:e2b` → `registry.ollama.ai/library/gemma4/e2b`, the layout Ollama
/// stores manifests in; `user/model` and `host/ns/model` keep their prefixes.
/// `None` for any component that could leave the manifests directory.
fn manifest_path(model_id: &str) -> Option<std::path::PathBuf> {
    let (name, tag) = split_tag(model_id);
    let parts: Vec<&str> = name.split('/').collect();
    let safe = |p: &str| !p.is_empty() && p != "." && p != ".." && !p.contains('\\');
    if !parts.iter().all(|p| safe(p)) || !safe(tag) || tag.contains('/') {
        return None;
    }
    let full = match parts.len() {
        1 => format!("registry.ollama.ai/library/{name}"),
        2 => format!("registry.ollama.ai/{name}"),
        _ => name.to_string(),
    };
    Some(std::path::Path::new(&full).join(tag))
}

#[cfg(test)]
#[path = "../tests/fixtures/gguf_http.rs"]
mod http_e2e;
