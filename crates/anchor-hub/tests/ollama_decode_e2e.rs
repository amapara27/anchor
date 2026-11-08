//! Opt-in installed runtime → versioned evidence → post-first decode → backward-compatible replay.
use anchor_core::HwIdentity;
use anchor_hub::{bench::evidence::{DecodeConvention, Outcome}, Registry, RepeatsMode};
use std::{path::PathBuf, sync::atomic::AtomicBool};

#[tokio::test]
#[ignore = "requires ANCHOR_OLLAMA_E2E_HOST and ANCHOR_OLLAMA_E2E_MODEL (a GGUF model) on local Ollama 0.32+"]
async fn post_first_decode_uses_the_observed_backend_and_retains_raw_counters() {
    let host = std::env::var("ANCHOR_OLLAMA_E2E_HOST").expect("set the isolated local server host");
    let model = std::env::var("ANCHOR_OLLAMA_E2E_MODEL").expect("set an installed model");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let dir = std::env::var_os("ANCHOR_E2E_ARTIFACT_DIR")
        .map(|p| PathBuf::from(p).join("ollama-evidence"))
        .unwrap_or_else(|| root.join(".internal/benchmarking/decode-validation/ollama"));
    std::fs::create_dir_all(&dir).unwrap();
    let registry = Registry::open_with_host(dir.join("registry.db"), &host).unwrap();
    let hw = HwIdentity::from_profile(&anchor_system::Profiler::profile_now());
    let cancel = AtomicBool::new(false);
    let runs = registry
        .run_benchmark(
            &model,
            &hw,
            "decode-e2e",
            RepeatsMode::Thorough,
            Some("classify"),
            &cancel,
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].suite_version, 5);
    let e = registry.bench_evidence(&runs[0].id).unwrap();
    assert_eq!(e.session.outcome, Outcome::Completed);
    assert_eq!(e.session.formula_version, 2);
    assert_eq!(e.session.config.decode_convention, Some(DecodeConvention::FirstTokenUntimed), "GGUF model");
    // The matching runner observation is only collected on the 0.34.4 build it was recorded against.
    let pinned = e.session.config.runtime_version.as_deref() == Some("0.34.4");
    let mut step_ns = f64::MAX;
    let mut legacy = e.clone();
    legacy.session.formula_version = 1;
    let old = legacy.recalculate().unwrap();
    for ((attempt, metric), previous) in e
        .attempts
        .iter()
        .zip(&e.derived.attempts)
        .zip(&old.attempts)
    {
        if pinned {
            let observation = attempt.calibration.as_ref().unwrap().decode_timing.as_ref().unwrap();
            assert_eq!(observation.runtime_version, "0.34.4");
            assert_eq!(observation.build_info, "b1-161755f29");
            assert_eq!(observation.model, model);
        }
        let n = metric.counters.eval_count.unwrap();
        let ns = metric.counters.eval_duration_ns.unwrap();
        assert!(n > 1 && ns > 0);
        step_ns = step_ns.min(ns as f64 / (n - 1) as f64);
        assert_eq!(
            metric.decode_tps.value,
            Some((n - 1) as f64 / (ns as f64 / 1e9))
        );
        assert_eq!(
            previous.decode_tps.value,
            Some(n as f64 / (ns as f64 / 1e9))
        );
        assert_eq!(metric.first_output_ms, previous.first_output_ms);
        assert!(metric.validation_errors.is_empty());
    }
    let file = dir.join(format!("{}.json", e.session.id));
    std::fs::write(&file, serde_json::to_vec_pretty(&e).unwrap()).unwrap();
    let stored = std::fs::read(&file).unwrap();
    let exported: anchor_hub::bench::evidence::EvidenceExport =
        serde_json::from_slice(&stored).unwrap();
    assert_eq!(
        serde_json::to_value(exported.recalculate().unwrap()).unwrap(),
        serde_json::to_value(&e.derived).unwrap()
    );
    eprintln!("Retained normal decode evidence: {}", file.display());
    let calibration = registry
        .calibrate_ollama(&model, &hw, "decode-e2e", &cancel, |_| {})
        .await
        .unwrap();
    assert_eq!(calibration.session.outcome, Outcome::Completed);
    let index = calibration
        .session
        .config
        .attempts
        .iter()
        .position(|p| p.scenario_id == "cap_one")
        .unwrap();
    let one = &calibration.derived.attempts[index];
    assert_eq!(one.counters.eval_count, Some(1));
    // The convention itself, measured on this build: a one-token reply's generation timer holds
    // none of that token's work, so it stays far below one ordinary decode step.
    assert!((one.counters.eval_duration_ns.unwrap() as f64) < step_ns / 2.0,
        "cap-one eval_duration {:?} ns vs decode step {step_ns} ns", one.counters.eval_duration_ns);
    assert_eq!(
        one.decode_tps.unavailable_reason.as_deref(),
        Some("no_post_first_token_decode_work")
    );
    assert!(one.first_output_ms.value.is_some());
    let probe = &calibration.derived.calibration.as_ref().unwrap().probes[index];
    assert_eq!(probe.post_first_decode_tps, None);
    assert!(
        probe.diagnostic_decode_tps.unwrap() > 0.0,
        "the original runtime rate stays separate"
    );
    let file = dir.join(format!("{}.json", calibration.session.id));
    std::fs::write(&file, serde_json::to_vec_pretty(&calibration).unwrap()).unwrap();
    eprintln!("Retained one-token evidence: {}", file.display());
}
