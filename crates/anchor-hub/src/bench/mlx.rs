//! Native fixed-token work has its own trace/formulas; it never creates serving ranking rows.
use super::{
    evidence::{EventKind, EvidenceExport, Outcome, PlannedAttempt, RawEvent, SessionConfig},
    BenchProgress,
};
use crate::{GenerateRequest, Registry, Result};
use anchor_core::HwIdentity;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub const PROTOCOL: &str = "mlx_native_compute_v1";
const WORKER: &str = include_str!("../../../../workers/mlx/worker.py");
const SUITE_WORKER: &str = include_str!("../../../../workers/mlx/suite.py");
const PROJECT: &str = include_str!("../../../../workers/mlx/pyproject.toml");
const LOCK: &str = include_str!("../../../../workers/mlx/uv.lock");
const PYTHON_VERSION: &str = include_str!("../../../../workers/mlx/.python-version");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeConfig {
    pub protocol_version: u32,
    pub model_path: PathBuf,
    pub prompt_tokens: u32,
    pub decode_steps: u32,
    pub repeats: u32,
    pub identity: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeModel {
    pub name: String,
    pub path: PathBuf,
}

pub fn local_model(path: &Path) -> Result<NativeModel> {
    let path = path.canonicalize().map_err(|e| invalid(e.to_string()))?;
    let config: Value = serde_json::from_slice(
        &std::fs::read(path.join("config.json")).map_err(|e| invalid(e.to_string()))?,
    )?;
    if config["model_type"] != "llama"
        || !std::fs::read_dir(&path)
            .map_err(|e| invalid(e.to_string()))?
            .flatten()
            .any(|f| f.path().extension().is_some_and(|e| e == "safetensors"))
    {
        return Err(invalid("Choose a local MLX-compatible Llama checkpoint containing config.json and safetensors weights"));
    }
    let name = path
        .ancestors()
        .find_map(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("models--"))
                .map(|n| n.replace("--", "/"))
        })
        .unwrap_or_else(|| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    Ok(NativeModel { name, path })
}

pub fn cached_models() -> Vec<NativeModel> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let cache = std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("HF_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(home).join(".cache/huggingface"))
                .join("hub")
        });
    let mut models = Vec::new();
    for repo in std::fs::read_dir(cache).into_iter().flatten().flatten() {
        if !repo.file_name().to_string_lossy().starts_with("models--") {
            continue;
        }
        for snapshot in std::fs::read_dir(repo.path().join("snapshots"))
            .into_iter()
            .flatten()
            .flatten()
        {
            let path = snapshot.path();
            if let Ok(model) = local_model(&path) {
                models.push(model);
            }
        }
    }
    models.sort_by(|a, b| a.path.cmp(&b.path));
    models
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeCheck {
    pub name: String,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeAttemptMetrics {
    pub plan_index: usize,
    pub kind: String,
    pub is_warmup: bool,
    pub outcome: Outcome,
    pub prompt_ns: Option<u64>,
    pub decode_ns: Option<u64>,
    pub load_ns: Option<u64>,
    pub prompt_tps: Option<f64>,
    pub decode_steps_per_second: Option<f64>,
    pub baseline_active_bytes: Option<u64>,
    pub baseline_cache_bytes: Option<u64>,
    pub peak_bytes: Option<u64>,
    pub end_active_bytes: Option<u64>,
    pub end_cache_bytes: Option<u64>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeReport {
    pub protocol_version: u32,
    pub prompt_tokens: u32,
    pub decode_steps: u32,
    pub planned_repeats: u32,
    pub completed_repeats: usize,
    pub boundary_checks: Vec<NativeCheck>,
    pub boundaries_validated: bool,
    pub attempts: Vec<NativeAttemptMetrics>,
    pub comparison_eligible: bool,
    pub comparability: String,
    pub quality: String,
    pub memory_scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeSummary {
    pub session_id: String,
    pub model_name: String,
    pub created_at: i64,
    pub outcome: Outcome,
    pub error: Option<String>,
    pub runtime_version: Option<String>,
    pub report: NativeReport,
}

fn invalid(message: impl Into<String>) -> crate::Error {
    crate::Error::Native(message.into())
}
fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}

pub(super) fn boundary_checks(v: &Value) -> Vec<NativeCheck> {
    let n = |section: &str, key: &str| number(&v[section], key);
    let difference = |a: Option<u64>, b: Option<u64>, minimum| {
        a.zip(b)
            .and_then(|(a, b)| a.checked_sub(b))
            .is_some_and(|d| d >= minimum)
    };
    let equal_value = |key| {
        v[key]
            .as_f64()
            .is_some_and(|x| (x - 1.0 / 512.0).abs() <= 1e-8)
    };
    [
        (
            "Live allocation",
            difference(
                n("live", "active_bytes"),
                n("baseline", "active_bytes"),
                8 * 1024 * 1024,
            ),
        ),
        (
            "Peak reset with live allocations",
            n("reset", "active_bytes").is_some()
                && n("reset", "active_bytes") == n("live", "active_bytes")
                && n("reset", "peak_bytes")
                    .is_some_and(|p| p == 0 || Some(p) == n("reset", "active_bytes")),
        ),
        (
            "Allocation peak",
            difference(
                n("allocated", "active_bytes"),
                n("live", "active_bytes"),
                16 * 1024 * 1024,
            ) && n("allocated", "peak_bytes")
                .zip(n("allocated", "active_bytes"))
                .is_some_and(|(p, a)| p >= a),
        ),
        (
            "Release and allocator cache",
            n("freed", "active_bytes")
                .zip(n("allocated", "active_bytes"))
                .is_some_and(|(f, a)| f < a)
                && n("freed", "peak_bytes").is_some()
                && n("freed", "peak_bytes") == n("allocated", "peak_bytes")
                && n("cleared", "cache_bytes")
                    .zip(n("freed", "cache_bytes"))
                    .is_some_and(|(c, f)| c <= f),
        ),
        (
            "Lazy work evaluated before timing ends",
            equal_value("value")
                && number(v, "graph_build_ns")
                    .zip(number(v, "evaluation_and_sync_ns"))
                    .is_some_and(|(a, b)| {
                        a > 0 && b > 0 && a.checked_add(b) == number(v, "completed_work_ns")
                    }),
        ),
        (
            "Explicit auxiliary stream",
            equal_value("auxiliary_value")
                && v["stream"].is_string()
                && v["auxiliary_stream"].is_string()
                && v["stream"] != v["auxiliary_stream"],
        ),
    ]
    .into_iter()
    .map(|(name, passed)| NativeCheck {
        name: name.into(),
        passed,
    })
    .collect()
}

pub fn recalculate(export: &EvidenceExport) -> Result<NativeReport> {
    let config = export
        .session
        .config
        .native
        .as_ref()
        .ok_or_else(|| invalid("missing native MLX configuration"))?;
    if export.session.config.protocol != PROTOCOL
        || config.protocol_version != 1
        || config.prompt_tokens == 0
        || config.prompt_tokens > 2048
        || config.decode_steps == 0
        || config.decode_steps > 256
        || config.repeats == 0
        || config.repeats > 10
    {
        return Err(invalid("unsupported native MLX protocol or workload"));
    }
    let mut expected = vec!["boundary_validation", "load", "warmup"];
    expected.extend(std::iter::repeat_n(
        "native_repeat",
        config.repeats as usize,
    ));
    expected.push("identity_check");
    if export.session.config.attempts.len() != expected.len()
        || export
            .session
            .config
            .attempts
            .iter()
            .zip(expected)
            .any(|(p, k)| p.scenario_id != k || p.is_warmup != (k == "warmup"))
    {
        return Err(invalid("invalid native MLX frozen plan"));
    }
    let mut checks = Vec::new();
    let mut attempts = Vec::new();
    let mut token_plan_valid = false;
    let mut identity_valid = false;
    for attempt in &export.attempts {
        let plan = &export.session.config.attempts[attempt.plan_index];
        let mut metric = NativeAttemptMetrics {
            plan_index: attempt.plan_index,
            kind: plan.scenario_id.clone(),
            is_warmup: plan.is_warmup,
            outcome: attempt.outcome,
            prompt_ns: None,
            decode_ns: None,
            load_ns: None,
            prompt_tps: None,
            decode_steps_per_second: None,
            baseline_active_bytes: None,
            baseline_cache_bytes: None,
            peak_bytes: None,
            end_active_bytes: None,
            end_cache_bytes: None,
            errors: Vec::new(),
        };
        let mut previous = 0;
        let mut worker_previous = 0;
        let mut reset = None;
        let mut phase_end = 0;
        let mut phases = Vec::new();
        let mut finished = false;
        let mut started = false;
        let mut window_closed = false;
        let mut session_marker = false;
        let mut ended = false;
        let mut closed = false;
        if !matches!(
            attempt.events.first().map(|e| &e.kind),
            Some(EventKind::Dispatch)
        ) || attempt.events.first().is_some_and(|e| e.at_ns != 0)
        {
            metric.errors.push("missing_dispatch".into());
        }
        for (index, event) in attempt.events.iter().enumerate() {
            if event.at_ns < previous || ended {
                metric.errors.push("invalid_native_event_order".into());
            }
            previous = event.at_ns;
            match &event.kind {
                EventKind::Dispatch if index > 0 => metric.errors.push("duplicate_dispatch".into()),
                EventKind::Outcome => ended = true,
                EventKind::TransportClosed => closed = true,
                EventKind::Frame { bytes } => {
                    let v: Value = match serde_json::from_slice(bytes) {
                        Ok(v) => v,
                        Err(_) => {
                            metric.errors.push("malformed_worker_frame".into());
                            continue;
                        }
                    };
                    let now = number(&v, "worker_ns");
                    if closed || now.is_none_or(|n| n < worker_previous) {
                        metric.errors.push("invalid_worker_clock".into());
                    }
                    worker_previous = now.unwrap_or(worker_previous);
                    match v["kind"].as_str().unwrap_or("") {
                        "attempt_started" => {
                            if started
                                || number(&v, "plan_index") != Some(attempt.plan_index as u64)
                            {
                                metric.errors.push("worker_plan_mismatch".into());
                            }
                            started = true;
                        }
                        "boundary_validation" => {
                            if plan.scenario_id != "boundary_validation" || !checks.is_empty() {
                                metric
                                    .errors
                                    .push("misplaced_or_duplicate_boundary_validation".into());
                            }
                            checks = boundary_checks(&v);
                        }
                        "token_plan" => {
                            let vocab = config
                                .identity
                                .as_ref()
                                .and_then(|id| number(id, "vocab_size"));
                            if plan.scenario_id != "load" || token_plan_valid {
                                metric
                                    .errors
                                    .push("misplaced_or_duplicate_token_plan".into());
                            }
                            token_plan_valid = v["prompt_ids"].as_array().is_some_and(|a| {
                                a.len() == config.prompt_tokens as usize
                                    && a.iter().all(|v| {
                                        v.as_u64().zip(vocab).is_some_and(|(id, v)| id < v)
                                    })
                            }) && v["decode_ids"].as_array().is_some_and(|a| {
                                a.len() == config.decode_steps as usize
                                    && a.iter().all(|v| {
                                        v.as_u64().zip(vocab).is_some_and(|(id, v)| id < v)
                                    })
                            }) && v["prior_context_tokens"] == 0;
                        }
                        "window_reset" => {
                            if reset.is_some() {
                                metric.errors.push("overlapping_peak_reset".into());
                            }
                            reset = now;
                            metric.baseline_active_bytes = number(&v["baseline"], "active_bytes");
                            metric.baseline_cache_bytes = number(&v["baseline"], "cache_bytes");
                            if metric.baseline_active_bytes.is_none()
                                || number(&v["after_reset"], "active_bytes")
                                    != metric.baseline_active_bytes
                                || number(&v["after_reset"], "peak_bytes").is_none_or(|p| {
                                    p != 0 && Some(p) != metric.baseline_active_bytes
                                })
                                || config
                                    .identity
                                    .as_ref()
                                    .is_none_or(|id| id["stream"] != v["stream"])
                            {
                                metric.errors.push("invalid_peak_reset_or_stream".into());
                            }
                        }
                        "phase" => {
                            let phase = v["phase"].as_str().unwrap_or("");
                            let duration = number(&v, "start_ns")
                                .zip(number(&v, "end_ns"))
                                .and_then(|(s, e)| {
                                    (Some(s) >= reset && s >= phase_end && Some(e) <= now)
                                        .then(|| e.checked_sub(s))
                                        .flatten()
                                })
                                .filter(|n| *n > 0);
                            if reset.is_none()
                                || duration.is_none()
                                || window_closed
                                || phases.contains(&phase.to_string())
                            {
                                metric.errors.push("invalid_phase_window".into());
                            }
                            phases.push(phase.to_string());
                            phase_end = number(&v, "end_ns").unwrap_or(0);
                            let (tokens, offset) = match phase {
                                "prompt" => (config.prompt_tokens, config.prompt_tokens),
                                "decode" => (
                                    config.decode_steps,
                                    config.prompt_tokens + config.decode_steps,
                                ),
                                "load" => (0, 0),
                                _ => {
                                    metric.errors.push("unknown_phase".into());
                                    (0, 0)
                                }
                            };
                            if number(&v, "tokens") != Some(tokens as u64)
                                || (phase != "load"
                                    && !v["cache_offsets"].as_array().is_some_and(|a| {
                                        !a.is_empty()
                                            && a.iter().all(|x| x.as_u64() == Some(offset as u64))
                                    }))
                            {
                                metric.errors.push("native_token_count_mismatch".into());
                            }
                            match phase {
                                "prompt" => metric.prompt_ns = duration,
                                "decode" => metric.decode_ns = duration,
                                "load" => metric.load_ns = duration,
                                _ => {}
                            }
                        }
                        "window_end" => {
                            if window_closed {
                                metric.errors.push("duplicate_memory_window_end".into());
                            }
                            window_closed = true;
                            metric.peak_bytes = number(&v["memory"], "peak_bytes");
                            metric.end_active_bytes = number(&v["memory"], "active_bytes");
                            metric.end_cache_bytes = number(&v["memory"], "cache_bytes");
                            if reset.is_none()
                                || number(&v, "sampled_ns")
                                    .zip(now)
                                    .is_none_or(|(s, n)| s < phase_end || s > n)
                                || metric
                                    .peak_bytes
                                    .zip(metric.baseline_active_bytes)
                                    .is_none_or(|(p, b)| p < b)
                                || metric
                                    .peak_bytes
                                    .zip(metric.end_active_bytes)
                                    .is_none_or(|(p, a)| p < a)
                                || metric.end_cache_bytes.is_none()
                                || v["finite_output"] != true
                            {
                                metric.errors.push("invalid_allocator_window".into());
                            }
                        }
                        "identity_check" => {
                            if plan.scenario_id != "identity_check" || identity_valid {
                                metric
                                    .errors
                                    .push("misplaced_or_duplicate_identity_check".into());
                            }
                            identity_valid = v["unchanged"] == true;
                        }
                        "attempt_finished" => {
                            if finished
                                || number(&v, "plan_index") != Some(attempt.plan_index as u64)
                                || v["outcome"] != "completed"
                            {
                                metric.errors.push("invalid_worker_completion".into());
                            }
                            finished = true;
                        }
                        "session_finished" => {
                            if session_marker
                                || plan.scenario_id != "identity_check"
                                || !finished
                                || v["outcome"] != "completed"
                            {
                                metric.errors.push("worker_session_failed".into());
                            }
                            session_marker = true;
                        }
                        _ => metric.errors.push("unknown_worker_frame".into()),
                    }
                }
                _ => {}
            }
        }
        if !ended || !started || !finished || attempt.outcome != Outcome::Completed {
            metric.errors.push("attempt_not_valid_completed".into());
        }
        if plan.scenario_id == "load" && (phases != ["load"] || metric.peak_bytes.is_none()) {
            metric.errors.push("missing_load_window".into());
        }
        if matches!(plan.scenario_id.as_str(), "warmup" | "native_repeat") {
            if phases != ["prompt", "decode"] || metric.peak_bytes.is_none() || !token_plan_valid {
                metric
                    .errors
                    .push("missing_native_work_or_token_plan".into());
            }
            if metric.errors.is_empty() {
                metric.prompt_tps = metric
                    .prompt_ns
                    .map(|n| config.prompt_tokens as f64 * 1e9 / n as f64);
                metric.decode_steps_per_second = metric
                    .decode_ns
                    .map(|n| config.decode_steps as f64 * 1e9 / n as f64);
            }
        }
        if plan.scenario_id == "identity_check" && (!closed || !identity_valid || !session_marker) {
            metric
                .errors
                .push("missing_final_identity_or_transport_close".into());
        }
        attempts.push(metric);
    }
    let complete = export.session.outcome == Outcome::Completed
        && export.attempts.len() == export.session.config.attempts.len()
        && attempts.iter().all(|a| a.errors.is_empty());
    let validated = complete
        && checks.len() == 6
        && checks.iter().all(|c| c.passed)
        && identity_valid
        && config.identity.is_some();
    if !validated {
        for attempt in &mut attempts {
            attempt.prompt_tps = None;
            attempt.decode_steps_per_second = None;
        }
    }
    Ok(NativeReport {protocol_version:1,prompt_tokens:config.prompt_tokens,decode_steps:config.decode_steps,planned_repeats:config.repeats,
        completed_repeats:attempts.iter().filter(|a|a.kind=="native_repeat" && a.errors.is_empty()).count(), boundary_checks:checks, boundaries_validated:validated, attempts,
        comparison_eligible:false,comparability:"unqualified: native synthetic work; serving, model equivalence and instrumentation overhead are separate gates".into(),quality:"not_applicable_to_synthetic_compute".into(),
        memory_scope:"MLX allocator peak in one exclusive worker/window; includes live resident allocations; not process RSS or total Mac memory".into()})
}

pub(super) struct Worker {
    pub(super) child: Child,
    rx: mpsc::Receiver<std::result::Result<Vec<u8>, String>>,
    stderr: Option<std::thread::JoinHandle<String>>,
}
impl Worker {
    pub(super) fn spawn(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root).map_err(|e| invalid(e.to_string()))?;
        for (name, contents) in [
            ("worker.py", WORKER),
            ("suite.py", SUITE_WORKER),
            ("pyproject.toml", PROJECT),
            ("uv.lock", LOCK),
            (".python-version", PYTHON_VERSION),
        ] {
            if std::fs::read_to_string(root.join(name)).ok().as_deref() != Some(contents) {
                std::fs::write(root.join(name), contents).map_err(|e| invalid(e.to_string()))?;
            }
        }
        let uv = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|p| p.join(".local/bin/uv"))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| "uv".into());
        let mut command = Command::new(uv);
        command
            .args(["run", "--frozen", "--no-config", "--project"])
            .arg(root)
            .args(["--python", PYTHON_VERSION.trim()])
            .args(["python", "-u"])
            .arg(root.join("worker.py"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("UV_PROJECT_ENVIRONMENT", root.join(".venv"))
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONHOME")
            .env_remove("VIRTUAL_ENV")
            .env_remove("CONDA_PREFIX")
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("UV_NO_PROGRESS", "1");
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| {
            invalid(format!(
                "Could not start uv for MLX. Install uv and try again. {e}"
            ))
        })?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match (&mut reader)
                    .take(1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(_) if line.len() <= 1024 * 1024 => {
                        if tx.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    _ => {
                        let _ = tx.send(Err("invalid or oversized MLX worker frame".into()));
                        break;
                    }
                }
            }
        });
        let stderr = std::thread::spawn(move || {
            let mut reader = stderr;
            let mut saved = Vec::new();
            let mut b = [0; 4096];
            while let Ok(n) = reader.read(&mut b) {
                if n == 0 {
                    break;
                }
                let take = n.min(65536 - saved.len());
                saved.extend_from_slice(&b[..take]);
            }
            String::from_utf8_lossy(&saved).into_owned()
        });
        Ok(Self {
            child,
            rx,
            stderr: Some(stderr),
        })
    }
    pub(super) fn send(&mut self, value: &Value) -> Result<()> {
        let input = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| invalid("MLX worker stdin closed"))?;
        writeln!(input, "{value}").map_err(|e| invalid(e.to_string()))?;
        input.flush().map_err(|e| invalid(e.to_string()))?;
        Ok(())
    }
    pub(super) fn next(
        &mut self,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>> {
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(crate::Error::Cancelled);
            }
            if Instant::now() > deadline {
                return Err(invalid("MLX worker timed out"));
            }
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(line)) => return Ok(Some(line)),
                Ok(Err(e)) => return Err(invalid(e)),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    fn stop(&mut self) {
        #[cfg(unix)]
        {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{}", self.child.id())])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
    pub(super) fn diagnostics(&mut self) -> String {
        self.stop();
        self.stderr
            .take()
            .and_then(|t| t.join().ok())
            .unwrap_or_default()
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Registry {
    pub fn native_mlx_summary(&self, id: &str) -> Result<NativeSummary> {
        let export = self.bench_evidence(id)?;
        Ok(NativeSummary {
            session_id: export.session.id,
            model_name: export.session.config.model_name,
            created_at: export.session.created_at,
            outcome: export.session.outcome,
            error: export.session.error,
            runtime_version: export.session.config.runtime_version,
            report: export
                .derived
                .native
                .ok_or_else(|| invalid("session is not native MLX"))?,
        })
    }

    pub fn measure_native_mlx<F>(
        &self,
        model: &Path,
        root: &Path,
        hw: &HwIdentity,
        install_id: &str,
        cancel: &AtomicBool,
        mut progress: F,
    ) -> Result<NativeSummary>
    where
        F: FnMut(BenchProgress),
    {
        let model = model.canonicalize().unwrap_or_else(|_| model.to_path_buf());
        let mut native = NativeConfig {
            protocol_version: 1,
            model_path: model.clone(),
            prompt_tokens: 512,
            decode_steps: 64,
            repeats: 3,
            identity: None,
        };
        let mut steps = vec!["boundary_validation", "load", "warmup"];
        steps.extend(std::iter::repeat_n(
            "native_repeat",
            native.repeats as usize,
        ));
        steps.push("identity_check");
        let plans=steps.iter().enumerate().map(|(i,step)|PlannedAttempt {scenario_id:(*step).into(),repeat_index:i.saturating_sub(2) as u32,is_warmup:*step=="warmup",prompt_tokens_target:Some(native.prompt_tokens),
            request:GenerateRequest::for_benchmark(model.to_string_lossy().as_ref(),"native synthetic token inputs: lighthouse sentence, cycle token IDs; no chat template or sampling",native.decode_steps as u64,native.prompt_tokens+native.decode_steps)}).collect::<Vec<_>>();
        progress(BenchProgress::Status {
            message: "Preparing MLX worker with uv…".into(),
        });
        let mut worker = Worker::spawn(root);
        let mut setup_frame = None;
        let handshake: Result<()> = (|| {
            let w = worker.as_mut().map_err(|e| invalid(e.to_string()))?;
            w.send(&serde_json::to_value(&native)?)?;
            let line = w
                .next(cancel, Instant::now() + Duration::from_secs(300))?
                .ok_or_else(|| invalid("MLX worker closed before its manifest"))?;
            setup_frame = Some(line.clone());
            let manifest: Value = serde_json::from_slice(&line)?;
            if manifest["kind"] != "manifest"
                || manifest["protocol_version"] != 1
                || !manifest["identity"]["model_digest"].is_string()
            {
                return Err(invalid(
                    manifest["error"]
                        .as_str()
                        .unwrap_or("invalid MLX worker manifest"),
                ));
            }
            native.identity = Some(manifest["identity"].clone());
            setup_frame = None;
            Ok(())
        })();
        let identity = native.identity.as_ref();
        let model_name = cached_models()
            .into_iter()
            .find(|m| m.path == model)
            .map(|m| m.name)
            .unwrap_or_else(|| {
                model
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into()
            });
        let session=self.begin_bench_session(SessionConfig{protocol:PROTOCOL.into(),suite_id:"mlx-native".into(),suite_version:1,prompt_version:1,hw:hw.clone(),install_id:install_id.into(),
            model_name,model_digest:identity.and_then(|v|v["model_digest"].as_str()).unwrap_or("unverified").into(),quant:identity.and_then(|v|v.get("quantization")).map(Value::to_string),
            runtime_version:identity.map(|v|format!("MLX {} / MLX-LM {}",v["versions"]["mlx"].as_str().unwrap_or("unknown"),v["versions"]["mlx-lm"].as_str().unwrap_or("unknown"))),server_is_local:true,concurrency:1,
            connection_policy:"exclusive native uv worker; no HTTP".into(),cache_policy:"fresh standard KVCache per attempt, depth 0; warmup retained; allocator cache cleared outside windows".into(),
            counter_calibration:"native boundary probes in this session; no serving/quality/overhead qualification".into(),attempts:plans,calibration:None,native:Some(native),mlx:None})?;
        let mut attempt = self.begin_bench_attempt(&session, 0)?;
        attempt.env_start = Some(anchor_system::telemetry::snapshot());
        attempt.events.push(RawEvent {
            at_ns: 0,
            kind: EventKind::Dispatch,
        });
        if let Some(bytes) = setup_frame {
            attempt.events.push(RawEvent {
                at_ns: 0,
                kind: EventKind::Frame { bytes },
            });
        }
        let mut began = Instant::now();
        let mut final_marker = false;
        let collection: Result<()> = (|| {
            handshake?;
            let w = worker.as_mut().map_err(|e| invalid(e.to_string()))?;
            w.send(&json!({"run":true}))?;
            while let Some(line) = w.next(cancel, began + Duration::from_secs(180))? {
                let value: Value = serde_json::from_slice(&line)?;
                attempt.events.push(RawEvent {
                    at_ns: began.elapsed().as_nanos() as u64,
                    kind: EventKind::Frame { bytes: line },
                });
                match value["kind"].as_str().unwrap_or("") {
                    "attempt_started" => {
                        if value["plan_index"].as_u64() != Some(attempt.plan_index as u64) {
                            return Err(invalid("MLX worker plan order changed"));
                        }
                        let message = match steps[attempt.plan_index] {
                            "boundary_validation" => "Validating timing and memory windows".into(),
                            "load" => "Loading MLX checkpoint".into(),
                            "warmup" => "Warming native compute".into(),
                            "identity_check" => "Verifying checkpoint identity".into(),
                            _ => format!("Measuring repeat {} of 3", attempt.plan_index - 2),
                        };
                        progress(BenchProgress::Status { message });
                    }
                    "attempt_finished" => {
                        if value["plan_index"].as_u64() != Some(attempt.plan_index as u64)
                            || attempt.outcome != Outcome::Running
                        {
                            return Err(invalid("duplicate or mismatched MLX completion"));
                        }
                        if value["outcome"] != "completed" {
                            return Err(invalid(
                                value["error"].as_str().unwrap_or("MLX attempt failed"),
                            ));
                        }
                        if attempt.plan_index + 1 < steps.len() {
                            attempt.outcome = Outcome::Completed;
                            attempt.env_end = Some(anchor_system::telemetry::snapshot());
                            attempt.events.push(RawEvent {
                                at_ns: began.elapsed().as_nanos() as u64,
                                kind: EventKind::Outcome,
                            });
                            self.finish_bench_attempt(&attempt)?;
                            attempt = self.begin_bench_attempt(&session, attempt.plan_index + 1)?;
                            attempt.env_start = Some(anchor_system::telemetry::snapshot());
                            attempt.events.push(RawEvent {
                                at_ns: 0,
                                kind: EventKind::Dispatch,
                            });
                            began = Instant::now();
                            w.send(&json!({"next":attempt.plan_index}))?;
                        } else {
                            attempt.outcome = Outcome::Completed;
                        }
                    }
                    "session_finished" => {
                        if value["outcome"] != "completed"
                            || attempt.plan_index + 1 != steps.len()
                            || attempt.outcome != Outcome::Completed
                        {
                            return Err(invalid("MLX session ended before its planned work"));
                        }
                        final_marker = true;
                    }
                    "error" => {
                        return Err(invalid(
                            value["error"].as_str().unwrap_or("MLX worker failed"),
                        ))
                    }
                    _ => {}
                }
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(status) = w.child.try_wait().map_err(|e| invalid(e.to_string()))? {
                    if !status.success() {
                        return Err(invalid("MLX worker exited unsuccessfully"));
                    }
                    break;
                }
                if Instant::now() > deadline {
                    return Err(invalid("MLX worker did not exit after closing stdout"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            if !final_marker {
                return Err(invalid("missing MLX session completion"));
            }
            attempt.events.push(RawEvent {
                at_ns: began.elapsed().as_nanos() as u64,
                kind: EventKind::TransportClosed,
            });
            Ok(())
        })();
        let mut outcome = match &collection {
            Ok(()) => Outcome::Completed,
            Err(crate::Error::Cancelled) => Outcome::Cancelled,
            Err(e) if e.to_string().contains("timed out") => Outcome::TimedOut,
            Err(_) => Outcome::Failed,
        };
        let mut error = collection.err().map(|e| {
            let detail = worker
                .as_mut()
                .ok()
                .map(Worker::diagnostics)
                .unwrap_or_default();
            format!(
                "{e}{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("\n{detail}")
                }
            )
        });
        attempt.outcome = outcome;
        attempt.error = error.clone();
        attempt.env_end = Some(anchor_system::telemetry::snapshot());
        attempt.events.push(RawEvent {
            at_ns: began.elapsed().as_nanos() as u64,
            kind: EventKind::Outcome,
        });
        self.finish_bench_attempt(&attempt)?;
        if outcome == Outcome::Completed {
            let verified = self
                .bench_evidence(&session.id)
                .and_then(|e| {
                    e.derived
                        .native
                        .ok_or_else(|| invalid("missing native report"))
                })
                .is_ok_and(|r| {
                    r.boundary_checks.len() == 6
                        && r.boundary_checks.iter().all(|c| c.passed)
                        && r.attempts.iter().all(|a| a.errors.is_empty())
                });
            if !verified {
                outcome = Outcome::Invalid;
                error=Some("Native timing or memory evidence failed validation; inspect measurement details".into());
            }
        }
        self.finish_bench_session(&session.id, outcome, error.as_deref())?;
        let summary = self.native_mlx_summary(&session.id)?;
        if outcome == Outcome::Completed && !summary.report.boundaries_validated {
            // Completed transport is retained; the report's validity gate controls metric use.
            progress(BenchProgress::Status {
                message: "Native work recorded; boundary validation did not pass".into(),
            });
        }
        Ok(summary)
    }
}
