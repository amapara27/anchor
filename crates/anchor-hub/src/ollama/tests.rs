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

/// Runs the real `show_details` extraction against a wire payload, minus the HTTP.
fn parse_show(json: &str) -> ShowDetails {
    let resp: ShowResponse = serde_json::from_str(json).unwrap();
    details_from_info(&resp.model_info)
}

#[test]
fn show_response_extracts_architecture_fields() {
    // Trimmed real `/api/show` model_info for a Llama-3-family GGUF.
    let details = parse_show(
        r#"{
            "model_info": {
                "general.architecture": "llama",
                "llama.block_count": 32,
                "llama.context_length": 131072,
                "llama.embedding_length": 4096,
                "llama.attention.head_count": 32,
                "llama.attention.head_count_kv": 8,
                "llama.attention.key_length": 128,
                "llama.attention.value_length": 128
            }
        }"#,
    );
    let arch = details.arch;
    assert_eq!(arch.architecture.as_deref(), Some("llama"));
    assert_eq!(arch.block_count, Some(32));
    assert_eq!(arch.head_count, Some(32));
    assert_eq!(arch.head_count_kv, Some(8));
    assert_eq!(arch.key_length, Some(128));
    assert_eq!(arch.value_length, Some(128));
    assert_eq!(arch.sliding_window, None);
    // 32 layers x 8 kv heads x (128+128) x 2 bytes = 128 KiB/token.
    let per_token = arch.block_count.unwrap()
        * arch.head_count_kv.unwrap()
        * (arch.key_length.unwrap() + arch.value_length.unwrap())
        * 2;
    assert_eq!(per_token, 128 * 1024);
}

#[test]
fn architecture_keys_prefer_the_text_tower_over_a_vision_tower() {
    // Multimodal GGUFs carry a second set of keys under a different prefix. A
    // bare suffix scan takes whichever sorts first — here `clip.*` — so the
    // extraction must key off `general.architecture` instead.
    let details = parse_show(
        r#"{
            "model_info": {
                "general.architecture": "gemma3",
                "clip.block_count": 27,
                "clip.vision.attention.head_count": 16,
                "gemma3.block_count": 34,
                "gemma3.attention.head_count": 8,
                "gemma3.attention.head_count_kv": 4,
                "gemma3.attention.key_length": 256,
                "gemma3.attention.value_length": 256,
                "gemma3.attention.sliding_window": 1024,
                "gemma3.context_length": 131072
            }
        }"#,
    );
    assert_eq!(details.arch.block_count, Some(34));
    assert_eq!(details.arch.head_count, Some(8));
    assert_eq!(details.arch.sliding_window, Some(1024));
    assert_eq!(details.context_tokens, Some(131072));
}

#[test]
fn missing_architecture_metadata_yields_an_empty_arch() {
    let details = parse_show(r#"{"model_info": {"general.organization": "Meta"}}"#);
    assert!(details.arch.is_empty());
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

#[test]
fn generate_intermediate_frame_carries_token() {
    // A mid-stream frame has the next token in `response` and `done: false`.
    let frame: GenerateChunk =
        serde_json::from_str(r#"{"model":"llama3.1:8b","response":"Hello","done":false}"#)
            .unwrap();
    assert_eq!(frame.response, "Hello");
    assert!(!frame.done);
    assert!(frame.error.is_none());
    // No timing fields on an intermediate frame.
    assert_eq!(frame.eval_count, None);
}

#[test]
fn generate_final_frame_yields_stats() {
    // The terminal frame has `done: true`, an empty `response`, a `context`
    // array we ignore, and the timing fields used for tok/sec etc.
    let frame: GenerateChunk = serde_json::from_str(
        r#"{
            "model":"llama3.1:8b",
            "response":"",
            "done":true,
            "context":[1,2,3],
            "total_duration":5000000000,
            "load_duration":1000000000,
            "prompt_eval_count":12,
            "prompt_eval_duration":500000000,
            "eval_count":42,
            "eval_duration":2000000000
        }"#,
    )
    .unwrap();
    assert!(frame.done);
    let stats = frame.into_stats();
    assert_eq!(stats.total_duration_ns, Some(5_000_000_000));
    assert_eq!(stats.load_duration_ns, Some(1_000_000_000));
    assert_eq!(stats.prompt_eval_count, Some(12));
    assert_eq!(stats.prompt_eval_duration_ns, Some(500_000_000));
    assert_eq!(stats.eval_count, Some(42));
    assert_eq!(stats.eval_duration_ns, Some(2_000_000_000));
    // tok/sec the UI would compute: 42 / (2e9 / 1e9) = 21.
    let tok_per_sec =
        stats.eval_count.unwrap() as f64 / (stats.eval_duration_ns.unwrap() as f64 / 1e9);
    assert_eq!(tok_per_sec, 21.0);
}

#[test]
fn generate_captures_error_frame() {
    // Like pull, a generation failure arrives as an `{"error": ...}` frame on an
    // HTTP-200 stream and must parse so `generate` can surface it.
    let frame: GenerateChunk =
        serde_json::from_str(r#"{"error":"model 'ghost' not found"}"#).unwrap();
    assert_eq!(frame.error.as_deref(), Some("model 'ghost' not found"));
    assert!(!frame.done);
    assert_eq!(frame.response, "");
}

#[test]
fn comparison_request_uses_brevity_and_zero_keep_alive() {
    // The comparison preset must cap length and set keep_alive: 0 so weights are
    // evicted the instant the model finishes (freeing RAM for the next model).
    let req = GenerateRequest::for_comparison("llama3.1:8b", "Why is the sky blue?");
    assert_eq!(req.model, "llama3.1:8b");
    assert_eq!(req.prompt, "Why is the sky blue?");
    assert_eq!(req.num_predict, Some(DEFAULT_NUM_PREDICT));
    assert_eq!(req.system.as_deref(), Some(DEFAULT_SYSTEM_PROMPT));
    assert_eq!(req.keep_alive_secs, 0);
    // think: false so reasoning models answer directly instead of spending the
    // whole token budget on a `thinking` stream (leaving `response` empty).
    assert_eq!(req.think, Some(false));
}

#[test]
fn generate_chunk_captures_thinking() {
    // Thinking models stream reasoning in a separate `thinking` field with an
    // empty `response`; we must parse it so an answer-less stream can fall back.
    let frame: GenerateChunk =
        serde_json::from_str(r#"{"response":"","thinking":"Let me think","done":false}"#).unwrap();
    assert_eq!(frame.response, "");
    assert_eq!(frame.thinking, "Let me think");
}
