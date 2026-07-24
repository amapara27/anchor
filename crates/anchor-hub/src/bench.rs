//! The standard benchmark suite.
//!
//! Runs a fixed prompt against a model N times and records what Ollama reports,
//! so that two people's numbers mean the same thing. Lives in `anchor-hub`
//! because it needs both halves this crate already owns: the Ollama client that
//! produces [`GenerationStats`], and the SQLite connection the results land in.
//!
//! Timings are Ollama's own (`eval_count / eval_duration`), never wall-clock
//! measured here — the server knows when the model actually started generating
//! and we don't.

use anchor_core::{BenchRun, BenchSource, HwIdentity};
use serde::Serialize;

use crate::{ollama, status, GenerateRequest, Registry, Result};

/// Identifies the suite, so a result carries what produced it.
///
/// **Bump `SUITE_VERSION` whenever the prompt, token count, or context changes.**
/// Results are keyed on it, so old numbers stay in place as their own rows
/// rather than being silently compared against new ones.
pub const SUITE_ID: &str = "anchor-std";
pub const SUITE_VERSION: u32 = 1;

/// Fixed prompt. Deliberately mundane and self-contained: no retrieval, no
/// reasoning cliff, nothing that would make one model's answer far longer than
/// another's before `num_predict` caps it.
const SUITE_PROMPT: &str =
    "Write a short paragraph explaining what a hash table is and when you would use one.";

/// Tokens to generate per measured run. Long enough that the per-token rate
/// settles, short enough that a full benchmark stays under a minute.
const SUITE_NUM_PREDICT: u64 = 128;

/// Context to load with. Pinned because throughput depends on it.
const SUITE_NUM_CTX: u32 = 4096;

/// Measured runs behind the reported medians, after a discarded warmup.
const SUITE_REPEATS: u32 = 3;

/// Progress from a benchmark run, streamed to the UI over a Tauri channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BenchProgress {
    /// A human-readable phase, e.g. "warming up", "run 2 of 3".
    Status { message: String },
    /// One measured run finished.
    Run { index: u32, total: u32, decode_tps: f64 },
    /// The whole suite finished; the row is already stored.
    Done { run: Box<BenchRun> },
    /// The suite failed partway.
    Failed { message: String },
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

impl Registry {
    /// Benchmark results for a model from machines resembling `hw`, best match
    /// first, each tagged with the tier it matched at.
    pub fn bench_runs_for(&self, hw: &HwIdentity, model_digest: &str) -> Result<Vec<BenchRun>> {
        crate::db::bench_runs_for(&self.connect()?, hw, model_digest)
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

    /// Runs the standard suite against `model` and stores the result.
    ///
    /// Sequence: evict the model, one warmup run (which absorbs the load cost
    /// and is discarded), then [`SUITE_REPEATS`] measured runs. The warmup is
    /// not optional — its `eval_duration` includes weight loading, so counting
    /// it would understate throughput on exactly the machines that load slowest.
    pub async fn run_benchmark<F>(
        &self,
        model: &str,
        hw: &HwIdentity,
        install_id: &str,
        mut on_progress: F,
    ) -> Result<BenchRun>
    where
        F: FnMut(BenchProgress) + Send,
    {
        let digest = ollama::digest_of(&self.host, model)
            .await?
            .ok_or_else(|| crate::Error::Ollama(format!("{model} is not installed")))?;
        let ollama_version = ollama::version(&self.host).await.ok();

        // Cold start: the load time we report should be a real one.
        on_progress(BenchProgress::Status {
            message: "unloading model".into(),
        });
        let _ = self.unload(model).await;

        let request =
            GenerateRequest::for_benchmark(model, SUITE_PROMPT, SUITE_NUM_PREDICT, SUITE_NUM_CTX);

        on_progress(BenchProgress::Status {
            message: "warming up".into(),
        });
        let (_, warmup) = ollama::generate(&self.host, &request, |_| {}).await?;
        let load_ms = warmup.load_duration_ns.map(|ns| ns / 1_000_000);

        let mut decode = Vec::new();
        let mut prefill = Vec::new();
        for i in 1..=SUITE_REPEATS {
            on_progress(BenchProgress::Status {
                message: format!("run {i} of {SUITE_REPEATS}"),
            });
            let (_, stats) = ollama::generate(&self.host, &request, |_| {}).await?;
            if let Some(d) = tps(stats.eval_count, stats.eval_duration_ns) {
                decode.push(d);
                on_progress(BenchProgress::Run {
                    index: i,
                    total: SUITE_REPEATS,
                    decode_tps: d,
                });
            }
            if let Some(p) = tps(stats.prompt_eval_count, stats.prompt_eval_duration_ns) {
                prefill.push(p);
            }
        }

        // Read the resident size while the model is still loaded — `for_benchmark`
        // holds keep_alive open precisely so this can happen.
        let peak_rss_bytes = status::running(self)
            .await
            .ok()
            .and_then(|rs| rs.into_iter().find(|r| r.name == model).and_then(|r| r.size));

        let now = now_ms();
        let run = BenchRun {
            id: BenchRun::derive_id(
                install_id,
                &hw.hw_key,
                &digest,
                SUITE_ID,
                SUITE_VERSION,
                SUITE_NUM_CTX,
                "f16",
                false,
            ),
            hw: hw.clone(),
            model_name: model.to_string(),
            model_digest: digest,
            quant: self
                .cached_models()
                .ok()
                .and_then(|ms| ms.into_iter().find(|m| m.id == model))
                .and_then(|m| m.quantization),
            num_ctx: SUITE_NUM_CTX,
            // ponytail: Ollama's defaults. Read them back from the server once
            // it exposes the loaded cache type and flash-attention state.
            kv_cache_type: "f16".to_string(),
            flash_attn: false,
            ollama_version,
            suite_id: SUITE_ID.to_string(),
            suite_version: SUITE_VERSION,
            prefill_tps_median: median(prefill),
            decode_tps_median: median(decode),
            load_ms,
            peak_rss_bytes,
            repeats: SUITE_REPEATS,
            install_id: install_id.to_string(),
            rating: None,
            review: None,
            visible: true,
            created_at: now,
            updated_at: now,
            source: BenchSource::Local,
            synced_at: None,
            match_quality: None,
        };

        crate::db::upsert_bench(&self.connect()?, &run)?;
        let _ = self.unload(model).await;
        on_progress(BenchProgress::Done {
            run: Box::new(run.clone()),
        });
        Ok(run)
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

    /// End-to-end against a live server. Ignored by default: it needs Ollama
    /// running with `llama3.2:1b` installed, and takes ~30s.
    ///   cargo test -p anchor-hub -- --ignored --nocapture runs_the_suite
    #[tokio::test]
    #[ignore = "needs a live Ollama server with llama3.2:1b"]
    async fn runs_the_suite_end_to_end() {
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

        let run = registry
            .run_benchmark("llama3.2:1b", &hw, "test-install", |p| {
                println!("{p:?}");
            })
            .await
            .expect("benchmark should complete");

        assert!(run.decode_tps_median.unwrap() > 0.0, "decode throughput measured");
        assert!(run.prefill_tps_median.unwrap() > 0.0, "prefill throughput measured");
        assert_eq!(run.repeats, SUITE_REPEATS);
        assert!(run.model_digest.len() > 16, "digest recorded");
        assert!(run.peak_rss_bytes.unwrap() > 0, "resident size read while loaded");
        println!(
            "\ndecode {:.1} tok/s | prefill {:.0} tok/s | load {:?} ms | peak {:.2} GiB",
            run.decode_tps_median.unwrap(),
            run.prefill_tps_median.unwrap(),
            run.load_ms,
            run.peak_rss_bytes.unwrap() as f64 / 1024_f64.powi(3),
        );

        // The row must be readable back through the tiered match query.
        let found = registry.bench_runs_for(&hw, &run.model_digest).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].match_quality, Some(anchor_core::MatchQuality::Exact));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tps_needs_both_counters_and_a_nonzero_duration() {
        assert_eq!(tps(Some(128), Some(2_000_000_000)), Some(64.0));
        assert_eq!(tps(Some(128), Some(0)), None);
        assert_eq!(tps(None, Some(2_000_000_000)), None);
        assert_eq!(tps(Some(128), None), None);
    }
}
