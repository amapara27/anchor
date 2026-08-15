//! The benchmark suite: a versioned catalog of scenarios, each a (prompt
//! tokens, generation tokens) shape with a use case attached, plus the live
//! telemetry captured around each run.
//!
//! Lives in `anchor-hub` because it needs both halves this crate already
//! owns: the Ollama client that produces [`GenerationStats`], and the SQLite
//! connection the results land in.
//!
//! Timings are Ollama's own (`eval_count / eval_duration`), never wall-clock
//! measured here — the server knows when the model actually started
//! generating and we don't. The one exception is TTFT, which is a proxy
//! (`prompt_eval_duration_ns`) rather than a new stopwatch: on an
//! already-warmed model, generation begins the instant prompt eval finishes.

mod prompts;

pub use prompts::{RepeatsMode, Scenario, CATALOG, SUITE_ID, SUITE_VERSION};

use anchor_core::{BenchRun, BenchSample, BenchSource, EnvTelemetry, HwIdentity};
use serde::Serialize;

use crate::{ollama, status, GenerateRequest, GenerationStats, Registry, Result};

/// A drop of this many percentage points in thermal headroom between a run's
/// start and end snapshots labels it "throttled" rather than "sustained".
///
/// ponytail: calibration knob, not a measured constant — real Apple Silicon
/// thermal behavior varies by chassis (fanless MacBook Air vs. fan-equipped
/// Pro). Tune against real hardware if this mislabels runs in practice.
const THROTTLE_DELTA_PCT: u8 = 15;

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
    /// A live instantaneous decode-rate reading, for the running graphic.
    /// Wall-clock, from token arrival timing — not Ollama's own
    /// `eval_count/eval_duration`, which only exist once a whole call
    /// finishes. Throttled (see [`LiveSampler`]), not one per token.
    Sample { tps: f64 },
}

/// Tracks recent token-arrival timing to emit a throttled, real instantaneous
/// decode-rate sample during a measured generation — the "live run" graphic's
/// data source. Persists across an entire benchmark run (warmup through every
/// repeat/cell) so the graphic reads as one continuous feed rather than
/// resetting at each repeat boundary.
struct LiveSampler {
    window: std::collections::VecDeque<std::time::Instant>,
    last_emit: std::time::Instant,
}

/// Tokens behind each reading — small enough to react quickly, large enough
/// that one slow/fast token doesn't spike the graph.
const LIVE_SAMPLE_WINDOW: usize = 12;
/// Floor between emitted samples, so a fast model (many tokens/sec) doesn't
/// flood the Tauri channel with one message per token.
const LIVE_SAMPLE_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(90);

impl LiveSampler {
    fn new() -> Self {
        Self { window: std::collections::VecDeque::with_capacity(LIVE_SAMPLE_WINDOW), last_emit: std::time::Instant::now() }
    }

    /// Records one token's arrival; returns an instantaneous tok/s reading
    /// when the window has enough span and the throttle has elapsed.
    fn on_token(&mut self) -> Option<f64> {
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
fn tps(count: Option<u64>, duration_ns: Option<u64>) -> Option<f64> {
    match (count, duration_ns) {
        (Some(c), Some(d)) if d > 0 => Some(c as f64 / (d as f64 / 1e9)),
        _ => None,
    }
}

/// Time-to-first-token proxy, in milliseconds: on an already-warmed model,
/// generation begins the instant prompt eval finishes, so `prompt_eval_duration_ns`
/// stands in for TTFT without a new wall-clock measurement.
fn ttft_ms(stats: &GenerationStats) -> Option<f64> {
    stats.prompt_eval_duration_ns.map(|ns| ns as f64 / 1e6)
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

/// "throttled" when thermal headroom dropped by at least [`THROTTLE_DELTA_PCT`]
/// points between `start` and `end`, "sustained" when it held, "unknown" when
/// either snapshot couldn't read thermal state at all.
fn thermal_label(start: &EnvTelemetry, end: &EnvTelemetry) -> String {
    match (start.thermal_pressure_pct, end.thermal_pressure_pct) {
        (Some(s), Some(e)) if s.saturating_sub(e) >= THROTTLE_DELTA_PCT => "throttled",
        (Some(_), Some(_)) => "sustained",
        _ => "unknown",
    }
    .to_string()
}

/// Anomaly notes auto-populated from the telemetry snapshots. `None` when
/// nothing stands out, so a clean run doesn't grow a placeholder note.
fn auto_notes(label: &str, start: &EnvTelemetry) -> Option<String> {
    let mut parts = Vec::new();
    if label == "throttled" {
        parts.push("thermally throttled during run".to_string());
    }
    if start.on_ac_power == Some(false) {
        parts.push("running on battery".to_string());
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// Builds one repeat's raw sample row from its generation stats.
fn sample_from(bench_run_id: &str, repeat_index: u32, is_warmup: bool, wall_start_ms: i64, stats: &GenerationStats) -> BenchSample {
    BenchSample {
        id: format!("{bench_run_id}#{repeat_index}"),
        bench_run_id: bench_run_id.to_string(),
        repeat_index,
        is_warmup,
        prefill_tps: tps(stats.prompt_eval_count, stats.prompt_eval_duration_ns),
        decode_tps: tps(stats.eval_count, stats.eval_duration_ns),
        ttft_ms: ttft_ms(stats),
        prompt_eval_count: stats.prompt_eval_count,
        prompt_eval_duration_ns: stats.prompt_eval_duration_ns,
        eval_count: stats.eval_count,
        eval_duration_ns: stats.eval_duration_ns,
        total_duration_ns: stats.total_duration_ns,
        load_duration_ns: stats.load_duration_ns,
        wall_start_ms,
        created_at: now_ms(),
    }
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
        crate::db::bench_samples_for(&self.connect()?, bench_run_id)
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

    /// Opens one written review against the rolling weekly allowance.
    pub fn unlock_review(
        &self,
        run_id: &str,
        now_ms: i64,
        allowance: u32,
    ) -> Result<crate::db::ReviewAllowance> {
        crate::db::unlock_review(&self.connect()?, run_id, now_ms, allowance)
    }

    /// Reviews opened within the trailing seven days.
    pub fn reviews_used(&self, now_ms: i64) -> Result<u32> {
        crate::db::reviews_used(&self.connect()?, now_ms)
    }

    /// Runs the suite against `model`, storing each scenario as its own row.
    ///
    /// Scenarios are grouped by derived `num_ctx` and run in ascending order so
    /// the model reloads once per distinct context size, not once per scenario
    /// — Ollama reloads on a `num_ctx` change, not on a prompt change. Each
    /// context group gets one discarded warmup, whose `eval_duration` includes
    /// weight loading: counting it would understate throughput on exactly the
    /// machines that load slowest.
    pub async fn run_benchmark<F>(
        &self,
        model: &str,
        hw: &HwIdentity,
        install_id: &str,
        repeats: RepeatsMode,
        mut on_progress: F,
    ) -> Result<Vec<BenchRun>>
    where
        F: FnMut(BenchProgress) + Send,
    {
        let digest = ollama::digest_of(&self.host, model)
            .await?
            .ok_or_else(|| crate::Error::Ollama(format!("{model} is not installed")))?;
        let ollama_version = ollama::version(&self.host).await.ok();
        let quant = self
            .cached_models()
            .ok()
            .and_then(|ms| ms.into_iter().find(|m| m.id == model))
            .and_then(|m| m.quantization);

        let groups = prompts::grouped_by_ctx();
        let total = CATALOG.len() as u32;
        let mut index = 0u32;
        let mut results = Vec::new();
        // One sampler for the whole run (every ctx group, every scenario) so
        // the live graphic reads as one continuous feed, not a reset per row.
        let mut sampler = LiveSampler::new();

        for (num_ctx, scenarios) in groups {
            on_progress(BenchProgress::Status {
                message: format!("unloading model before {num_ctx} context"),
            });
            let _ = self.unload(model).await;

            on_progress(BenchProgress::Status {
                message: format!("warming up at {num_ctx} context"),
            });
            let warmup_predict = scenarios[0].gen_tokens.min(64) as u64;
            let warmup_request =
                GenerateRequest::for_benchmark(model, scenarios[0].text(), warmup_predict, num_ctx);
            let (_, warmup) = ollama::generate(&self.host, &warmup_request, |_tok| {
                if let Some(tps) = sampler.on_token() {
                    on_progress(BenchProgress::Sample { tps });
                }
            })
            .await?;
            // Every scenario in this group loaded under this warmup, so they
            // all report its load cost rather than leaving the column empty.
            let load_ms = warmup.load_duration_ns.map(|ns| ns / 1_000_000);

            for scenario in scenarios {
                index += 1;
                on_progress(BenchProgress::ScenarioStarted {
                    scenario_id: scenario.id.to_string(),
                    num_ctx,
                    index,
                    total,
                });

                let env_start = capture_env(self, model).await;
                let repeat_count = prompts::repeats_for(scenario, repeats);
                let request = GenerateRequest::for_benchmark(
                    model,
                    scenario.text(),
                    scenario.gen_tokens as u64,
                    num_ctx,
                );
                let id = BenchRun::derive_id(
                    install_id,
                    &hw.hw_key,
                    &digest,
                    SUITE_ID,
                    SUITE_VERSION,
                    num_ctx,
                    "f16",
                    false,
                    Some((scenario.id, prompts::PROMPT_CATALOG_VERSION)),
                );

                let mut samples = Vec::new();
                let mut decode = Vec::new();
                let mut prefill = Vec::new();
                let mut ttft = Vec::new();
                for i in 1..=repeat_count {
                    let wall_start = now_ms();
                    let (_, stats) = ollama::generate(&self.host, &request, |_tok| {
                        if let Some(tps) = sampler.on_token() {
                            on_progress(BenchProgress::Sample { tps });
                        }
                    })
                    .await?;
                    if let Some(d) = tps(stats.eval_count, stats.eval_duration_ns) {
                        decode.push(d);
                        on_progress(BenchProgress::Run { index: i, total: repeat_count, decode_tps: d });
                    }
                    if let Some(p) = tps(stats.prompt_eval_count, stats.prompt_eval_duration_ns) {
                        prefill.push(p);
                    }
                    if let Some(t) = ttft_ms(&stats) {
                        ttft.push(t);
                    }
                    samples.push(sample_from(&id, i, false, wall_start, &stats));
                }

                let env_end = capture_env(self, model).await;
                let label = thermal_label(&env_start, &env_end);
                let notes = auto_notes(&label, &env_start);
                let peak_rss_bytes = status::running(self)
                    .await
                    .ok()
                    .and_then(|rs| rs.into_iter().find(|r| r.name == model).and_then(|r| r.size));

                let now = now_ms();
                let run = BenchRun {
                    id,
                    hw: hw.clone(),
                    model_name: model.to_string(),
                    model_digest: digest.clone(),
                    quant: quant.clone(),
                    num_ctx,
                    kv_cache_type: "f16".to_string(),
                    flash_attn: false,
                    ollama_version: ollama_version.clone(),
                    suite_id: SUITE_ID.to_string(),
                    suite_version: SUITE_VERSION,
                    prefill_tps_median: median(prefill),
                    decode_tps_median: median(decode),
                    load_ms,
                    peak_rss_bytes,
                    repeats: repeat_count,
                    install_id: install_id.to_string(),
                    rating: None,
                    review: None,
                    visible: true,
                    created_at: now,
                    updated_at: now,
                    source: BenchSource::Local,
                    synced_at: None,
                    match_quality: None,
                    prompt_id: Some(scenario.id.to_string()),
                    prompt_version: Some(prompts::PROMPT_CATALOG_VERSION),
                    ttft_ms_median: median(ttft),
                    env_start: Some(env_start),
                    env_end: Some(env_end),
                    thermal_label: Some(label),
                    notes,
                };

                crate::db::upsert_bench_with_samples(&mut self.connect()?, &run, &samples)?;
                on_progress(BenchProgress::ScenarioDone {
                    run: Box::new(run.clone()),
                    index,
                    total,
                });
                results.push(run);
            }
        }

        let _ = self.unload(model).await;
        on_progress(BenchProgress::Done { runs: results.clone() });
        Ok(results)
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
            .run_benchmark("llama3.2:1b", &hw, "test-install", RepeatsMode::Fast, |p| {
                println!("{p:?}");
            })
            .await
            .expect("benchmark should complete");

        assert_eq!(runs.len(), CATALOG.len(), "one row per scenario");
        for run in &runs {
            let id = run.prompt_id.as_deref().unwrap();
            assert!(run.decode_tps_median.unwrap() > 0.0, "{id}: decode throughput measured");
            assert!(run.prefill_tps_median.unwrap() > 0.0, "{id}: prefill throughput measured");
            assert!(run.model_digest.len() > 16, "{id}: digest recorded");
            assert!(run.peak_rss_bytes.unwrap() > 0, "{id}: resident size read while loaded");
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
            on_ac_power: Some(true),
            uptime_secs: Some(3600),
            free_memory_bytes: Some(1024),
            resident_model_count: Some(0),
        }
    }

    #[test]
    fn thermal_label_detects_a_throttle_drop() {
        assert_eq!(thermal_label(&env_with_thermal(Some(100)), &env_with_thermal(Some(80))), "throttled");
        assert_eq!(thermal_label(&env_with_thermal(Some(100)), &env_with_thermal(Some(95))), "sustained");
        assert_eq!(thermal_label(&env_with_thermal(None), &env_with_thermal(Some(95))), "unknown");
    }

    #[test]
    fn auto_notes_flags_throttling_and_battery() {
        let mut start = env_with_thermal(Some(100));
        assert_eq!(auto_notes("sustained", &start), None);

        start.on_ac_power = Some(false);
        assert_eq!(auto_notes("sustained", &start).as_deref(), Some("running on battery"));
        assert_eq!(
            auto_notes("throttled", &start).as_deref(),
            Some("thermally throttled during run; running on battery")
        );
    }
}
