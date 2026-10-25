//! The benchmark suite: a versioned catalog of scenarios, each a (prompt
//! tokens, generation tokens) shape with a use case attached, plus the live
//! telemetry captured around each run.
//!
//! Lives in `anchor-hub` because it needs both halves this crate already
//! owns: the Ollama client that produces [`GenerationStats`], and the SQLite
//! connection the results land in.
//!
//! Serving phase rates use Ollama's diagnostic counters. TTFT measures HTTP
//! dispatch to first received output. Native MLX compute has separate worker
//! timing, allocator scopes and replay in [`mlx`], outside serving rankings.

mod prompts;
pub mod calibration;
pub mod evidence;
pub mod mlx;
pub mod mlx_suite;

pub use prompts::{RepeatsMode, Scenario, CATALOG, HEADLINE_SCENARIO, SUITE_ID, SUITE_VERSION};

use anchor_core::{BenchRun, BenchSample, BenchSource, EnvTelemetry, HwIdentity};
use rusqlite::OptionalExtension;
use serde::Serialize;
use evidence::{BenchSession, Outcome, PlannedAttempt, SessionConfig};

use crate::{ollama, status, GenerateRequest, Registry, Result};

/// `OSThermalPressureLevel`'s nominal value — anything above it is real
/// thermal pressure, not a threshold we picked.
const THERMAL_NOMINAL: u8 = 0;

/// Progress from a benchmark run, streamed to the UI over a Tauri channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BenchProgress {
    /// A human-readable phase, e.g. "warming up", "run 2 of 3".
    Status { message: String },
    /// One measured repeat of the current scenario finished.
    Run { index: u32, total: u32, decode_tps: f64 },
    /// One scenario started.
    ScenarioStarted { scenario_id: String, num_ctx: u32, index: u32, total: u32 },
    /// One scenario finished; its row is already stored.
    ScenarioDone { run: Box<BenchRun>, index: u32, total: u32 },
    /// The whole suite finished.
    Done { runs: Vec<BenchRun> },
    /// The suite failed partway.
    Failed { message: String },
    /// Recent response chunks per second; chunk boundaries are not tokens.
    Sample { chunks_per_sec: f64 },
}

/// Tracks received response chunks for the live activity waveform.
struct LiveSampler {
    window: std::collections::VecDeque<std::time::Instant>,
    last_emit: std::time::Instant,
}

/// Chunks behind each reading, to smooth arrival bursts.
const LIVE_SAMPLE_WINDOW: usize = 12;
/// Floor between emitted samples to limit channel traffic.
const LIVE_SAMPLE_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(90);

impl LiveSampler {
    pub(super) fn new() -> Self {
        Self { window: std::collections::VecDeque::with_capacity(LIVE_SAMPLE_WINDOW), last_emit: std::time::Instant::now() }
    }

    /// Records one chunk's arrival; returns a chunks/sec reading
    /// when the window has enough span and the throttle has elapsed.
    pub(super) fn on_token(&mut self) -> Option<f64> {
        let now = std::time::Instant::now();
        self.window.push_back(now);
        if self.window.len() > LIVE_SAMPLE_WINDOW {
            self.window.pop_front();
        }
        if self.window.len() < 2 || now.duration_since(self.last_emit) < LIVE_SAMPLE_MIN_INTERVAL {
            return None;
        }
        self.last_emit = now;
        let span = now.duration_since(*self.window.front().unwrap()).as_secs_f64();
        (span > 0.0).then(|| (self.window.len() - 1) as f64 / span)
    }
}

/// Median of a sample. Median rather than mean so a single thermal-throttle
/// outlier can't drag the reported number.
fn median(mut xs: Vec<f64>) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = xs.len() / 2;
    Some(if xs.len() % 2 == 0 {
        (xs[mid - 1] + xs[mid]) / 2.0
    } else {
        xs[mid]
    })
}

/// Tokens per second from a generation's own reported counters.
#[cfg(test)]
fn tps(count: Option<u64>, duration_ns: Option<u64>) -> Option<f64> {
    match (count, duration_ns) {
        (Some(c), Some(d)) if d > 0 => Some(c as f64 / (d as f64 / 1e9)),
        _ => None,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// A live telemetry snapshot, with `resident_model_count` filled in from this
/// registry's `/api/ps` (models other than `model` itself — what else is
/// competing for RAM). Shelled out on a blocking thread since it's a
/// synchronous subprocess call.
async fn capture_env(registry: &Registry, model: &str) -> EnvTelemetry {
    let mut env = tokio::task::spawn_blocking(anchor_system::telemetry::snapshot)
        .await
        .unwrap_or_default();
    if let Ok(running) = status::running(registry).await {
        env.resident_model_count = Some(running.iter().filter(|r| r.name != model).count() as u32);
    }
    env
}

/// Thermal pressure observed at either boundary; no claim about the intervals between.
fn thermal_label(start: &EnvTelemetry, end: &EnvTelemetry) -> String {
    // The OS pressure level first: it's the only thermal signal Apple Silicon
    // publishes, and any reading above nominal at either end means the run
    // wasn't cool. `pmset`'s speed limit is the Intel-era fallback below.
    if start.thermal_level.into_iter().chain(end.thermal_level).any(|level| level > THERMAL_NOMINAL) {
        return "pressure".into();
    }
    if let (Some(s), Some(e)) = (start.thermal_level, end.thermal_level) {
        return if s.max(e) > THERMAL_NOMINAL { "pressure" } else { "nominal" }.to_string();
    }
    match (start.thermal_pressure_pct, end.thermal_pressure_pct) {
        (Some(s), Some(e)) if s.min(e) < 100 => "pressure",
        (Some(_), Some(_)) => "nominal",
        _ => "unknown",
    }
    .to_string()
}

/// Anomaly notes auto-populated from the telemetry snapshots. `None` when
/// nothing stands out, so a clean run doesn't grow a placeholder note.
fn auto_notes(label: &str, start: &EnvTelemetry) -> Option<String> {
    let mut parts = Vec::new();
    if label == "pressure" {
        parts.push("thermal pressure observed at scenario boundaries".to_string());
    }
    if start.on_ac_power == Some(false) {
        parts.push("running on battery".to_string());
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

impl Registry {
    /// Benchmark results from machines resembling `hw`, best match first, each
    /// tagged with the tier it matched at.
    ///
    /// `model_digest: None` ranks every model against every other one — the
    /// leaderboard's cross-model view, meaningful once `suite_id`/`prompt_id`/
    /// `num_ctx` pin the comparison to one configuration. `suite_id`:
    /// `Some(SUITE_ID)` shows only Quick results once Full-mode rows exist, so
    /// the two suites' numbers are never blended into one leaderboard.
    pub fn bench_runs_for(
        &self,
        hw: &HwIdentity,
        model_digest: Option<&str>,
        suite_id: Option<&str>,
        prompt_id: Option<&str>,
        num_ctx: Option<u32>,
    ) -> Result<Vec<BenchRun>> {
        crate::db::bench_runs_for(&self.connect()?, hw, model_digest, suite_id, prompt_id, num_ctx)
    }

    /// Raw per-repeat samples behind a stored run's medians.
    pub fn bench_samples_for(&self, bench_run_id: &str) -> Result<Vec<BenchSample>> {
        let conn = self.connect()?;
        let stored = crate::db::bench_samples_for(&conn, bench_run_id)?;
        if !stored.is_empty() || !bench_run_id.contains(':') {
            return Ok(stored);
        }
        let is_evidence_backed = conn
            .query_row(
                "SELECT suite_id = ?2 AND suite_version >= ?3 FROM bench_runs WHERE id = ?1",
                rusqlite::params![bench_run_id, SUITE_ID, SUITE_VERSION],
                |row| row.get::<_, bool>(0),
            )
            .optional()?;
        if is_evidence_backed != Some(true) {
            return Ok(stored);
        }
        let Some((session_id, scenario_id)) = bench_run_id.split_once(':') else {
            return Ok(stored);
        };
        let evidence = self.bench_evidence(session_id)?;
        let mut samples = evidence
            .attempts
            .iter()
            .zip(&evidence.derived.attempts)
            .filter_map(|(attempt, metrics)| {
                let plan = evidence.session.config.attempts.get(attempt.plan_index)?;
                (plan.scenario_id == scenario_id
                    && !plan.is_warmup
                    && attempt.outcome == evidence::Outcome::Completed)
                    .then(|| BenchSample {
                        id: format!("{bench_run_id}#{}", plan.repeat_index),
                        bench_run_id: bench_run_id.to_string(),
                        repeat_index: plan.repeat_index,
                        is_warmup: false,
                        prefill_tps: metrics.prefill_tps.value,
                        decode_tps: metrics.decode_tps.value,
                        ttft_ms: metrics.first_output_ms.value,
                        prompt_eval_count: metrics.counters.prompt_eval_count,
                        prompt_eval_cached_count: metrics.counters.prompt_eval_cached_count,
                        prompt_eval_duration_ns: metrics.counters.prompt_eval_duration_ns,
                        eval_count: metrics.counters.eval_count,
                        eval_duration_ns: metrics.counters.eval_duration_ns,
                        total_duration_ns: metrics.counters.total_duration_ns,
                        load_duration_ns: metrics.counters.load_duration_ns,
                        wall_start_ms: attempt.wall_start_ms,
                        created_at: attempt.wall_start_ms,
                    })
            })
            .collect::<Vec<_>>();
        samples.sort_by_key(|sample| sample.repeat_index);
        Ok(samples)
    }

    /// Recent benchmark runs on this exact machine, newest first — the
    /// History panel's feed (chronological), not [`Self::bench_runs_for`]'s
    /// ranked-by-speed leaderboard. `model_digest: None` mixes every model.
    pub fn bench_history(&self, hw: &HwIdentity, model_digest: Option<&str>, limit: u32) -> Result<Vec<BenchRun>> {
        crate::db::bench_history(&self.connect()?, &hw.hw_key, model_digest, limit)
    }

    /// Updates a run's free-text notes.
    pub fn update_bench_notes(&self, run_id: &str, notes: Option<&str>) -> Result<()> {
        crate::db::update_bench_notes(&self.connect()?, run_id, notes)
    }

    /// Runs the suite against `model`, storing each scenario as its own row.
    ///
    /// Scenarios are grouped by derived `num_ctx` and run in ascending order so
    /// the model reloads once per distinct context size, not once per scenario
    /// — Ollama reloads on a `num_ctx` change, not on a prompt change. Each
    /// context group gets one retained warmup to establish its allocation
    /// and warm the runtime before collecting measurements.
    ///
    /// Setting `cancel` ends the suite at the next scenario boundary, or mid
    /// generation via [`ollama::generate`]. A stop is a normal terminal state,
    /// not an error: the scenarios that already finished were measured at full
    /// rigor and keep their rows. Interrupted attempts remain in session evidence
    /// and never become leaderboard results. The model is unloaded on the way out.
    ///
    /// `only` restricts the suite to one scenario id (the app's quick measure);
    /// its row is identical to what the full suite would store for it.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_benchmark<F>(
        &self,
        model: &str,
        hw: &HwIdentity,
        install_id: &str,
        repeats: RepeatsMode,
        only: Option<&str>,
        cancel: &std::sync::atomic::AtomicBool,
        on_progress: F,
    ) -> Result<Vec<BenchRun>>
    where
        F: FnMut(BenchProgress) + Send,
    {
        let result = self.run_benchmark_inner(model, hw, install_id, repeats, only, cancel, on_progress).await;
        let _ = self.unload(model).await;
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_benchmark_inner<F>(
        &self, model: &str, hw: &HwIdentity, install_id: &str, repeats: RepeatsMode, only: Option<&str>,
        cancel: &std::sync::atomic::AtomicBool, mut on_progress: F,
    ) -> Result<Vec<BenchRun>> where F: FnMut(BenchProgress) + Send {
        let digest = ollama::digest_of(&self.host, model)
            .await?
            .ok_or_else(|| crate::Error::Ollama(format!("{model} is not installed")))?;
        let ollama_version = ollama::version(&self.host).await.ok();
        let quant = ollama::list_local_models(&self.host).await?
            .into_iter().find(|m| m.id == model).and_then(|m| m.quantization);

        let groups: Vec<_> = prompts::grouped_by_ctx()
            .into_iter()
            .map(|(ctx, group)| (ctx, group.into_iter().filter(|s| only.is_none_or(|id| s.id == id)).collect::<Vec<_>>()))
            .filter(|(_, group)| !group.is_empty())
            .collect();
        if groups.is_empty() {
            return Err(crate::Error::Ollama(format!("unknown scenario {}", only.unwrap_or_default())));
        }
        let mut plan = Vec::new();
        for (ctx, scenarios) in &groups {
            plan.push(PlannedAttempt {
                scenario_id: scenarios[0].id.into(), repeat_index: 0, is_warmup: true, prompt_tokens_target: None,
                request: GenerateRequest::for_benchmark(model, "Warm up the runtime. Briefly describe a lighthouse.", 64, *ctx),
            });
            for scenario in scenarios {
                for i in 1..=prompts::repeats_for(scenario, repeats) {
                    plan.push(PlannedAttempt {
                        scenario_id: scenario.id.into(), repeat_index: i, is_warmup: false,
                        prompt_tokens_target: Some(scenario.prompt_tokens),
                        request: GenerateRequest::for_benchmark(model, scenario.text(), scenario.gen_tokens as u64, *ctx),
                    });
                }
            }
        }
        let session = self.begin_bench_session(SessionConfig {
            protocol: "ollama_http_serving".into(), suite_id: SUITE_ID.into(), suite_version: SUITE_VERSION,
            prompt_version: prompts::PROMPT_CATALOG_VERSION, hw: hw.clone(), install_id: install_id.into(),
            model_name: model.into(), model_digest: digest.clone(), quant: quant.clone(), runtime_version: ollama_version.clone(),
            server_is_local: crate::is_local_host(&self.host), concurrency: 1,
            connection_policy: "new HTTP client per attempt; connection setup included".into(),
            cache_policy: "unverified; distinct warmup prompt; runtime counters retained".into(),
            counter_calibration: "diagnostic: runtime token/EOS conventions and phase timer boundaries require calibration".into(), attempts: plan,
            calibration: None, native: None, mlx: None,
        })?;
        let total = groups.iter().map(|(_, g)| g.len()).sum::<usize>() as u32;
        let mut index = 0u32;
        let mut plan_index = 0;
        let mut results = Vec::new();
        let collection: Result<()> = async {
            'suite: for (num_ctx, scenarios) in groups {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) { break 'suite; }
                on_progress(BenchProgress::Status { message: format!("unloading model before {num_ctx} context") });
                self.unload(model).await?;
                on_progress(BenchProgress::Status { message: format!("warming up at {num_ctx} context") });
                let warmup = match self.benchmark_attempt(&session, plan_index, cancel, &mut on_progress).await {
                    Ok((_, metrics)) => metrics,
                    Err(crate::Error::Cancelled) => break 'suite,
                    Err(e) => return Err(e),
                };
                plan_index += 1;
                let load_ms = warmup.counters.load_duration_ns.map(|ns| ns / 1_000_000);
                for scenario in scenarios {
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) { break 'suite; }
                    index += 1;
                    on_progress(BenchProgress::ScenarioStarted { scenario_id: scenario.id.into(), num_ctx, index, total });
                    let repeat_count = prompts::repeats_for(scenario, repeats);
                    let id = format!("{}:{}", session.id, scenario.id);
                    let mut attempts = Vec::new();
                    for i in 1..=repeat_count {
                        let (attempt, metrics) = match self.benchmark_attempt(&session, plan_index, cancel, &mut on_progress).await {
                            Ok(value) => value,
                            Err(crate::Error::Cancelled) => break 'suite,
                            Err(e) => return Err(e),
                        };
                        plan_index += 1;
                        if attempts.first().is_some_and(|a: &evidence::Attempt| a.observed_context != attempt.observed_context) {
                            return Err(crate::Error::Ollama("loaded context changed between repeats".into()));
                        }
                        if let Some(d) = metrics.decode_tps.value {
                            on_progress(BenchProgress::Run { index: i, total: repeat_count, decode_tps: d });
                        }
                        attempts.push(attempt);
                    }
                    let actual_ctx = attempts[0].observed_context.unwrap();
                    let env_start = attempts.first().and_then(|a| a.env_start.clone()).unwrap_or_default();
                    let env_end = attempts.last().and_then(|a| a.env_end.clone()).unwrap_or_default();
                    let label = thermal_label(&env_start, &env_end);
                    let notes = auto_notes(&label, &env_start);
                    let resident_bytes = attempts.last().and_then(|a| a.resident_bytes);
                    // Replay is also the source of the values stored for UI and CLI readers.
                    let replay = self.bench_evidence(&session.id)?.derived;
                    let summary = replay.scenarios.iter().find(|s| s.scenario_id == scenario.id).unwrap();
                    let previous = self.bench_history(hw, Some(&digest), 200)?.into_iter().find(|r|
                        r.prompt_id.as_deref() == Some(scenario.id) && r.num_ctx == actual_ctx && r.suite_version == SUITE_VERSION);
                    let (prev_decode, prev_version) = match previous {
                        Some(r) if r.ollama_version != ollama_version => (r.decode_tps_median, r.ollama_version),
                        Some(r) => (r.prev_decode_tps_median, r.prev_ollama_version),
                        None => (None, None),
                    };
                    let now = now_ms();
                    let run = BenchRun {
                        id, hw: hw.clone(), model_name: model.into(), model_digest: digest.clone(), quant: quant.clone(),
                        num_ctx: actual_ctx, kv_cache_type: "unknown".into(), flash_attn: None, ollama_version: ollama_version.clone(),
                        suite_id: SUITE_ID.into(), suite_version: SUITE_VERSION,
                        prefill_tps_median: summary.prefill_tps_median, decode_tps_median: summary.decode_tps_median,
                        load_ms, resident_bytes, repeats: repeat_count, install_id: install_id.into(),
                        rating: None, review: None, visible: true, created_at: now, updated_at: now,
                        source: BenchSource::Local, synced_at: None, match_quality: None,
                        prompt_id: Some(scenario.id.into()), prompt_version: Some(prompts::PROMPT_CATALOG_VERSION),
                        ttft_ms_median: summary.ttft_ms_median, env_start: Some(env_start), env_end: Some(env_end),
                        prev_decode_tps_median: prev_decode, prev_ollama_version: prev_version, thermal_label: Some(label), notes,
                    };
                    crate::db::upsert_bench_without_samples(&mut self.connect()?, &run)?;
                    on_progress(BenchProgress::ScenarioDone { run: Box::new(run.clone()), index, total });
                    results.push(run);
                }
            }
            Ok(())
        }.await;
        let outcome = match &collection {
            Err(crate::Error::Timeout(_)) => Outcome::TimedOut,
            Err(_) => Outcome::Failed,
            Ok(_) if results.len() != total as usize => Outcome::Cancelled,
            Ok(_) => Outcome::Completed,
        };
        self.finish_bench_session(&session.id, outcome, collection.as_ref().err().map(|e| e.to_string()).as_deref())?;
        collection?;
        on_progress(BenchProgress::Done { runs: results.clone() });
        Ok(results)
    }

    async fn benchmark_attempt<F>(
        &self, session: &BenchSession, plan_index: usize, cancel: &std::sync::atomic::AtomicBool, on_progress: &mut F,
    ) -> Result<(evidence::Attempt, evidence::AttemptMetrics)> where F: FnMut(BenchProgress) + Send {
        let plan = &session.config.attempts[plan_index];
        let mut attempt = self.begin_bench_attempt(session, plan_index)?;
        attempt.env_start = Some(capture_env(self, &plan.request.model).await);
        if session.config.calibration.is_some() {
            attempt.calibration = Some(calibration::ProbeObservation {
                residency_before: status::running(self).await.ok(), ..Default::default()
            });
        }
        attempt.wall_start_ms = now_ms();
        let mut sampler = LiveSampler::new();
        let generation = ollama::generate_recorded(&self.host, &plan.request, cancel, |_| {
            if let Some(tps) = sampler.on_token() { on_progress(BenchProgress::Sample { chunks_per_sec: tps }); }
        }, &mut attempt.events).await;
        attempt.outcome = match &generation {
            Ok(_) => Outcome::Completed,
            Err(crate::Error::Cancelled) => Outcome::Cancelled,
            Err(crate::Error::Timeout(_)) => Outcome::TimedOut,
            Err(crate::Error::Json(_)) => Outcome::Invalid,
            Err(_) => Outcome::Failed,
        };
        let mut failure = generation.err();
        let resident = status::running(self).await;
        if let Ok(resident) = &resident {
            if let Some(model) = resident.iter().find(|r| r.name == plan.request.model) {
                attempt.observed_context = model.context_length.and_then(|n| u32::try_from(n).ok());
                attempt.observed_digest = model.digest.clone();
                attempt.resident_bytes = model.size;
            }
        }
        attempt.env_end = Some(capture_env(self, &plan.request.model).await);
        if failure.is_none() {
            let context_error = match attempt.observed_context {
                None => Some("Ollama did not report the loaded context".to_string()),
                Some(ctx) if plan.request.num_ctx.is_some_and(|requested| ctx < requested) =>
                    Some(format!("requested {} context, but Ollama loaded {ctx}", plan.request.num_ctx.unwrap())),
                _ => None,
            };
            let metrics = evidence::recalculate(&attempt, session.formula_version)?;
            let identity_error = match attempt.observed_digest.as_deref() {
                None => Some("Ollama did not report the loaded digest".to_string()),
                Some(digest) if digest.trim_start_matches("sha256:") != session.config.model_digest.trim_start_matches("sha256:") =>
                    Some("loaded model digest differs from the frozen session identity".to_string()),
                _ => None,
            };
            let validation = if metrics.counters.prompt_eval_cached_count.zip(metrics.counters.prompt_eval_count).is_some_and(|(cached, total)| cached > total) {
                Some("cached token count exceeds prompt token count".to_string())
            } else if !metrics.validation_errors.is_empty() {
                Some(metrics.validation_errors.join("; "))
            } else if !plan.is_warmup && (metrics.counters.eval_count.is_none_or(|n| n == 0) || metrics.decode_tps.value.is_none()) {
                Some("benchmark generation has no valid decode measurement".to_string())
            } else { None };
            if let Some(error) = context_error.or(identity_error).or(validation) {
                attempt.outcome = Outcome::Invalid;
                failure = Some(crate::Error::Ollama(error));
            }
        }
        attempt.error = failure.as_ref().map(ToString::to_string);
        if let (Some(identity), Some(observation)) = (&session.config.calibration, &mut attempt.calibration) {
            if failure.is_none() {
                match calibration::tokenize(self, identity, &plan.request, &attempt.events).await {
                    Ok(tokens) => observation.tokens = Some(tokens),
                    Err(e) => observation.tokenizer_error = Some(e.to_string()),
                }
            }
        }
        self.finish_bench_attempt(&attempt)?;
        if let Some(error) = failure { return Err(error); }
        let metrics = evidence::recalculate(&attempt, session.formula_version)?;
        Ok((attempt, metrics))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_is_robust_to_one_outlier() {
        // The reason for median over mean: a single throttled run shouldn't
        // move the reported number.
        assert_eq!(median(vec![40.0, 41.0, 42.0]), Some(41.0));
        assert_eq!(median(vec![40.0, 41.0, 2.0]), Some(40.0));
        assert_eq!(median(vec![40.0, 42.0]), Some(41.0));
        assert_eq!(median(vec![]), None);
    }

    #[test]
    fn live_sampler_withholds_a_reading_until_the_window_and_throttle_allow_it() {
        let mut s = LiveSampler::new();
        // A single token isn't a window yet.
        assert_eq!(s.on_token(), None);
        // Immediately-following tokens are still inside the throttle floor.
        for _ in 0..5 {
            assert_eq!(s.on_token(), None);
        }
        std::thread::sleep(LIVE_SAMPLE_MIN_INTERVAL + std::time::Duration::from_millis(20));
        // Now both the window (>=2) and the throttle interval are satisfied.
        let reading = s.on_token();
        assert!(reading.is_some());
        assert!(reading.unwrap() > 0.0);
        // Right after emitting, the throttle floor withholds the very next one.
        assert_eq!(s.on_token(), None);
    }

    #[test]
    fn live_sampler_window_never_exceeds_its_cap() {
        let mut s = LiveSampler::new();
        for _ in 0..(LIVE_SAMPLE_WINDOW * 3) {
            s.on_token();
        }
        assert!(s.window.len() <= LIVE_SAMPLE_WINDOW);
    }

    /// End-to-end against a live server. Ignored by default: it needs Ollama
    /// running with `llama3.2:1b` installed, and takes several minutes.
    ///   cargo test -p anchor-hub -- --ignored --nocapture runs_the_suite
    #[tokio::test]
    #[ignore = "needs a live Ollama server with llama3.2:1b"]
    async fn runs_the_suite_end_to_end() {
        use prompts::RepeatsMode;

        let dir = std::env::temp_dir().join(format!("anchor-bench-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let registry = Registry::open(dir.join("registry.db")).unwrap();
        let hw = HwIdentity {
            hw_key: "test-mac-10c-10g-16gb".into(),
            chip_key: "test-mac".into(),
            chip: "Test Mac".into(),
            cpu_cores: Some(10),
            gpu_cores: Some(10),
            memory_gb: Some(16),
            os_version: Some("15.5".into()),
        };

        let runs = registry
            .run_benchmark(
                "llama3.2:1b",
                &hw,
                "test-install",
                RepeatsMode::Fast,
                None,
                &std::sync::atomic::AtomicBool::new(false),
                |p| println!("{p:?}"),
            )
            .await
            .expect("benchmark should complete");

        assert_eq!(runs.len(), CATALOG.len(), "one row per scenario");
        for run in &runs {
            let id = run.prompt_id.as_deref().unwrap();
            assert!(run.decode_tps_median.unwrap() > 0.0, "{id}: decode throughput measured");
            assert!(run.prefill_tps_median.unwrap() > 0.0, "{id}: prefill throughput measured");
            assert!(run.model_digest.len() > 16, "{id}: digest recorded");
            assert!(run.resident_bytes.unwrap() > 0, "{id}: resident size read while loaded");
            assert!(run.ttft_ms_median.unwrap() > 0.0, "{id}: ttft measured");
            assert!(run.env_start.is_some(), "{id}: telemetry captured at start");
            assert!(run.env_end.is_some(), "{id}: telemetry captured at end");
            assert!(run.thermal_label.is_some(), "{id}: thermal label derived");
            println!(
                "{id:<12} {:>6} ctx | decode {:>6.1} tok/s | prefill {:>6.0} tok/s | ttft {:>5.0} ms | load {:?} ms",
                run.num_ctx,
                run.decode_tps_median.unwrap(),
                run.prefill_tps_median.unwrap(),
                run.ttft_ms_median.unwrap(),
                run.load_ms,
            );
        }

        // The rows must be readable back through the tiered match query.
        let digest = &runs[0].model_digest;
        let found = registry.bench_runs_for(&hw, Some(digest), Some(SUITE_ID), None, None).unwrap();
        assert_eq!(found.len(), CATALOG.len());
        assert_eq!(found[0].match_quality, Some(anchor_core::MatchQuality::Exact));

        let samples = registry.bench_samples_for(&runs[0].id).unwrap();
        assert_eq!(samples.len(), runs[0].repeats as usize, "one sample per measured repeat");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tps_needs_both_counters_and_a_nonzero_duration() {
        assert_eq!(tps(Some(128), Some(2_000_000_000)), Some(64.0));
        assert_eq!(tps(Some(128), Some(0)), None);
        assert_eq!(tps(None, Some(2_000_000_000)), None);
        assert_eq!(tps(Some(128), None), None);
    }

    fn env_with_thermal(pct: Option<u8>) -> EnvTelemetry {
        EnvTelemetry {
            thermal_pressure_pct: pct,
            thermal_level: None,
            on_ac_power: Some(true),
            uptime_secs: Some(3600),
            free_memory_bytes: Some(1024),
            resident_model_count: Some(0),
        }
    }

    fn env_with_level(level: u8) -> EnvTelemetry {
        EnvTelemetry { thermal_level: Some(level), ..env_with_thermal(None) }
    }

    #[test]
    fn thermal_label_detects_a_throttle_drop() {
        assert_eq!(thermal_label(&env_with_thermal(Some(100)), &env_with_thermal(Some(80))), "pressure");
        assert_eq!(thermal_label(&env_with_thermal(Some(100)), &env_with_thermal(Some(95))), "pressure");
        assert_eq!(thermal_label(&env_with_thermal(None), &env_with_thermal(Some(95))), "unknown");
    }

    // Apple Silicon has no speed-limit reading, so the OS pressure level is the
    // only thing standing between every run and a permanent "unknown".
    #[test]
    fn thermal_label_prefers_the_os_pressure_level() {
        assert_eq!(thermal_label(&env_with_level(0), &env_with_level(0)), "nominal");
        assert_eq!(thermal_label(&env_with_level(0), &env_with_level(10)), "pressure");
        assert_eq!(thermal_label(&env_with_level(20), &env_with_level(0)), "pressure");

        // A level reading wins even where the Intel speed limit says otherwise.
        let mut cool_pct = env_with_thermal(Some(100));
        cool_pct.thermal_level = Some(20);
        assert_eq!(thermal_label(&cool_pct, &cool_pct), "pressure");
    }

    #[test]
    fn auto_notes_flags_throttling_and_battery() {
        let mut start = env_with_thermal(Some(100));
        assert_eq!(auto_notes("nominal", &start), None);

        start.on_ac_power = Some(false);
        assert_eq!(auto_notes("nominal", &start).as_deref(), Some("running on battery"));
        assert_eq!(
            auto_notes("pressure", &start).as_deref(),
            Some("thermal pressure observed at scenario boundaries; running on battery")
        );
    }
}
