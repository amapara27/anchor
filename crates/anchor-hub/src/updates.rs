//! Model update checks: which installed models have a newer version upstream.
//!
//! Ollama has no first-class "is there an update?" API, so we reproduce exactly
//! what `ollama pull` uses to decide "already up to date" vs "re-download": the
//! **manifest digest**. `/api/tags` reports each installed model's local manifest
//! digest; the registry Ollama pulls from (`registry.ollama.ai`) reports the
//! current one via the `Docker-Content-Digest` header. Digests differ → update.
//!
//! ponytail: registry digest diff; replace if Ollama ships a real update API.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::Registry;

/// Timeout for each registry/Ollama request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a fetched remote digest stays good before we re-query the registry.
/// The registry is rate-limited, so we throttle hard — updates are infrequent.
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// The registry Ollama pulls official/library models from. We only diff against
/// this; anything hosted elsewhere (e.g. `hf.co/...`) yields "no update" rather
/// than a guess.
const OLLAMA_REGISTRY: &str = "registry.ollama.ai";

const MANIFEST_ACCEPT: &str = "application/vnd.docker.distribution.manifest.v2+json";

/// Module-level cache of `model_id -> (fetched_at, remote_manifest_digest)`.
///
/// We cache only the *remote* digest (the rate-limited part), not the yes/no
/// answer. The local digest is re-read cheaply every call, so once the user
/// re-pulls, the local digest matches and the badge clears immediately — no
/// stale "update available" hanging around for the TTL. `None` caches a failed
/// or unsupported lookup so we don't hammer a rate-limited/offline registry.
fn cache() -> &'static Mutex<HashMap<String, (Instant, Option<String>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Option<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns `(model_id, update_available)` for each installed model.
///
/// Fails silently, always: Ollama unreachable → empty list; a per-model
/// registry error/rate-limit/parse failure → `false` for that model. This never
/// errors the whole call, so a flaky network can't break the library UI.
pub async fn check_updates(registry: &Registry) -> crate::Result<Vec<(String, bool)>> {
    // ponytail: registry digest diff; replace if Ollama ships a real update API.
    let installed = match local_digests(&registry.host).await {
        Ok(v) => v,
        // Ollama down/unreachable: no data to compare, so no updates to report.
        Err(_) => return Ok(Vec::new()),
    };

    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::with_capacity(installed.len());
    for (id, local_digest) in installed {
        // A missing/failed remote digest means "couldn't check" → not an update.
        let available = remote_digest_cached(&client, &id)
            .await
            .is_some_and(|remote| remote != local_digest);
        out.push((id, available));
    }
    Ok(out)
}

/// Local `(model_id, manifest_digest)` pairs from `/api/tags`. This is the same
/// digest Ollama compares on pull, so it lines up with the registry's.
async fn local_digests(host: &str) -> crate::Result<Vec<(String, String)>> {
    #[derive(Deserialize)]
    struct Tags {
        #[serde(default)]
        models: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        name: String,
        #[serde(default)]
        digest: String,
    }

    let url = format!("{host}/api/tags");
    let resp: Tags = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()?
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    Ok(resp
        .models
        .into_iter()
        .filter(|m| !m.digest.is_empty())
        .map(|m| (m.name, m.digest))
        .collect())
}

/// Cached remote-digest lookup: serve a fresh cache entry, else query the
/// registry and store the result (success or failure) with a timestamp.
async fn remote_digest_cached(client: &reqwest::Client, id: &str) -> Option<String> {
    // Fresh cache hit? (Guard dropped before any await — never held across one.)
    if let Some((at, digest)) = cache().lock().unwrap().get(id).cloned() {
        if at.elapsed() < CACHE_TTL {
            return digest;
        }
    }

    // Only models on the Ollama registry are checkable; skip (and cache) others.
    let digest = match parse_name(id) {
        Some((path, tag)) => fetch_remote_digest(client, &path, &tag).await,
        None => None,
    };
    cache()
        .lock()
        .unwrap()
        .insert(id.to_string(), (Instant::now(), digest.clone()));
    digest
}

/// GETs the remote manifest and returns its `Docker-Content-Digest`, handling a
/// one-shot bearer-token challenge (the registry gates even public reads).
async fn fetch_remote_digest(client: &reqwest::Client, path: &str, tag: &str) -> Option<String> {
    let url = format!("https://{OLLAMA_REGISTRY}/v2/{path}/manifests/{tag}");
    let resp = client
        .get(&url)
        .header("Accept", MANIFEST_ACCEPT)
        .send()
        .await
        .ok()?;

    // 401 → fetch an anonymous token from the advertised realm, then retry once.
    let resp = if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let challenge = resp.headers().get("www-authenticate")?.to_str().ok()?;
        let token = fetch_token(client, challenge).await?;
        client
            .get(&url)
            .header("Accept", MANIFEST_ACCEPT)
            .bearer_auth(token)
            .send()
            .await
            .ok()?
    } else {
        resp
    };

    if !resp.status().is_success() {
        return None;
    }
    // ponytail: trust the header; skip sha256-of-body fallback if it's absent.
    resp.headers()
        .get("docker-content-digest")?
        .to_str()
        .ok()
        .map(str::to_owned)
}

/// Parses a `WWW-Authenticate: Bearer realm=...,service=...,scope=...` challenge
/// and fetches an anonymous token from the realm.
async fn fetch_token(client: &reqwest::Client, challenge: &str) -> Option<String> {
    let params = challenge.strip_prefix("Bearer ")?;
    let mut realm = None;
    let mut query: Vec<String> = Vec::new();
    for part in params.split(',') {
        let (k, v) = part.split_once('=')?;
        let (k, v) = (k.trim(), v.trim().trim_matches('"'));
        match k {
            "realm" => realm = Some(v.to_string()),
            // Token servers accept the `:`/`/` in a scope raw; no encoder dep needed.
            "service" | "scope" => query.push(format!("{k}={v}")),
            _ => {}
        }
    }
    let sep = if query.is_empty() { "" } else { "?" };
    let token_url = format!("{}{sep}{}", realm?, query.join("&"));

    #[derive(Deserialize)]
    struct Token {
        #[serde(default)]
        token: String,
        #[serde(default)]
        access_token: String,
    }
    let tok: Token = client
        .get(&token_url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let tok = if tok.token.is_empty() { tok.access_token } else { tok.token };
    (!tok.is_empty()).then_some(tok)
}

/// Splits an Ollama model id into `(registry_path, tag)` for `registry.ollama.ai`,
/// or `None` if it targets some other registry (e.g. `hf.co/...`) — which we
/// don't diff. Mirrors Ollama's name grammar: `[host/][namespace/]model[:tag]`,
/// defaulting the namespace to `library` and the tag to `latest`.
fn parse_name(id: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = id.split('/').collect();
    let (namespace, model_tag) = match parts.as_slice() {
        [m] => ("library", *m),
        // A first component with a `.`/`:` is a host, not a namespace → not us.
        [ns, m] if !ns.contains('.') && !ns.contains(':') => (*ns, *m),
        [host, ns, m] if *host == OLLAMA_REGISTRY => (*ns, *m),
        _ => return None,
    };
    let (model, tag) = model_tag.split_once(':').unwrap_or((model_tag, "latest"));
    if model.is_empty() {
        return None;
    }
    Some((format!("{namespace}/{model}"), tag.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_name_resolves_library_namespace_and_default_tag() {
        assert_eq!(parse_name("llama3.1:8b"), Some(("library/llama3.1".into(), "8b".into())));
        assert_eq!(parse_name("qwen3"), Some(("library/qwen3".into(), "latest".into())));
        // Explicit user namespace passes through.
        assert_eq!(parse_name("user/model:v2"), Some(("user/model".into(), "v2".into())));
        // Fully-qualified Ollama registry.
        assert_eq!(
            parse_name("registry.ollama.ai/library/phi3:mini"),
            Some(("library/phi3".into(), "mini".into())),
        );
    }

    #[test]
    fn parse_name_skips_foreign_and_malformed() {
        // Non-Ollama hosts aren't diffable.
        assert_eq!(parse_name("hf.co/user/model:q4"), None);
        assert_eq!(parse_name("other.registry.com/library/x"), None);
        // A leading host-looking namespace (has a dot) is treated as a host → skip.
        assert_eq!(parse_name("some.host/model"), None);
        assert_eq!(parse_name(":8b"), None);
        assert_eq!(parse_name("a/b/c/d"), None);
    }
}
