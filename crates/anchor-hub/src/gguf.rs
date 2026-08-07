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
    /// input (arrays — in practice tokenizer vocabularies, megabytes long).
    fn value(&mut self, t: u32) -> std::result::Result<Option<Value>, Underrun> {
        if t == T_STRING {
            return Ok(Some(Value::String(self.string()?)));
        }
        if t == T_ARRAY {
            let elem = self.u32()?;
            let count = self.u64()? as usize;
            match width(elem) {
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

/// The digest of a tag's model layer — the GGUF itself, not the template or
/// licence layers that share the manifest.
async fn model_layer_digest(client: &reqwest::Client, name: &str, tag: &str) -> Result<String> {
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
    let manifest: Value = res.json().await.map_err(|e| Error::Http(e.to_string()))?;
    manifest["layers"]
        .as_array()
        .and_then(|ls| ls.iter().find(|l| l["mediaType"] == MODEL_MEDIA_TYPE))
        .and_then(|l| l["digest"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| Error::Ollama(format!("no model layer in manifest for {name}:{tag}")))
}

/// Reads `tag`'s GGUF metadata from the registry, as an `/api/show`-shaped map.
///
/// Grows the ranged read until the header parses, so a model whose architecture
/// keys sit behind a large array still resolves. Never downloads the weights.
pub async fn fetch_model_info(tag: &str) -> Result<Map<String, Value>> {
    let (name, version) = split_tag(tag);
    let client = client()?;
    let digest = model_layer_digest(&client, name, version).await?;
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
        let body = res.bytes().await.map_err(|e| Error::Http(e.to_string()))?;
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

#[cfg(test)]
mod tests;
