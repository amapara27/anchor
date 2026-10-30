//! Opt-in real text suite: actual worker/GPU → immutable evidence → shared rows → offline replay.
use anchor_core::HwIdentity;
use anchor_hub::{
    bench::{
        evidence::{EventKind, EvidenceExport, Outcome},
        CATALOG,
    },
    BenchProgress, Registry, RepeatsMode,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

#[tokio::test]
#[ignore = "requires Apple GPU, uv and ANCHOR_MLX_E2E_MODEL"]
async fn shared_mlx_text_suite_retains_real_generation_and_replays() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let model =
        PathBuf::from(std::env::var_os("ANCHOR_MLX_E2E_MODEL").expect("set ANCHOR_MLX_E2E_MODEL"));
    let dir = root.join(".internal/benchmarking/mlx-suite-validation");
    std::fs::create_dir_all(&dir).unwrap();
    let registry = Registry::open(dir.join("registry.db")).unwrap();
    let hw = HwIdentity::from_profile(&anchor_system::Profiler::profile_now());
    let cancel = AtomicBool::new(false);
    let only = std::env::var("ANCHOR_MLX_E2E_SCENARIO").ok();
    let result = registry
        .run_mlx_suite(
            &model,
            &root.join("workers/mlx"),
            &hw,
            "mlx-suite-e2e",
            RepeatsMode::Fast,
            only.as_deref(),
            &cancel,
            |p| match p {
                BenchProgress::ScenarioStarted { scenario_id, .. } => {
                    eprintln!("MLX scenario {scenario_id}")
                }
                BenchProgress::Status { message } => eprintln!("{message}"),
                _ => {}
            },
        )
        .unwrap();
    let session = registry.bench_sessions(1).unwrap().remove(0);
    assert_eq!(session.outcome, Outcome::Completed, "{:?}", session.error);
    let export = registry.bench_evidence(&session.id).unwrap();
    let expected = if only.is_some() { 1 } else { 9 };
    assert_eq!(result.len(), expected);
    assert_eq!(export.derived.scenarios.len(), expected);
    assert!(export.derived.scenarios.iter().all(|s| s.complete));
    assert!(
        export.results.is_empty(),
        "MLX rows are replayed views, not duplicate stored summaries"
    );
    assert!(export.derived.native.is_none());
    let report = export.derived.mlx.as_ref().unwrap();
    assert!(report.boundaries_validated);
    assert_eq!(report.identity_unchanged, Some(true));
    assert!(!report.comparison_eligible);
    assert_eq!(report.quality, "unchecked");
    assert!(report.load_peak_bytes.unwrap() > 0);
    assert!(session
        .config
        .mlx
        .as_ref()
        .unwrap()
        .identity
        .as_ref()
        .unwrap()["python"]
        .as_str()
        .unwrap()
        .starts_with("3.11."));
    assert_eq!(report.memory.len(), export.attempts.len());
    assert_eq!(session.formula_version, 2);
    assert_eq!(session.config.suite_version, 5);
    let mut legacy = export.clone();
    legacy.session.formula_version = 1;
    let legacy_metrics = legacy.recalculate().unwrap();
    for (index, (a, m)) in export
        .attempts
        .iter()
        .zip(&export.derived.attempts)
        .enumerate()
    {
        let plan = &session.config.attempts[a.plan_index];
        if !plan.is_warmup {
            assert_eq!(
                plan.request.prompt,
                CATALOG
                    .iter()
                    .find(|s| s.id == plan.scenario_id)
                    .unwrap()
                    .text()
            );
        }
        assert_eq!(a.outcome, Outcome::Completed);
        assert!(m.validation_errors.is_empty(), "{:?}", m.validation_errors);
        assert_eq!(m.counter_status, "diagnostic");
        assert!(m.first_answer_ms.value.is_none());
        assert!(
            m.counters.eval_duration_ns.is_none() && m.counters.prompt_eval_duration_ns.is_none(),
            "do not reconstruct durations from upstream rates"
        );
        let f: Vec<Value> = a
            .events
            .iter()
            .filter_map(|e| {
                if let EventKind::Frame { bytes } = &e.kind {
                    Some(serde_json::from_slice(bytes).unwrap())
                } else {
                    None
                }
            })
            .collect();
        let input = f.iter().find(|f| f["kind"] == "mlx_input").unwrap();
        let terminal = f.iter().find(|f| f["done"] == true).unwrap();
        let offsets = input["cache_offsets"].as_array().unwrap();
        let empty = input["cache_empty"].as_array().unwrap();
        let types = input["cache_types"].as_array().unwrap();
        assert!(!types.is_empty());
        assert_eq!(types.len(), offsets.len());
        assert_eq!(empty.len(), types.len());
        assert!(empty.iter().all(|v| v == true));
        assert!(offsets.iter().all(|v| v.is_null() || v == 0));
        assert!(types.iter().all(|v| v.as_str().unwrap().starts_with("mlx_lm.")));
        assert_eq!(terminal["mlx"]["cache_types"], input["cache_types"]);
        assert_eq!(
            m.counters.prompt_eval_count,
            Some(input["ids"].as_array().unwrap().len() as u64)
        );
        assert_eq!(
            legacy_metrics.attempts[index].decode_tps.value,
            terminal["mlx"]["generation_tps"].as_f64()
        );
        assert_eq!(m.prefill_tps.value, terminal["mlx"]["prompt_tps"].as_f64());
        let first_sample = f
            .iter()
            .find(|f| f["kind"] == "generation" && f["done"] == false)
            .unwrap();
        let count = terminal["eval_count"].as_u64().unwrap();
        let ns =
            terminal["worker_ns"].as_u64().unwrap() - first_sample["worker_ns"].as_u64().unwrap();
        assert_eq!(
            m.decode_tps.value,
            (count > 1).then(|| (count - 1) as f64 * 1e9 / ns as f64)
        );
        assert_eq!(
            terminal["mlx"]["token_ids"].as_array().unwrap().len() as u64,
            m.counters.eval_count.unwrap()
        );
        assert!(m.counters.eval_count.unwrap() <= plan.request.num_predict.unwrap());
        let first = a.events.iter().find(|e| {
            if let EventKind::Frame { bytes } = &e.kind {
                serde_json::from_slice::<Value>(bytes).unwrap()["response"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            } else {
                false
            }
        });
        assert_eq!(m.first_output_ms.value, first.map(|e| e.at_ns as f64 / 1e6));
    }
    let bytes = serde_json::to_vec_pretty(&export).unwrap();
    std::fs::write(dir.join(format!("{}.json", session.id)), &bytes).unwrap();
    let mut replay: EvidenceExport = serde_json::from_slice(&bytes).unwrap();
    replay.derived.mlx = None;
    assert_eq!(
        serde_json::to_value(replay.recalculate().unwrap()).unwrap(),
        serde_json::to_value(&export.derived).unwrap()
    );
    assert!(
        registry
            .bench_runs_for(&hw, None, Some(anchor_hub::bench::SUITE_ID), None, None)
            .unwrap()
            .is_empty(),
        "never blend into Ollama's leaderboard"
    );
    let views = registry
        .mlx_suite_runs(&hw, Some(&model), Some(&model), None, false)
        .unwrap();
    assert_eq!(views.len(), expected);
    assert!(views
        .iter()
        .all(|r| r.ollama_version.is_none() && r.resident_bytes.is_none()));
    assert!(registry
        .mlx_suite_runs(&hw, None, Some(&dir.join("other-tokenizer")), None, false)
        .unwrap()
        .is_empty());
    replay.session.config.mlx.as_mut().unwrap().protocol_version += 1;
    assert!(replay.recalculate().is_err());
    let mut reused = export.clone();
    for e in &mut reused.attempts[1].events {
        if let EventKind::Frame { bytes } = &mut e.kind {
            let mut f: Value = serde_json::from_slice(bytes).unwrap();
            if f["kind"] == "mlx_input" {
                f["cache_empty"][0] = json!(false);
                *bytes = serde_json::to_vec(&f).unwrap();
            }
        }
    }
    assert!(reused.recalculate().unwrap().scenarios.iter().any(|s| !s.complete), "a reused native cache must reject results");
    let mut corrupt = export.clone();
    for e in &mut corrupt.attempts[1].events {
        if let EventKind::Frame { bytes } = &mut e.kind {
            let mut f: Value = serde_json::from_slice(bytes).unwrap();
            if f["done"] == true {
                f["mlx"]["token_ids"] = json!([]);
                *bytes = serde_json::to_vec(&f).unwrap();
            }
        }
    }
    assert!(!corrupt
        .recalculate()
        .unwrap()
        .scenarios
        .iter()
        .all(|s| s.complete));
    let mut corrupt_warmup = export.clone();
    for event in &mut corrupt_warmup.attempts[0].events {
        if let EventKind::Frame { bytes } = &mut event.kind {
            let mut frame: Value = serde_json::from_slice(bytes).unwrap();
            if frame["kind"] == "mlx_input" {
                frame["ids"] = json!([]);
                *bytes = serde_json::to_vec(&frame).unwrap();
            }
        }
    }
    assert!(corrupt_warmup
        .recalculate()
        .unwrap()
        .scenarios
        .iter()
        .all(|s| !s.complete));
    let mut single = export.clone();
    let mut first = true;
    let mut eos = None;
    for event in &single.attempts[1].events {
        if let EventKind::Frame { bytes } = &event.kind {
            let frame: Value = serde_json::from_slice(bytes).unwrap();
            if frame["done"] == true {
                eos = Some(frame["mlx"]["eos_token_ids"][0].clone());
            }
        }
    }
    let eos = eos.unwrap();
    single.attempts[1].events.retain_mut(|event| {
        if let EventKind::Frame { bytes } = &mut event.kind {
            let mut frame: Value = serde_json::from_slice(bytes).unwrap();
            if frame["kind"] == "generation" && frame["done"] == false {
                if !first {
                    return false;
                }
                first = false;
                frame["token_id"] = eos.clone();
                frame["generation_tokens"] = json!(1);
                frame["response"] = json!("");
            } else if frame["done"] == true {
                frame["eval_count"] = json!(1);
                frame["done_reason"] = json!("stop");
                frame["mlx"]["token_ids"] = json!([eos.clone()]);
            }
            *bytes = serde_json::to_vec(&frame).unwrap();
        }
        true
    });
    let single = single.recalculate().unwrap();
    assert!(single.attempts[1].validation_errors.is_empty());
    assert_eq!(
        single.attempts[1].decode_tps.unavailable_reason.as_deref(),
        Some("no_post_first_token_decode_work")
    );
    assert!(
        single.scenarios[0].complete,
        "one-token completion remains a completed request"
    );
    assert_eq!(
        single.scenarios[0].decode_tps_median, None,
        "an unavailable repeat is not silently dropped from the fixed budget"
    );
    let stopped = registry
        .run_mlx_suite(
            &model,
            &root.join("workers/mlx"),
            &hw,
            "mlx-suite-e2e",
            RepeatsMode::Fast,
            Some("classify"),
            &cancel,
            |p| {
                if matches!(p, BenchProgress::ScenarioStarted { .. }) {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap();
    assert!(stopped.is_empty());
    let stopped = registry.bench_sessions(1).unwrap().remove(0);
    assert_eq!(stopped.outcome, Outcome::Cancelled);
    assert!(registry
        .bench_evidence(&stopped.id)
        .unwrap()
        .attempts
        .iter()
        .any(|a| a.outcome == Outcome::Cancelled));
    cancel.store(false, Ordering::Relaxed);
    assert!(registry
        .run_mlx_suite(
            &dir.join("missing"),
            &root.join("workers/mlx"),
            &hw,
            "mlx-suite-e2e",
            RepeatsMode::Fast,
            None,
            &cancel,
            |_| {}
        )
        .is_err());
    assert_eq!(
        registry.bench_sessions(1).unwrap()[0].outcome,
        Outcome::Failed
    );
    eprintln!("Retained real text suite: {}.json", session.id);
}
