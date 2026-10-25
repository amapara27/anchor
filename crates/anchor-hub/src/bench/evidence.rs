//! Versioned serving evidence. Derived values are always replayed from raw frames.
use anchor_core::{EnvTelemetry, HwIdentity};
use serde::{Deserialize, Serialize};

use crate::{GenerateRequest, GenerationStats, Registry, Result};

pub const FORMULA_VERSION: u32 = 1;
pub const RECORD_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedAttempt {
    pub scenario_id: String,
    pub repeat_index: u32,
    pub is_warmup: bool,
    pub prompt_tokens_target: Option<u32>,
    pub request: GenerateRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub protocol: String,
    pub suite_id: String,
    pub suite_version: u32,
    pub prompt_version: u32,
    pub hw: HwIdentity,
    pub install_id: String,
    pub model_name: String,
    pub model_digest: String,
    pub quant: Option<String>,
    pub runtime_version: Option<String>,
    pub server_is_local: bool,
    pub concurrency: u32,
    pub connection_policy: String,
    pub cache_policy: String,
    pub counter_calibration: String,
    pub attempts: Vec<PlannedAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration: Option<super::calibration::CalibrationIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchSession {
    pub id: String,
    pub record_version: u32,
    pub formula_version: u32,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub config: SessionConfig,
    pub outcome: Outcome,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: String,
    pub protocol: String,
    pub model_name: String,
    pub hw_key: String,
    pub created_at: i64,
    pub outcome: Outcome,
    pub error: Option<String>,
    pub planned_attempts: usize,
    pub recorded_attempts: u32,
    pub formula_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawEvent {
    /// Monotonic nanoseconds since dispatch, independent of the wall clock.
    pub at_ns: u64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    Dispatch,
    Frame { bytes: Vec<u8> },
    TransportClosed,
    Outcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attempt {
    pub id: String,
    pub session_id: String,
    pub plan_index: usize,
    pub wall_start_ms: i64,
    pub observed_context: Option<u32>,
    pub observed_digest: Option<String>,
    pub env_start: Option<EnvTelemetry>,
    pub env_end: Option<EnvTelemetry>,
    pub resident_bytes: Option<u64>,
    pub events: Vec<RawEvent>,
    pub outcome: Outcome,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration: Option<super::calibration::ProbeObservation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Metric {
    pub value: Option<f64>,
    pub unavailable_reason: Option<String>,
}

impl Metric {
    fn known(value: f64) -> Self {
        Self { value: Some(value), unavailable_reason: None }
    }
    fn unknown(reason: &str) -> Self {
        Self { value: None, unavailable_reason: Some(reason.into()) }
    }
    fn time(at: Option<u64>, reason: &str) -> Self {
        at.map(|ns| Self::known(ns as f64 / 1e6)).unwrap_or_else(|| Self::unknown(reason))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptMetrics {
    #[serde(default = "diagnostic_status")]
    pub counter_status: String,
    pub counters: GenerationStats,
    pub finish_reason: Option<String>,
    pub first_output_ms: Metric,
    pub first_answer_ms: Metric,
    pub last_content_ms: Metric,
    pub completion_ms: Metric,
    pub decode_tps: Metric,
    pub prefill_tps: Metric,
    pub validation_errors: Vec<String>,
}

fn diagnostic_status() -> String { "diagnostic".into() }

fn rate(count: Option<u64>, duration: Option<u64>) -> Metric {
    match (count, duration) {
        (Some(c), Some(d)) if d > 0 => Metric::known(c as f64 / (d as f64 / 1e9)),
        (_, Some(0)) => Metric::unknown("zero_duration"),
        _ => Metric::unknown("missing_counter"),
    }
}

/// Cumulative counters are consumed once, at a single valid terminal frame.
pub fn recalculate(attempt: &Attempt, formula_version: u32) -> Result<AttemptMetrics> {
    if formula_version != FORMULA_VERSION {
        return Err(crate::Error::Ollama(format!("unsupported benchmark formula version {formula_version}")));
    }
    let mut counters = GenerationStats::default();
    let (mut first, mut answer, mut last, mut terminal) = (None, None, None, None);
    let mut finish_reason = None;
    let mut errors = Vec::new();
    let mut previous = 0;
    let mut transport_closed = false;
    let mut ended = false;
    if !matches!(attempt.events.first().map(|e| &e.kind), Some(EventKind::Dispatch))
        || attempt.events.first().is_some_and(|e| e.at_ns != 0) {
        errors.push("missing_dispatch".into());
    }
    for (index, event) in attempt.events.iter().enumerate() {
        if event.at_ns < previous { errors.push("nonmonotonic_events".into()); }
        previous = event.at_ns;
        if ended { errors.push("event_after_outcome".into()); }
        match &event.kind {
            EventKind::TransportClosed => {
                if transport_closed { errors.push("duplicate_transport_close".into()); }
                transport_closed = true;
            }
            EventKind::Outcome => ended = true,
            EventKind::Frame {..} if transport_closed => errors.push("frame_after_transport_close".into()),
            _ => {}
        }
        if index > 0 && matches!(event.kind, EventKind::Dispatch) { errors.push("duplicate_dispatch".into()); }
        let EventKind::Frame { bytes } = &event.kind else { continue };
        let frame: serde_json::Value = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            Err(_) => { errors.push("malformed_frame".into()); continue; }
        };
        if terminal.is_some() { errors.push("frame_after_terminal".into()); continue; }
        if !frame.is_object() { errors.push("invalid_frame".into()); continue; }
        for field in ["response", "thinking"] {
            if frame.get(field).is_some_and(|v| !v.is_string()) { errors.push(format!("invalid_field:{field}")); }
        }
        if frame.get("done").is_some_and(|v| !v.is_boolean()) { errors.push("invalid_field:done".into()); }
        if frame.get("error").is_some_and(|v| !v.is_null()) { errors.push("server_error".into()); }
        let content = frame.get("response").and_then(|v| v.as_str()).is_some_and(|v| !v.is_empty());
        let reasoning = frame.get("thinking").and_then(|v| v.as_str()).is_some_and(|v| !v.is_empty());
        if content || reasoning { first.get_or_insert(event.at_ns); last = Some(event.at_ns); }
        if content { answer.get_or_insert(event.at_ns); }
        if frame.get("done").and_then(|v| v.as_bool()) == Some(true) {
            terminal = Some(event.at_ns);
            finish_reason = frame.get("done_reason").and_then(|v| v.as_str()).map(str::to_owned);
            let mut count = |key: &str| match frame.get(key) {
                None | Some(serde_json::Value::Null) => None,
                Some(v) => match v.as_u64() {
                    Some(n) => Some(n),
                    None => { errors.push(format!("invalid_counter:{key}")); None }
                },
            };
            counters.total_duration_ns = count("total_duration");
            counters.load_duration_ns = count("load_duration");
            counters.prompt_eval_count = count("prompt_eval_count");
            counters.prompt_eval_cached_count = count("prompt_eval_cached_count");
            counters.prompt_eval_duration_ns = count("prompt_eval_duration");
            counters.eval_count = count("eval_count");
            counters.eval_duration_ns = count("eval_duration");
        }
    }
    if terminal.is_none() { errors.push("missing_terminal".into()); }
    if !ended { errors.push("missing_outcome_event".into()); }
    if attempt.outcome == Outcome::Completed && !transport_closed { errors.push("missing_transport_close".into()); }
    let cached_exceeds_total = counters.prompt_eval_cached_count.zip(counters.prompt_eval_count).is_some_and(|(c, t)| c > t);
    if cached_exceeds_total { errors.push("cached_count_exceeds_total".into()); }
    let mut decode = rate(counters.eval_count, counters.eval_duration_ns);
    let mut prefill = match (counters.prompt_eval_count, counters.prompt_eval_cached_count) {
        (Some(total), Some(cached)) if cached > total => Metric::unknown("cached_count_exceeds_total"),
        (Some(total), Some(cached)) if cached == total => Metric::unknown("fully_cached_not_applicable"),
        (Some(total), Some(cached)) => rate(Some(total - cached), counters.prompt_eval_duration_ns),
        _ => Metric::unknown("cache_count_unknown"),
    };
    let trace_invalid = errors.iter().any(|e| !e.starts_with("invalid_counter:") && e != "cached_count_exceeds_total");
    let clock_invalid = errors.iter().any(|e| matches!(e.as_str(), "nonmonotonic_events" | "missing_dispatch" | "duplicate_dispatch"));
    if trace_invalid || attempt.outcome != Outcome::Completed {
        let reason = attempt.error.as_deref().unwrap_or("attempt_not_valid_completed");
        if decode.value.is_some() { decode = Metric::unknown(reason); }
        if prefill.value.is_some() { prefill = Metric::unknown(reason); }
    }
    counters.ttft_ms = if clock_invalid { None } else { first.map(|ns| ns as f64 / 1e6) };
    let trace_time = |at, missing| if clock_invalid { Metric::unknown("invalid_clock_trace") } else { Metric::time(at, missing) };
    Ok(AttemptMetrics {
        counter_status: diagnostic_status(),
        counters, finish_reason,
        first_output_ms: trace_time(first, "no_output_observed"),
        first_answer_ms: trace_time(answer, "no_answer_observed"),
        last_content_ms: trace_time(last, "no_output_observed"),
        completion_ms: if attempt.outcome == Outcome::Completed && !trace_invalid { trace_time(terminal, "missing_terminal") } else { Metric::unknown("attempt_not_valid_completed") },
        decode_tps: decode, prefill_tps: prefill, validation_errors: errors,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceExport {
    pub session: BenchSession,
    pub attempts: Vec<Attempt>,
    pub derived: Recalculated,
    pub results: Vec<anchor_core::BenchRun>,
}

impl Registry {
    pub fn bench_session_summaries(&self, limit: u32) -> Result<Vec<SessionSummary>> {
        let conn = self.connect()?;
        self.bench_sessions(limit)?.into_iter().map(|s| {
            let count = conn.query_row("SELECT COUNT(*) FROM benchmark_attempts WHERE session_id=?1", [&s.id], |r| r.get(0))?;
            Ok(SessionSummary { id: s.id, protocol: s.config.protocol, model_name: s.config.model_name, hw_key: s.config.hw.hw_key,
                created_at: s.created_at, outcome: s.outcome, error: s.error, planned_attempts: s.config.attempts.len(),
                recorded_attempts: count, formula_version: s.formula_version })
        }).collect()
    }

    pub(crate) fn begin_bench_session(&self, config: SessionConfig) -> Result<BenchSession> {
        let conn = self.connect()?;
        let id: String = conn.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        let session = BenchSession {
            id, config, record_version: RECORD_VERSION, formula_version: FORMULA_VERSION,
            created_at: super::now_ms(), finished_at: None, outcome: Outcome::Running, error: None,
        };
        conn.execute("INSERT INTO benchmark_sessions (id, config_json, record_version, formula_version, created_at, outcome_json) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![session.id, serde_json::to_string(&session.config)?, session.record_version, session.formula_version, session.created_at, serde_json::to_string(&session.outcome)?])?;
        Ok(session)
    }

    pub(crate) fn finish_bench_session(&self, id: &str, outcome: Outcome, error: Option<&str>) -> Result<()> {
        let changed = self.connect()?.execute("UPDATE benchmark_sessions SET finished_at=?2, outcome_json=?3, error=?4 WHERE id=?1 AND finished_at IS NULL",
            rusqlite::params![id, super::now_ms(), serde_json::to_string(&outcome)?, error])?;
        if changed != 1 { return Err(crate::Error::Ollama("benchmark session already finalized or missing".into())); }
        Ok(())
    }

    pub(crate) fn begin_bench_attempt(&self, session: &BenchSession, plan_index: usize) -> Result<Attempt> {
        let attempt = Attempt {
            id: format!("{}:{plan_index}", session.id), session_id: session.id.clone(), plan_index,
            wall_start_ms: super::now_ms(), observed_context: None, observed_digest: None, env_start: None, env_end: None,
            resident_bytes: None, events: Vec::new(), outcome: Outcome::Running, error: None,
            calibration: None,
        };
        self.connect()?.execute("INSERT INTO benchmark_attempts (id,session_id,plan_index,record_json) VALUES (?1,?2,?3,?4)",
            rusqlite::params![attempt.id, session.id, plan_index, serde_json::to_string(&attempt)?])?;
        Ok(attempt)
    }

    pub(crate) fn finish_bench_attempt(&self, attempt: &Attempt) -> Result<()> {
        // shortcut: frames commit at finalization; add a streaming journal for crash-durable traces.
        let changed = self.connect()?.execute("UPDATE benchmark_attempts SET record_json=?2, finished=TRUE WHERE id=?1 AND finished=FALSE",
            rusqlite::params![attempt.id, serde_json::to_string(attempt)?])?;
        if changed != 1 { return Err(crate::Error::Ollama("benchmark attempt already finalized or missing".into())); }
        Ok(())
    }

    /// Includes sessions without successful results, without needing a live runtime.
    pub fn bench_sessions(&self, limit: u32) -> Result<Vec<BenchSession>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT id,config_json,record_version,formula_version,created_at,finished_at,outcome_json,error FROM benchmark_sessions ORDER BY created_at DESC,rowid DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, u32>(2)?, r.get::<_, u32>(3)?,
            r.get::<_, i64>(4)?, r.get::<_, Option<i64>>(5)?, r.get::<_, String>(6)?, r.get::<_, Option<String>>(7)?,
        )))?;
        rows.map(|r| {
            let (id, config, record_version, formula_version, created_at, finished_at, outcome, error) = r?;
            Ok(BenchSession { id, config: serde_json::from_str(&config)?, record_version, formula_version,
                created_at, finished_at, outcome: serde_json::from_str(&outcome)?, error })
        }).collect()
    }

    /// Full-fidelity export contains the prompt and raw output; callers must make that explicit.
    pub fn bench_evidence(&self, session_or_run_id: &str) -> Result<EvidenceExport> {
        let id = session_or_run_id.split(':').next().unwrap_or(session_or_run_id);
        let mut connection = self.connect()?;
        let conn = connection.transaction()?;
        let (config, record_version, formula_version, created_at, finished_at, outcome, error) = conn.query_row(
            "SELECT config_json,record_version,formula_version,created_at,finished_at,outcome_json,error FROM benchmark_sessions WHERE id=?1", [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?, r.get::<_, u32>(2)?, r.get::<_, i64>(3)?,
                r.get::<_, Option<i64>>(4)?, r.get::<_, String>(5)?, r.get::<_, Option<String>>(6)?)))?;
        let session = BenchSession { id: id.into(), config: serde_json::from_str(&config)?, record_version, formula_version,
            created_at, finished_at, outcome: serde_json::from_str(&outcome)?, error };
        let mut stmt = conn.prepare("SELECT record_json FROM benchmark_attempts WHERE session_id=?1 ORDER BY plan_index")?;
        let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
        let attempts = rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect::<Result<Vec<Attempt>>>()?;
        let results = crate::db::bench_session_results(&conn, id)?;
        let mut export = EvidenceExport { session, attempts, results, derived: Recalculated { attempts: Vec::new(), scenarios: Vec::new(), calibration: None } };
        export.derived = export.recalculate()?;
        Ok(export)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioMetrics {
    pub scenario_id: String,
    pub planned_repeats: usize,
    pub completed_repeats: usize,
    pub complete: bool,
    pub decode_tps_median: Option<f64>,
    pub prefill_tps_median: Option<f64>,
    pub ttft_ms_median: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recalculated {
    pub attempts: Vec<AttemptMetrics>,
    pub scenarios: Vec<ScenarioMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration: Option<super::calibration::CalibrationReport>,
}

impl EvidenceExport {
    /// Ignores exported derived values; only the versioned raw evidence is input.
    pub fn recalculate(&self) -> Result<Recalculated> {
        if self.session.record_version != RECORD_VERSION {
            return Err(crate::Error::Ollama("unsupported benchmark record version".into()));
        }
        if self.session.formula_version != FORMULA_VERSION {
            return Err(crate::Error::Ollama("unsupported benchmark formula version".into()));
        }
        if self.session.config.calibration.as_ref().is_some_and(|c| c.protocol_version != 1) {
            return Err(crate::Error::Ollama("unsupported calibration protocol version".into()));
        }
        let mut seen = std::collections::HashSet::new();
        for attempt in &self.attempts {
            if attempt.session_id != self.session.id || attempt.plan_index >= self.session.config.attempts.len()
                || attempt.id != format!("{}:{}", self.session.id, attempt.plan_index)
                || !seen.insert(attempt.plan_index) {
                return Err(crate::Error::Ollama("invalid attempt identity or plan index".into()));
            }
        }
        let metrics: Vec<_> = self.attempts.iter().map(|a| recalculate(a, self.session.formula_version)).collect::<Result<_>>()?;
        if let Some(calibration) = super::calibration::report(self, &metrics) {
            return Ok(Recalculated { attempts: metrics, scenarios: Vec::new(), calibration: Some(calibration) });
        }
        let mut scenarios = Vec::new();
        for plan in self.session.config.attempts.iter().filter(|p| !p.is_warmup) {
            if scenarios.iter().any(|s: &ScenarioMetrics| s.scenario_id == plan.scenario_id) { continue; }
            let planned_repeats = self.session.config.attempts.iter().filter(|p| !p.is_warmup && p.scenario_id == plan.scenario_id).count();
            let measured: Vec<_> = self.attempts.iter().zip(&metrics).filter(|(a, _)| {
                let p = &self.session.config.attempts[a.plan_index];
                !p.is_warmup && p.scenario_id == plan.scenario_id && a.outcome == Outcome::Completed
            }).map(|(_, m)| m).collect();
            let contexts: std::collections::HashSet<_> = self.attempts.iter().filter(|a| {
                let p = &self.session.config.attempts[a.plan_index];
                !p.is_warmup && p.scenario_id == plan.scenario_id
            }).map(|a| a.observed_context).collect();
            let complete = measured.len() == planned_repeats && contexts.len() == 1 && !contexts.contains(&None)
                && measured.iter().all(|m| m.decode_tps.value.is_some() && m.validation_errors.is_empty())
                && self.attempts.iter().filter(|a| {
                    let p = &self.session.config.attempts[a.plan_index];
                    !p.is_warmup && p.scenario_id == plan.scenario_id
                }).all(|a| {
                    let p = &self.session.config.attempts[a.plan_index];
                    a.observed_context.zip(p.request.num_ctx).is_some_and(|(actual, requested)| actual >= requested)
                        && a.observed_digest.as_deref().is_some_and(|digest|
                            digest.trim_start_matches("sha256:") == self.session.config.model_digest.trim_start_matches("sha256:"))
                });
            // Partial scenarios stay in evidence but cannot masquerade as a fixed-budget result.
            let median = |f: fn(&AttemptMetrics) -> Option<f64>| {
                if !complete { return None; }
                super::median(measured.iter().map(|m| f(m)).collect::<Option<Vec<_>>>()?)
            };
            scenarios.push(ScenarioMetrics {
                scenario_id: plan.scenario_id.clone(), planned_repeats, completed_repeats: measured.len(), complete,
                decode_tps_median: median(|m| m.decode_tps.value),
                prefill_tps_median: median(|m| m.prefill_tps.value),
                ttft_ms_median: median(|m| m.first_output_ms.value),
            });
        }
        Ok(Recalculated { attempts: metrics, scenarios, calibration: None })
    }
}
