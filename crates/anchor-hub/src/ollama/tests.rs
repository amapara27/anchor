//! Unit tests for the Ollama wire-format mapping. Kept in their own file so the
//! client logic stays uncluttered and these are easy to grow or remove.

use super::*;

#[test]
fn tags_response_maps_to_models() {
    let json = r#"{
        "models": [
            {
                "name": "llama3.1:8b",
                "size": 4661226402,
                "modified_at": "2024-01-02T03:04:05Z",
                "details": {
                    "family": "llama",
                    "parameter_size": "8.0B",
                    "quantization_level": "Q4_K_M"
                }
            }
        ]
    }"#;
    let resp: TagsResponse = serde_json::from_str(json).unwrap();
    let models: Vec<Model> = resp.models.into_iter().map(tag_to_model).collect();
    assert_eq!(models.len(), 1);
    let m = &models[0];
    assert_eq!(m.id, "llama3.1:8b");
    assert_eq!(m.family, "llama");
    assert_eq!(m.size_bytes, Some(4661226402));
    assert_eq!(m.status, ModelStatus::Installed);
    assert_eq!(m.parameter_size.as_deref(), Some("8.0B"));
    assert_eq!(m.quantization.as_deref(), Some("Q4_K_M"));
    assert_eq!(m.modified_at.as_deref(), Some("2024-01-02T03:04:05Z"));
    assert_eq!(m.publisher, None);
}

/// Mirrors the `model_info` scanning in `show_details` without a live server.
fn parse_show(json: &str) -> ShowDetails {
    let resp: ShowResponse = serde_json::from_str(json).unwrap();
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
    ShowDetails {
        context_tokens,
        publisher,
    }
}

#[test]
fn show_response_extracts_context_and_publisher() {
    let details = parse_show(
        r#"{
            "model_info": {
                "general.architecture": "llama",
                "general.organization": "Meta",
                "llama.context_length": 131072,
                "llama.embedding_length": 4096
            }
        }"#,
    );
    assert_eq!(details.context_tokens, Some(131072));
    assert_eq!(details.publisher.as_deref(), Some("Meta"));
}

#[test]
fn show_response_falls_back_to_author_and_tolerates_missing() {
    let with_author = parse_show(r#"{"model_info": {"general.author": "Nomic AI"}}"#);
    assert_eq!(with_author.publisher.as_deref(), Some("Nomic AI"));
    assert_eq!(with_author.context_tokens, None);

    let empty = parse_show(r#"{"model_info": {}}"#);
    assert_eq!(empty, ShowDetails::default());

    // An absent `model_info` and an explicit `null` must both parse cleanly to
    // an empty map rather than erroring (which would drop the model's metadata).
    assert_eq!(parse_show(r#"{}"#), ShowDetails::default());
    assert_eq!(parse_show(r#"{"model_info": null}"#), ShowDetails::default());
}

#[test]
fn pull_progress_parses_partial_fields() {
    let manifest: PullProgress =
        serde_json::from_str(r#"{"status":"pulling manifest"}"#).unwrap();
    assert_eq!(manifest.status, "pulling manifest");
    assert!(manifest.total.is_none());

    let downloading: PullProgress = serde_json::from_str(
        r#"{"status":"downloading","digest":"sha256:abc","total":100,"completed":40}"#,
    )
    .unwrap();
    assert_eq!(downloading.total, Some(100));
    assert_eq!(downloading.completed, Some(40));
    assert_eq!(downloading.digest.as_deref(), Some("sha256:abc"));
}

#[test]
fn pull_progress_captures_error_frame() {
    // Ollama signals failures with a bare `{"error": ...}` frame (no `status`)
    // on an HTTP-200 stream; it must still parse so `pull` can fail on it rather
    // than skip it as an unparseable line.
    let frame: PullProgress =
        serde_json::from_str(r#"{"error":"model not found"}"#).unwrap();
    assert_eq!(frame.error.as_deref(), Some("model not found"));
    assert_eq!(frame.status, "");
}
