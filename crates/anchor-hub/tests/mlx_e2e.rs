//! Opt-in real GPU → worker → Registry → SQLite → export/replay. No synthetic timing claims.
use anchor_hub::{
    bench::evidence::{EventKind, EvidenceExport, Outcome},
    BenchProgress, Registry,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

#[tokio::test]
#[ignore = "requires Apple GPU, uv and ANCHOR_MLX_E2E_MODEL pointing to a local MLX Llama checkpoint"]
async fn native_mlx_windows_persist_replay_and_retain_cancellation() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let model =
        PathBuf::from(std::env::var_os("ANCHOR_MLX_E2E_MODEL").expect("set ANCHOR_MLX_E2E_MODEL"));
    let output = root.join(".internal/benchmarking/mlx-validation");
    std::fs::create_dir_all(&output).unwrap();
    let registry = Registry::open(output.join("registry.db")).unwrap();
    let hw = anchor_core::HwIdentity::from_profile(&anchor_system::Profiler::profile_now());
    let cancel = AtomicBool::new(false);
    let summary = registry
        .measure_native_mlx(
            &model,
            &root.join("workers/mlx"),
            &hw,
            "mlx-live-validation",
            &cancel,
            |event| {
                if let BenchProgress::Status { message } = event {
                    eprintln!("{message}");
                }
            },
        )
        .unwrap();
    assert_eq!(summary.outcome, Outcome::Completed, "{:?}", summary.error);
    assert!(summary.report.boundaries_validated, "{:?}", summary.report);
    assert_eq!(summary.report.completed_repeats, 3);
    assert!(!summary.report.comparison_eligible);
    let export = registry.bench_evidence(&summary.session_id).unwrap();
    assert_eq!(export.attempts.len(), 7);
    assert!(export
        .attempts
        .iter()
        .all(|a| a.outcome == Outcome::Completed));
    assert!(export.session.config.attempts.iter().any(|p| p.is_warmup));
    assert!(
        export.results.is_empty()
            && export.derived.scenarios.is_empty()
            && export.derived.attempts.is_empty()
    );
    assert!(registry.bench_history(&hw, None, 100).unwrap().is_empty());
    let encoded = serde_json::to_vec_pretty(&export).unwrap();
    std::fs::write(
        output.join(format!("{}.json", summary.session_id)),
        &encoded,
    )
    .unwrap();
    let mut replay: EvidenceExport = serde_json::from_slice(&encoded).unwrap();
    replay.derived.native = None;
    assert_eq!(
        serde_json::to_value(replay.recalculate().unwrap()).unwrap(),
        serde_json::to_value(&export.derived).unwrap()
    );
    let report = export.derived.native.as_ref().unwrap();
    for (attempt, metric) in export.attempts.iter().zip(&report.attempts) {
        let frames: Vec<Value> = attempt
            .events
            .iter()
            .filter_map(|e| match &e.kind {
                EventKind::Frame { bytes } => Some(serde_json::from_slice(bytes).unwrap()),
                _ => None,
            })
            .collect();
        for phase in frames
            .iter()
            .filter(|f| f["kind"] == "phase" && f["phase"] != "load")
        {
            let count = phase["tokens"].as_u64().unwrap();
            let elapsed = phase["end_ns"].as_u64().unwrap() - phase["start_ns"].as_u64().unwrap();
            let rate = count as f64 * 1e9 / elapsed as f64;
            assert!(phase["cache_offsets"]
                .as_array()
                .unwrap()
                .iter()
                .all(|o| o.as_u64() == Some(if phase["phase"] == "prompt" { 512 } else { 576 })));
            assert_eq!(
                Some(rate),
                if phase["phase"] == "prompt" {
                    metric.prompt_tps
                } else {
                    metric.decode_steps_per_second
                }
            );
        }
    }
    let safe = serde_json::to_value(&summary).unwrap();
    assert!(
        safe.get("config").is_none()
            && !safe.to_string().contains("model_files")
            && !safe.to_string().contains("prompt_ids")
    );
    let boundary_attempt = &mut replay.attempts[0];
    for event in &mut boundary_attempt.events {
        if let EventKind::Frame { bytes } = &mut event.kind {
            let mut frame: Value = serde_json::from_slice(bytes).unwrap();
            if frame["kind"] == "boundary_validation" {
                frame["value"] = json!(0);
                *bytes = serde_json::to_vec(&frame).unwrap();
            }
        }
    }
    let invalid = replay.recalculate().unwrap().native.unwrap();
    assert!(!invalid.boundaries_validated);
    assert!(
        invalid
            .attempts
            .iter()
            .all(|a| a.prompt_tps.is_none() && a.decode_steps_per_second.is_none()),
        "bad boundaries cannot qualify rates"
    );
    let mut wrong_version = export.clone();
    wrong_version
        .session
        .config
        .native
        .as_mut()
        .unwrap()
        .protocol_version += 1;
    assert!(wrong_version.recalculate().is_err());
    let mut corrupt = export.clone();
    for event in &mut corrupt.attempts[3].events {
        if let EventKind::Frame { bytes } = &mut event.kind {
            let mut frame: Value = serde_json::from_slice(bytes).unwrap();
            if frame["kind"] == "phase" && frame["phase"] == "decode" {
                frame["tokens"] = json!(0);
                *bytes = serde_json::to_vec(&frame).unwrap();
            }
        }
    }
    assert!(
        !corrupt
            .recalculate()
            .unwrap()
            .native
            .unwrap()
            .boundaries_validated
    );
    let stopped = registry
        .measure_native_mlx(
            &model,
            &root.join("workers/mlx"),
            &hw,
            "mlx-live-validation",
            &cancel,
            |event| {
                if let BenchProgress::Status { message } = event {
                    if message == "Warming native compute" {
                        cancel.store(true, Ordering::Relaxed);
                    }
                }
            },
        )
        .unwrap();
    assert_eq!(stopped.outcome, Outcome::Cancelled);
    let stopped_export = registry.bench_evidence(&stopped.session_id).unwrap();
    let pid = stopped_export
        .session
        .config
        .native
        .as_ref()
        .unwrap()
        .identity
        .as_ref()
        .unwrap()["worker_pid"]
        .as_u64()
        .unwrap();
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success(),
        "cancel must terminate the inference process"
    );
    assert!(stopped_export
        .attempts
        .iter()
        .any(|a| a.outcome == Outcome::Cancelled));
    assert!(!stopped.report.boundaries_validated);
    assert!(stopped
        .report
        .attempts
        .iter()
        .all(|a| a.decode_steps_per_second.is_none()));
    std::fs::write(
        output.join(format!("{}.json", stopped.session_id)),
        serde_json::to_vec_pretty(&stopped_export).unwrap(),
    )
    .unwrap();
    cancel.store(false, Ordering::Relaxed);
    let failure = registry
        .measure_native_mlx(
            &output.join("missing-checkpoint"),
            &root.join("workers/mlx"),
            &hw,
            "mlx-live-validation",
            &cancel,
            |_| {},
        )
        .unwrap();
    assert_eq!(failure.outcome, Outcome::Failed);
    assert_eq!(
        registry
            .bench_evidence(&failure.session_id)
            .unwrap()
            .attempts
            .len(),
        1
    );
    assert!(!failure.report.boundaries_validated);
    eprintln!("Retained live evidence: {}.json", summary.session_id);
}
