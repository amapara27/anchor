//! Real text workloads share the catalog and result UI, with a distinct worker protocol and runtime stratum.
use super::{
    evidence::{
        Attempt, AttemptMetrics, BenchSession, EventKind, EvidenceExport, Metric, Outcome,
        PlannedAttempt, RawEvent, SessionConfig,
    },
    mlx::{NativeCheck, Worker},
    prompts, BenchProgress, RepeatsMode, SUITE_VERSION,
};
use crate::{GenerateRequest, Registry, Result};
use anchor_core::{BenchRun, BenchSource, HwIdentity, MatchQuality};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

pub const PROTOCOL: &str = "mlx_worker_text_v1";
pub const SUITE_ID: &str = "anchor-mlx-scenarios";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MlxConfig {
    pub protocol_version: u32,
    pub model_path: PathBuf,
    pub identity: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryWindow {
    pub plan_index: usize,
    pub baseline_active_bytes: Option<u64>,
    pub baseline_cache_bytes: Option<u64>,
    pub peak_bytes: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MlxReport {
    pub protocol_version: u32,
    pub boundary_checks: Vec<NativeCheck>,
    pub boundaries_validated: bool,
    pub identity_unchanged: Option<bool>,
    pub load_peak_bytes: Option<u64>,
    pub memory: Vec<MemoryWindow>,
    pub rate_status: String,
    pub comparison_eligible: bool,
    pub quality: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MlxSummary {
    pub session_id: String,
    pub model_name: String,
    pub runtime_version: Option<String>,
    pub outcome: Outcome,
    pub error: Option<String>,
    pub report: MlxReport,
}
fn error(s: impl Into<String>) -> crate::Error {
    crate::Error::Native(s.into())
}
fn frames(a: &Attempt) -> impl Iterator<Item = Value> + '_ {
    a.events.iter().filter_map(|e| match &e.kind {
        EventKind::Frame { bytes } => serde_json::from_slice(bytes).ok(),
        _ => None,
    })
}
fn count(v: &Value, key: &str) -> Option<u64> {
    v.get(key)?.as_u64()
}

pub fn metrics(a: &Attempt, session: &BenchSession) -> Result<AttemptMetrics> {
    let plan = &session.config.attempts[a.plan_index];
    let mut canonical = a.clone();
    canonical.events.retain(|e| match &e.kind {
        EventKind::Frame { bytes } => serde_json::from_slice::<Value>(bytes)
            .map(|v| v["kind"] == "generation")
            .unwrap_or(true),
        _ => true,
    });
    let mut m = super::evidence::recalculate(&canonical, session.formula_version)?;
    if a.events
        .windows(2)
        .any(|events| events[0].at_ns > events[1].at_ns)
    {
        m.validation_errors.push("nonmonotonic_mlx_events".into());
    }
    m.first_answer_ms = Metric::unknown("mlx_answer_and_reasoning_channels_not_separated");
    let mut input = None;
    let mut window = None;
    let mut terminal = None;
    let mut started = false;
    let mut closed = false;
    let mut clock = 0;
    let mut tokens = Vec::new();
    for v in frames(a) {
        if count(&v, "worker_ns").is_none_or(|n| n < clock) {
            m.validation_errors.push("invalid_worker_clock".into());
        }
        clock = count(&v, "worker_ns").unwrap_or(clock);
        match v["kind"].as_str().unwrap_or("") {
            "attempt_started" => {
                if started || v["plan_index"] != a.plan_index {
                    m.validation_errors.push("worker_plan_mismatch".into());
                }
                started = true;
            }
            "boundary_validation" | "mlx_load" => {
                if !plan.is_warmup || a.plan_index != 0 || input.is_some() {
                    m.validation_errors.push("misplaced_setup_frame".into());
                }
            }
            "mlx_input" => {
                if input.is_some() || window.is_some() {
                    m.validation_errors.push("duplicate_or_late_input".into());
                }
                input = Some(v);
            }
            "mlx_window_start" => {
                if window.is_some() || input.is_none() {
                    m.validation_errors.push("invalid_window_start".into());
                }
                window = Some(v);
            }
            "generation" => {
                if !started || window.is_none() || terminal.is_some() {
                    m.validation_errors.push("invalid_generation_order".into());
                }
                if v["done"] == true {
                    terminal = Some(v);
                } else {
                    if count(&v, "generation_tokens") != Some(tokens.len() as u64 + 1)
                        || count(&v, "token_id").is_none()
                    {
                        m.validation_errors.push("nonconserving_token_trace".into());
                    }
                    tokens.push(v["token_id"].clone());
                }
            }
            "attempt_finished" => {
                if closed
                    || v["plan_index"] != a.plan_index
                    || v["outcome"] != "completed"
                    || terminal.is_none()
                {
                    m.validation_errors.push("invalid_request_close".into());
                }
                closed = true;
            }
            "session_finished" => {
                if !closed || v["outcome"] != "completed" || v["identity_unchanged"] != true {
                    m.validation_errors.push("worker_session_failed".into());
                }
            }
            _ => m.validation_errors.push("unknown_mlx_frame".into()),
        }
    }
    let identity = session
        .config
        .mlx
        .as_ref()
        .and_then(|c| c.identity.as_ref());
    let vocab = identity.and_then(|id| count(id, "vocab_size"));
    if let Some(v) = input {
        let ids = v["ids"].as_array();
        if v["request"] != serde_json::to_value(&plan.request)?
            || v["model_digest"] != session.config.model_digest
            || v["context"].as_u64() != plan.request.num_ctx.map(u64::from)
            || !ids.is_some_and(|ids| {
                !ids.is_empty()
                    && ids
                        .iter()
                        .all(|n| n.as_u64().zip(vocab).is_some_and(|(n, v)| n < v))
            })
            || ids
                .and_then(|ids| {
                    plan.request
                        .num_predict
                        .and_then(|cap| (ids.len() as u64).checked_add(cap))
                })
                .zip(plan.request.num_ctx)
                .is_none_or(|(n, c)| n > c as u64)
            || !v["cache_offsets"]
                .as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(|v| v == 0))
            || ids.map(|ids| ids.len() as u64) != m.counters.prompt_eval_count
            || m.counters.prompt_eval_cached_count != Some(0)
            || plan
                .request
                .num_ctx
                .zip(identity.and_then(|id| count(id, "context_capacity")))
                .is_none_or(|(requested, capacity)| requested as u64 > capacity)
        {
            m.validation_errors
                .push("invalid_formatted_input_or_context".into());
        }
    } else {
        m.validation_errors.push("missing_input_evidence".into());
    }
    if let (Some(w), Some(t)) = (window, terminal) {
        let native = &t["mlx"];
        let baseline = count(&w["baseline"], "active_bytes");
        let peak = count(&native["memory"], "peak_bytes");
        if w["streams"]
            .as_array()
            .is_none_or(|a| a.is_empty() || a.iter().any(|s| !s.is_string()))
            || baseline.is_none()
            || count(&w["after_reset"], "active_bytes") != baseline
            || count(&w["after_reset"], "peak_bytes").is_none_or(|p| p != 0 && Some(p) != baseline)
            || peak.zip(baseline).is_none_or(|(p, b)| p < b)
            || peak
                .zip(count(&native["memory"], "active_bytes"))
                .is_none_or(|(p, b)| p < b)
            || count(&w["baseline"], "cache_bytes").is_none()
            || count(&native["memory"], "cache_bytes").is_none()
        {
            m.validation_errors.push("invalid_allocator_window".into());
        }
        let n = m.counters.eval_count;
        if native["protocol_version"] != 1
            || !native["token_ids"].as_array().is_some_and(|ids| {
                *ids == tokens
                    && ids
                        .iter()
                        .all(|n| n.as_u64().zip(vocab).is_some_and(|(n, v)| n < v))
            })
            || n != Some(tokens.len() as u64)
            || n.is_none_or(|n| n == 0 || plan.request.num_predict.is_none_or(|cap| n > cap))
            || (m.finish_reason.as_deref() == Some("length") && n != plan.request.num_predict)
            || (m.finish_reason.as_deref() == Some("stop")
                && !native["eos_token_ids"]
                    .as_array()
                    .is_some_and(|e| tokens.last().is_some_and(|last| e.contains(last))))
            || !matches!(m.finish_reason.as_deref(), Some("length" | "stop"))
        {
            m.validation_errors
                .push("invalid_output_count_or_finish".into());
        }
        let diagnostic = |key: &str| {
            native[key]
                .as_f64()
                .filter(|v| v.is_finite() && *v > 0.0)
                .map(Metric::known)
                .unwrap_or_else(|| Metric::unknown("missing_or_invalid_mlx_rate"))
        };
        if m.validation_errors.is_empty() && a.outcome == Outcome::Completed {
            m.decode_tps = diagnostic("generation_tps");
            m.prefill_tps = diagnostic("prompt_tps");
            if session.formula_version >= 2 {
                let first = frames(a).find(|v| v["kind"] == "generation" && v["done"] == false);
                m.decode_tps = match (
                    n,
                    first.as_ref().and_then(|v| count(v, "worker_ns")),
                    count(&t, "worker_ns"),
                ) {
                    (Some(0 | 1), _, _) => Metric::unknown("no_post_first_token_decode_work"),
                    (Some(n), Some(start), Some(end)) if end > start => {
                        Metric::known((n - 1) as f64 * 1e9 / (end - start) as f64)
                    }
                    _ => Metric::unknown("missing_post_first_token_clock"),
                };
            }
        }
    } else {
        m.validation_errors
            .push("missing_mlx_terminal_or_window".into());
    }
    if !closed || !started || !m.validation_errors.is_empty() || a.outcome != Outcome::Completed {
        m.decode_tps = Metric::unknown("mlx_attempt_not_valid_completed");
        m.prefill_tps = Metric::unknown("mlx_attempt_not_valid_completed");
    }
    Ok(m)
}

pub fn report(export: &EvidenceExport, metrics: &mut [AttemptMetrics]) -> MlxReport {
    let mut checks = Vec::new();
    let mut load = None;
    let mut unchanged = None;
    let mut memory = Vec::new();
    for a in &export.attempts {
        let mut baseline = None;
        for v in frames(a) {
            match v["kind"].as_str().unwrap_or("") {
                "boundary_validation" => checks = super::mlx::boundary_checks(&v),
                "mlx_load" => load = count(&v["memory"], "peak_bytes"),
                "mlx_window_start" => baseline = Some(v["baseline"].clone()),
                "generation" if v["done"] == true => memory.push(MemoryWindow {
                    plan_index: a.plan_index,
                    baseline_active_bytes: baseline.as_ref().and_then(|v| count(v, "active_bytes")),
                    baseline_cache_bytes: baseline.as_ref().and_then(|v| count(v, "cache_bytes")),
                    peak_bytes: count(&v["mlx"]["memory"], "peak_bytes"),
                }),
                "session_finished" => unchanged = v["identity_unchanged"].as_bool(),
                _ => {}
            }
        }
    }
    let warmups_valid = export.attempts.iter().zip(metrics.iter()).all(|(a, m)| {
        !export.session.config.attempts[a.plan_index].is_warmup
            || a.outcome != Outcome::Completed
            || m.validation_errors.is_empty()
    });
    let valid = checks.len() == 6
        && checks.iter().all(|c| c.passed)
        && unchanged != Some(false)
        && warmups_valid;
    if !valid {
        for m in metrics {
            m.validation_errors
                .push("mlx_session_checks_unverified".into());
            m.decode_tps = Metric::unknown("mlx_session_checks_unverified");
            m.prefill_tps = Metric::unknown("mlx_session_checks_unverified");
        }
    }
    MlxReport {
        protocol_version: 1,
        boundary_checks: checks,
        boundaries_validated: valid,
        identity_unchanged: unchanged,
        load_peak_bytes: load,
        memory,
        rate_status: if export.session.formula_version >= 2 {
            "Post-first sampled-token rate over the worker clock through terminal stream drain; includes consumer/IPC work; raw MLX-LM rates remain in evidence"
        } else {
            "diagnostic: upstream MLX-LM rates retain first-token/EOS and consumer-time conventions"
        }.into(),
        comparison_eligible: false,
        quality: "unchecked".into(),
    }
}

pub fn runs(export: &EvidenceExport) -> Vec<BenchRun> {
    if export.session.outcome == Outcome::Invalid {
        return Vec::new();
    }
    let s = &export.session;
    let c = &s.config;
    export.derived.scenarios.iter().filter(|m|m.complete).map(|m|{
        let attempts:Vec<_>=export.attempts.iter().filter(|a|{let p=&c.attempts[a.plan_index];!p.is_warmup && p.scenario_id==m.scenario_id}).collect();
        BenchRun{id:format!("{}:{}",s.id,m.scenario_id),hw:c.hw.clone(),model_name:c.model_name.clone(),model_digest:c.model_digest.clone(),quant:c.quant.clone(),num_ctx:c.attempts[attempts[0].plan_index].request.num_ctx.unwrap_or(0),
            kv_cache_type:"unknown".into(),flash_attn:None,ollama_version:None,suite_id:SUITE_ID.into(),suite_version:c.suite_version,prefill_tps_median:m.prefill_tps_median,decode_tps_median:m.decode_tps_median,
            load_ms:export.attempts.iter().flat_map(frames).find(|v|v["kind"]=="mlx_load").and_then(|v|count(&v,"duration_ns")).map(|n|n/1_000_000),resident_bytes:None,repeats:m.planned_repeats as u32,install_id:c.install_id.clone(),rating:None,review:None,visible:true,created_at:s.created_at,updated_at:s.finished_at.unwrap_or(s.created_at),source:BenchSource::Local,synced_at:None,match_quality:Some(MatchQuality::Exact),prompt_id:Some(m.scenario_id.clone()),prompt_version:Some(c.prompt_version),ttft_ms_median:m.ttft_ms_median,
            env_start:attempts.first().and_then(|a|a.env_start.clone()),env_end:attempts.last().and_then(|a|a.env_end.clone()),prev_decode_tps_median:None,prev_ollama_version:None,thermal_label:None,
            notes:Some(format!("{}; decode scope is recorded in execution evidence; latency includes framed worker IPC; allocator peaks are in execution evidence; quality equivalence unchecked",c.runtime_version.as_deref().unwrap_or("MLX")))}
    }).collect()
}

impl Registry {
    pub fn mlx_suite_summary(&self, id: &str) -> Result<MlxSummary> {
        let e = self.bench_evidence(id)?;
        Ok(MlxSummary {
            session_id: e.session.id,
            model_name: e.session.config.model_name,
            runtime_version: e.session.config.runtime_version,
            outcome: e.session.outcome,
            error: e.session.error,
            report: e
                .derived
                .mlx
                .ok_or_else(|| error("session is not an MLX text suite"))?,
        })
    }

    /// Evidence is the only MLX result store; these are replayed views, never duplicate sample writes.
    pub fn mlx_suite_runs(
        &self,
        hw: &HwIdentity,
        model: Option<&Path>,
        reference: Option<&Path>,
        scenario: Option<&str>,
        history: bool,
    ) -> Result<Vec<BenchRun>> {
        let mut exports = Vec::new();
        for s in self.bench_sessions(200)? {
            if s.config.protocol == PROTOCOL
                && s.config.hw.hw_key == hw.hw_key
                && (history
                    || (s.config.suite_version == SUITE_VERSION
                        && s.formula_version == super::evidence::FORMULA_VERSION))
            {
                exports.push(self.bench_evidence(&s.id)?);
            }
        }
        let reference = reference.and_then(|p| {
            exports.iter().find(|e| {
                e.session.config.mlx.as_ref().is_some_and(|m| {
                    m.model_path == p
                        && m.identity
                            .as_ref()
                            .is_some_and(|id| id["tokenizer_fingerprint"].is_string())
                })
            })
        });
        let stratum = reference.map(|e| {
            (
                e.session.config.mlx.as_ref().unwrap().identity.clone(),
                e.session.config.runtime_version.clone(),
                e.session.config.prompt_version,
                e.session.config.hw.os_version.clone(),
            )
        });
        let mut seen = std::collections::HashSet::new();
        let mut result = Vec::new();
        for e in exports {
            let cfg = e.session.config.mlx.as_ref().unwrap();
            if model.is_some_and(|p| cfg.model_path != p)
                || (!history
                    && stratum.as_ref().is_none_or(|(id, version, prompt, os)| {
                        let a = cfg.identity.as_ref();
                        let b = id.as_ref();
                        a.and_then(|id| id.get("tokenizer_fingerprint"))
                            != b.and_then(|id| id.get("tokenizer_fingerprint"))
                            || a.and_then(|id| id.get("sources"))
                                != b.and_then(|id| id.get("sources"))
                            || &e.session.config.runtime_version != version
                            || &e.session.config.prompt_version != prompt
                            || &e.session.config.hw.os_version != os
                    }))
            {
                continue;
            }
            for run in runs(&e) {
                if scenario.is_some_and(|p| run.prompt_id.as_deref() != Some(p)) {
                    continue;
                }
                if history
                    || seen.insert((run.model_digest.clone(), run.prompt_id.clone(), run.num_ctx))
                {
                    result.push(run);
                }
            }
        }
        if !history {
            result.sort_by(|a, b| {
                b.decode_tps_median
                    .partial_cmp(&a.decode_tps_median)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        Ok(result)
    }

    pub fn run_mlx_suite<F>(
        &self,
        path: &Path,
        root: &Path,
        hw: &HwIdentity,
        install: &str,
        repeats: RepeatsMode,
        only: Option<&str>,
        cancel: &AtomicBool,
        mut progress: F,
    ) -> Result<Vec<BenchRun>>
    where
        F: FnMut(BenchProgress),
    {
        let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let mut plans = Vec::new();
        for (ctx, group) in prompts::grouped_by_ctx() {
            let group: Vec<_> = group
                .into_iter()
                .filter(|s| only.is_none_or(|id| s.id == id))
                .collect();
            if group.is_empty() {
                continue;
            }
            plans.push(PlannedAttempt {
                scenario_id: group[0].id.into(),
                repeat_index: 0,
                is_warmup: true,
                prompt_tokens_target: None,
                request: GenerateRequest::for_benchmark(
                    path.to_string_lossy().as_ref(),
                    "Warm up the runtime. Briefly describe a lighthouse.",
                    64,
                    ctx,
                ),
            });
            for s in group {
                for i in 1..=prompts::repeats_for(s, repeats) {
                    plans.push(PlannedAttempt {
                        scenario_id: s.id.into(),
                        repeat_index: i,
                        is_warmup: false,
                        prompt_tokens_target: Some(s.prompt_tokens),
                        request: GenerateRequest::for_benchmark(
                            path.to_string_lossy().as_ref(),
                            s.text(),
                            s.gen_tokens as u64,
                            ctx,
                        ),
                    });
                }
            }
        }
        if plans.is_empty() {
            return Err(error("unknown MLX scenario"));
        }
        progress(BenchProgress::Status {
            message: "Preparing MLX with uv…".into(),
        });
        let mut worker = Worker::spawn(root);
        let mut identity = None;
        let mut rejected = None;
        let handshake: Result<()> = (|| {
            let w = worker.as_mut().map_err(|e| error(e.to_string()))?;
            w.send(
                &json!({"protocol_version":1,"mode":"suite","model_path":path,"attempts":plans}),
            )?;
            let line = w
                .next(cancel, Instant::now() + Duration::from_secs(300))?
                .ok_or_else(|| error("MLX closed before its manifest"))?;
            rejected = Some(line.clone());
            let v: Value = serde_json::from_slice(&line)?;
            if v["kind"] != "manifest"
                || v["protocol_version"] != 1
                || !v["identity"]["model_digest"].is_string()
            {
                return Err(error(v["error"].as_str().unwrap_or("invalid MLX manifest")));
            }
            identity = Some(v["identity"].clone());
            rejected = None;
            Ok(())
        })();
        let name = super::mlx::cached_models()
            .into_iter()
            .find(|m| m.path == path)
            .map(|m| m.name)
            .unwrap_or_else(|| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into()
            });
        let session=self.begin_bench_session(SessionConfig{protocol:PROTOCOL.into(),suite_id:SUITE_ID.into(),suite_version:SUITE_VERSION,prompt_version:prompts::PROMPT_CATALOG_VERSION,hw:hw.clone(),install_id:install.into(),model_name:name,
            model_digest:identity.as_ref().and_then(|v|v["model_digest"].as_str()).unwrap_or("unverified").into(),quant:identity.as_ref().and_then(|v|v["quantization"]["bits"].as_u64()).map(|b|format!("{b}-bit")),runtime_version:identity.as_ref().map(|v|format!("MLX {} / MLX-LM {}",v["versions"]["mlx"].as_str().unwrap_or("unknown"),v["versions"]["mlx-lm"].as_str().unwrap_or("unknown"))),
            server_is_local:true,concurrency:1,connection_policy:"resident worker; each framed request closes at attempt_finished; client latency includes IPC/formatting, not HTTP".into(),cache_policy:"fresh KVCache per request; one distinct warmup per context; no prefix reuse".into(),counter_calibration:"post-first sampled-token worker clock through terminal stream drain; TTFT separate; upstream rates retained independently".into(),attempts:plans,calibration:None,native:None,mlx:Some(MlxConfig{protocol_version:1,model_path:path,identity})})?;
        let mut attempt = self.begin_bench_attempt(&session, 0)?;
        attempt.env_start = Some(anchor_system::telemetry::snapshot());
        attempt.events.push(RawEvent {
            at_ns: 0,
            kind: EventKind::Dispatch,
        });
        if let Some(bytes) = rejected {
            attempt.events.push(RawEvent {
                at_ns: 0,
                kind: EventKind::Frame { bytes },
            });
        }
        let mut clock = Instant::now();
        let mut sampler = super::LiveSampler::new();
        let mut announced = std::collections::HashSet::new();
        let mut finished = false;
        let mut marker = false;
        let mut emitted = std::collections::HashSet::new();
        let total = session
            .config
            .attempts
            .iter()
            .filter(|p| !p.is_warmup)
            .map(|p| p.scenario_id.clone())
            .collect::<std::collections::HashSet<_>>()
            .len() as u32;
        let collection: Result<()> = (|| {
            handshake?;
            let w = worker.as_mut().map_err(|e| error(e.to_string()))?;
            w.send(&json!({"run":true}))?;
            while let Some(line) = w.next(cancel, clock + Duration::from_secs(300))? {
                let v: Value = serde_json::from_slice(&line)?;
                attempt.events.push(RawEvent {
                    at_ns: clock.elapsed().as_nanos() as u64,
                    kind: EventKind::Frame { bytes: line },
                });
                let plan = &session.config.attempts[attempt.plan_index];
                match v["kind"].as_str().unwrap_or("") {
                    "attempt_started" => {
                        if v["plan_index"].as_u64() != Some(attempt.plan_index as u64) {
                            return Err(error("MLX attempt order changed"));
                        }
                        if plan.is_warmup {
                            progress(BenchProgress::Status {
                                message: format!(
                                    "Warming MLX at {}K context",
                                    plan.request.num_ctx.unwrap_or(0) / 1024
                                ),
                            });
                        } else if announced.insert(plan.scenario_id.clone()) {
                            progress(BenchProgress::ScenarioStarted {
                                scenario_id: plan.scenario_id.clone(),
                                num_ctx: plan.request.num_ctx.unwrap_or(0),
                                index: announced.len() as u32,
                                total,
                            });
                        }
                    }
                    "mlx_input" => {
                        attempt.observed_context =
                            v["context"].as_u64().and_then(|v| v.try_into().ok());
                        attempt.observed_digest = v["model_digest"].as_str().map(str::to_owned);
                    }
                    "generation"
                        if v["done"] != true
                            && v["response"].as_str().is_some_and(|s| !s.is_empty()) =>
                    {
                        if let Some(rate) = sampler.on_token() {
                            progress(BenchProgress::Sample {
                                chunks_per_sec: rate,
                            });
                        }
                    }
                    "attempt_finished" => {
                        if finished || v["plan_index"].as_u64() != Some(attempt.plan_index as u64) {
                            return Err(error("duplicate or mismatched MLX request close"));
                        }
                        if v["outcome"] != "completed" {
                            attempt.outcome = if v["outcome"] == "invalid" {
                                Outcome::Invalid
                            } else {
                                Outcome::Failed
                            };
                            return Err(error(v["error"].as_str().unwrap_or("MLX request failed")));
                        }
                        finished = true;
                        if attempt.plan_index + 1 < session.config.attempts.len() {
                            self.finish_mlx_text_attempt(
                                &mut attempt,
                                clock,
                                Outcome::Completed,
                                None,
                            )?;
                            let e = self.bench_evidence(&session.id)?;
                            for r in runs(&e) {
                                if emitted.insert(r.prompt_id.clone()) {
                                    progress(BenchProgress::ScenarioDone {
                                        run: Box::new(r),
                                        index: emitted.len() as u32,
                                        total,
                                    });
                                }
                            }
                            attempt = self.begin_bench_attempt(&session, attempt.plan_index + 1)?;
                            attempt.env_start = Some(anchor_system::telemetry::snapshot());
                            attempt.events.push(RawEvent {
                                at_ns: 0,
                                kind: EventKind::Dispatch,
                            });
                            clock = Instant::now();
                            finished = false;
                            sampler = super::LiveSampler::new();
                            w.send(&json!({"next":attempt.plan_index}))?;
                        }
                    }
                    "session_finished" => {
                        if !finished
                            || attempt.plan_index + 1 != session.config.attempts.len()
                            || v["outcome"] != "completed"
                            || v["identity_unchanged"] != true
                        {
                            return Err(error(
                                "MLX runtime/checkpoint identity changed or suite incomplete",
                            ));
                        }
                        marker = true;
                    }
                    "error" => {
                        return Err(error(v["error"].as_str().unwrap_or("MLX worker failed")))
                    }
                    _ => {}
                }
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(status) = w.child.try_wait().map_err(|e| error(e.to_string()))? {
                    if !status.success() {
                        return Err(error("MLX worker exited unsuccessfully"));
                    }
                    break;
                }
                if Instant::now() > deadline {
                    return Err(error("MLX worker failed to exit"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            if !marker {
                return Err(error("missing MLX session completion"));
            }
            Ok(())
        })();
        let mut outcome = match &collection {
            Ok(()) => Outcome::Completed,
            Err(crate::Error::Cancelled) => Outcome::Cancelled,
            Err(e) if e.to_string().contains("timed out") => Outcome::TimedOut,
            Err(_) => Outcome::Failed,
        };
        let mut reason = collection.err().map(|e| {
            let stderr = worker
                .as_mut()
                .ok()
                .map(Worker::diagnostics)
                .unwrap_or_default();
            format!("{e}\n{stderr}").trim().to_string()
        });
        let attempt_outcome = if attempt.outcome == Outcome::Invalid {
            Outcome::Invalid
        } else {
            outcome
        };
        self.finish_mlx_text_attempt(&mut attempt, clock, attempt_outcome, reason.clone())?;
        let derived = self.bench_evidence(&session.id)?.derived;
        if outcome == Outcome::Completed
            && (derived.scenarios.iter().any(|m| !m.complete)
                || derived
                    .attempts
                    .iter()
                    .any(|m| !m.validation_errors.is_empty()))
        {
            outcome = Outcome::Invalid;
            reason = Some("MLX evidence did not pass replay validation".into());
        }
        self.finish_bench_session(&session.id, outcome, reason.as_deref())?;
        let results = runs(&self.bench_evidence(&session.id)?);
        if matches!(outcome, Outcome::Completed | Outcome::Cancelled) {
            for r in &results {
                if emitted.insert(r.prompt_id.clone()) {
                    progress(BenchProgress::ScenarioDone {
                        run: Box::new(r.clone()),
                        index: emitted.len() as u32,
                        total,
                    });
                }
            }
            progress(BenchProgress::Done {
                runs: results.clone(),
            });
            Ok(results)
        } else {
            Err(error(reason.unwrap_or_else(|| "MLX suite failed".into())))
        }
    }

    fn finish_mlx_text_attempt(
        &self,
        a: &mut Attempt,
        clock: Instant,
        outcome: Outcome,
        reason: Option<String>,
    ) -> Result<()> {
        if outcome == Outcome::Completed {
            a.events.push(RawEvent {
                at_ns: clock.elapsed().as_nanos() as u64,
                kind: EventKind::TransportClosed,
            });
        }
        a.outcome = outcome;
        a.error = reason;
        a.env_end = Some(anchor_system::telemetry::snapshot());
        a.events.push(RawEvent {
            at_ns: clock.elapsed().as_nanos() as u64,
            kind: EventKind::Outcome,
        });
        self.finish_bench_attempt(a)
    }
}
