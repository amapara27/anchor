//! Subject resolution and the sizing decisions around the shared fit engine.
//! Kept in their own file so the rendering above stays readable — the engine's
//! own math is tested in `anchor_core::fit`, not here.

use super::*;
use anchor_core::ModelStatus;

/// 16 GB (decimal), matching the fixture the engine's own tests use.
const GB16: Option<u64> = Some(16_000_000_000);

fn model(id: &str) -> Model {
    Model {
        id: id.to_string(),
        name: id.to_string(),
        family: "llama".into(),
        size_bytes: Some(4_700_000_000),
        status: ModelStatus::Installed,
        parameter_size: Some("8.0B".into()),
        quantization: Some("Q4_K_M".into()),
        context_tokens: Some(131072),
        modified_at: None,
        publisher: None,
        arch: Some(ArchMeta {
            architecture: Some("llama".into()),
            block_count: Some(32),
            head_count_kv: Some(8),
            key_length: Some(128),
            value_length: Some(128),
            ..Default::default()
        }),
    }
}

// Ollama's own label is authoritative — the tag is only a fallback, and the two
// disagree often enough (`:latest`, renamed tags) that preferring the tag would
// silently size the wrong model.
#[test]
fn the_reported_parameter_label_wins_over_the_tag() {
    let mut m = model("llama3.1:70b");
    m.parameter_size = Some("8.0B".into());
    assert_eq!(from_installed(&m).params_b, 8.0);
}

#[test]
fn the_tag_suffix_is_the_fallback_when_no_label_is_reported() {
    let mut m = model("llama3.1:70b");
    m.parameter_size = None;
    assert_eq!(from_installed(&m).params_b, 70.0);
}

// An unparseable label must not fall through to the tag silently *and* must not
// panic — `0.0` is what makes the engine report `Unknown` rather than guess.
#[test]
fn an_unknown_parameter_count_becomes_zero() {
    let mut m = model("mystery:latest");
    m.parameter_size = None;
    assert_eq!(from_installed(&m).params_b, 0.0);
}

// A missing quant has to be a string the engine can look up and miss, not a
// panic and not an accidental "Q4_K_M" default that would under-report weights.
#[test]
fn missing_metadata_falls_back_rather_than_failing() {
    let mut m = model("llama3.1:8b");
    m.quantization = None;
    m.context_tokens = None;
    let subject = from_installed(&m);
    assert_eq!(subject.quant, "unknown");
    assert_eq!(subject.max_context, 0, "0 means 'ask fit_context for a default'");
}

// With no --ctx, sizing happens at Ollama's own load default rather than at the
// model's maximum — sizing a 131k-context model at 131k would report "won't
// fit" for a model that runs fine as actually loaded.
#[test]
fn the_default_context_is_ollamas_load_default_not_the_models_maximum() {
    let subject = from_installed(&model("llama3.1:8b"));
    let b = compute(&subject, None, None, GB16).unwrap();
    assert_eq!(b.context, anchor_core::fit::DEFAULT_CONTEXT);
}

// A model whose maximum is below the default is capped by its own maximum.
#[test]
fn a_small_maximum_context_caps_the_default() {
    let mut m = model("tiny:1b");
    m.context_tokens = Some(2048);
    let subject = from_installed(&m);
    assert_eq!(compute(&subject, None, None, GB16).unwrap().context, 2048);
}

#[test]
fn an_explicit_context_is_used_as_given() {
    let subject = from_installed(&model("llama3.1:8b"));
    assert_eq!(compute(&subject, Some(32768), None, GB16).unwrap().context, 32768);
}

// `--ctx 0` would divide by zero computing KV-per-token.
#[test]
fn a_zero_context_is_rejected_rather_than_dividing_by_zero() {
    let subject = from_installed(&model("llama3.1:8b"));
    let err = compute(&subject, Some(0), None, GB16).unwrap_err();
    assert!(err.contains("greater than zero"), "got {err:?}");
}

// `--quant` asks "what if I ran a different build", so the on-disk size of the
// build we actually have must not answer it. Without this rule the weights term
// would come back identical for every --quant, since real bytes outrank the
// quantisation estimate whenever they are present.
#[test]
fn an_explicit_quant_ignores_the_real_on_disk_size() {
    let subject = from_installed(&model("llama3.1:8b"));
    let real = compute(&subject, Some(4096), None, GB16).unwrap();
    let asked = compute(&subject, Some(4096), Some("Q8_0"), GB16).unwrap();
    assert_ne!(
        real.result.breakdown.weights_gb, asked.result.breakdown.weights_gb,
        "a hypothetical quant must be estimated, not read off disk"
    );
}

// KV per token is derived by dividing the cache by the context, so it has to be
// independent of the context it was measured at.
#[test]
fn kv_per_token_is_context_independent() {
    let subject = from_installed(&model("llama3.1:8b"));
    let small = compute(&subject, Some(4096), None, GB16).unwrap();
    let large = compute(&subject, Some(32768), None, GB16).unwrap();
    assert!(
        (small.kv_per_token - large.kv_per_token).abs() < 1.0,
        "{} vs {}",
        small.kv_per_token,
        large.kv_per_token
    );
}

// An unknown host memory has to reach the engine as `None` so it reports
// `Unknown`, rather than being coerced to 0 and reporting "won't fit".
#[test]
fn unknown_host_memory_is_unknown_not_zero() {
    let subject = from_installed(&model("llama3.1:8b"));
    let b = compute(&subject, Some(4096), None, None).unwrap();
    assert_eq!(b.result.tier, FitTier::Unknown);
}

#[test]
fn every_tier_has_a_verdict() {
    assert_eq!(verdict(FitTier::Ok), "ok");
    assert_eq!(verdict(FitTier::Tight), "tight");
    assert_eq!(verdict(FitTier::WontFit), "won't fit");
    assert!(verdict(FitTier::Unknown).starts_with("unknown"));
}
