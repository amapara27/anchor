//! `anchor bench` — run a suite, and read what previous runs measured.
//!
//! Rows land in the same table the desktop app's Benchmarks page reads, keyed by
//! the same install id and hardware identity, so a run here shows up there.

use anchor_core::{BenchRun, HwIdentity};
use anchor_hub::{BenchProgress, RepeatsMode};
use clap::{Subcommand, ValueEnum};

use crate::{ensure_server, hardware, print_json, progress_line, registry};

#[derive(Subcommand)]
pub enum Cmd {
    /// Benchmark a model on this machine.
    ///
    /// Close other heavy work first — including the Anchor app if it is
    /// generating. The two processes don't share a lock, so a contended run
    /// measures the contention rather than the model.
    Run {
        model: String,
        /// `quick` is the single fixed-prompt suite; `full` is the versioned
        /// prompt × context-size matrix.
        #[arg(long, value_enum, default_value_t = Suite::Quick)]
        suite: Suite,
        /// Repeats tradeoff for the full suite. Ignored by `quick`.
        #[arg(long, value_enum, default_value_t = Repeats::Thorough)]
        repeats: Repeats,
    },
    /// Recent runs on this machine, newest first.
    Ls {
        /// Only this model.
        #[arg(long)]
        model: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: u32,
    },
    /// Runs from machines like this one, fastest first.
    Top {
        /// Scope to one model instead of ranking across all of them.
        #[arg(long)]
        model: Option<String>,
        /// Restrict to one suite, e.g. `anchor-std`, so two suites' numbers are
        /// never blended into one table.
        #[arg(long)]
        suite: Option<String>,
        /// Restrict to one full-suite prompt, e.g. `long_context`.
        #[arg(long)]
        prompt: Option<String>,
        /// Restrict to one context size.
        #[arg(long)]
        ctx: Option<u32>,
    },
    /// The raw per-repeat samples behind a stored run's medians.
    ///
    /// Run ids are deterministic composites (install + machine + model digest +
    /// configuration), far too long to copy off a table — so by default this
    /// picks the newest run matching the filters. `--json` on the other
    /// commands carries the full id when a script needs one.
    Samples {
        /// A full run id, instead of the filters below.
        run_id: Option<String>,
        #[arg(long)]
        model: Option<String>,
        /// Restrict to one context size.
        #[arg(long)]
        ctx: Option<u32>,
        /// Restrict to one full-suite prompt, e.g. `long_context`.
        #[arg(long)]
        prompt: Option<String>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Suite {
    Quick,
    Full,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Repeats {
    Thorough,
    Fast,
}

pub async fn run(cmd: Cmd, json: bool) -> Result<(), String> {
    match cmd {
        Cmd::Run {
            model,
            suite,
            repeats,
        } => bench(&model, suite, repeats, json).await,
        Cmd::Ls { model, limit } => history(model.as_deref(), limit, json).await,
        Cmd::Top {
            model,
            suite,
            prompt,
            ctx,
        } => top(model.as_deref(), suite.as_deref(), prompt.as_deref(), ctx, json).await,
        Cmd::Samples {
            run_id,
            model,
            ctx,
            prompt,
        } => {
            let run_id = match run_id {
                Some(id) => id,
                None => newest_run(model.as_deref(), ctx, prompt.as_deref()).await?,
            };
            let samples = registry()?
                .bench_samples_for(&run_id)
                .map_err(|e| e.to_string())?;
            if json {
                return print_json(&samples);
            }
            if samples.is_empty() {
                return Err(format!("no samples for {run_id}"));
            }
            println!("{:>6} {:>8} {:>12} {:>12} {:>10}", "REPEAT", "WARMUP", "PREFILL t/s", "DECODE t/s", "TTFT ms");
            for s in &samples {
                println!(
                    "{:>6} {:>8} {:>12} {:>12} {:>10}",
                    s.repeat_index,
                    if s.is_warmup { "yes" } else { "" },
                    opt1(s.prefill_tps),
                    opt1(s.decode_tps),
                    opt1(s.ttft_ms),
                );
            }
            Ok(())
        }
    }
}

fn hw() -> Result<HwIdentity, String> {
    Ok(HwIdentity::from_profile(&hardware()?))
}

/// The newest run on this machine matching the filters — how `bench samples`
/// identifies a run without making anyone copy a composite id.
async fn newest_run(
    model: Option<&str>,
    ctx: Option<u32>,
    prompt: Option<&str>,
) -> Result<String, String> {
    let digest = digest_of(model).await?;
    let run = registry()?
        .bench_history(&hw()?, digest.as_deref(), 200)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|r| {
            ctx.is_none_or(|c| r.num_ctx == c)
                && prompt.is_none_or(|p| r.prompt_id.as_deref() == Some(p))
        })
        .ok_or("no matching benchmark run — see `anchor bench ls`")?;
    eprintln!(
        "{} · {} ctx{} · {}",
        run.model_name,
        run.num_ctx,
        run.prompt_id
            .as_deref()
            .map(|p| format!(" · {p}"))
            .unwrap_or_default(),
        run.suite_id,
    );
    Ok(run.id)
}

async fn bench(model: &str, suite: Suite, repeats: Repeats, json: bool) -> Result<(), String> {
    ensure_server().await?;
    let registry = registry()?;
    let hw = hw()?;
    let install_id = anchor_hub::install_id(&crate::data_dir()?).map_err(|e| e.to_string())?;
    let mut finished: Vec<BenchRun> = Vec::new();

    let on_progress = |event: BenchProgress| match event {
        BenchProgress::Status { message } => progress_line(&message),
        BenchProgress::Run {
            index,
            total,
            decode_tps,
        } => progress_line(&format!("run {index} of {total}: {decode_tps:.1} tok/s")),
        BenchProgress::CellStarted {
            prompt_id,
            num_ctx,
            cell_index,
            cell_total,
        } => progress_line(&format!(
            "cell {cell_index}/{cell_total}: {prompt_id} at {num_ctx} ctx"
        )),
        BenchProgress::CellDone { run, .. } => finished.push(*run),
        BenchProgress::Done { run } => finished.push(*run),
        BenchProgress::FullDone { runs } => finished = runs,
        BenchProgress::Failed { message } => eprintln!("\n{message}"),
        // Live tok/s readings drive the app's running graphic; a terminal
        // already sees the per-run lines.
        BenchProgress::Sample { .. } => {}
    };

    let result = match suite {
        Suite::Quick => registry
            .run_benchmark(model, &hw, &install_id, on_progress)
            .await
            .map(|_| ()),
        Suite::Full => registry
            .run_full_benchmark(model, &hw, &install_id, repeats.into(), on_progress)
            .await
            .map(|_| ()),
    };
    crate::progress_done();
    result.map_err(|e| e.to_string())?;

    if json {
        return print_json(&finished);
    }
    print_runs(&finished, false);
    Ok(())
}

impl From<Repeats> for RepeatsMode {
    fn from(r: Repeats) -> Self {
        match r {
            Repeats::Thorough => RepeatsMode::Thorough,
            Repeats::Fast => RepeatsMode::Fast,
        }
    }
}

/// A model's content digest — the real identity behind a re-pointable tag, and
/// what benchmark rows are keyed on.
async fn digest_of(model: Option<&str>) -> Result<Option<String>, String> {
    let Some(model) = model else { return Ok(None) };
    ensure_server().await?;
    anchor_hub::ollama::digest_of(&anchor_hub::ollama_host(), model)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{model} is not installed"))
        .map(Some)
}

async fn history(model: Option<&str>, limit: u32, json: bool) -> Result<(), String> {
    let digest = digest_of(model).await?;
    let runs = registry()?
        .bench_history(&hw()?, digest.as_deref(), limit)
        .map_err(|e| e.to_string())?;
    if json {
        return print_json(&runs);
    }
    print_runs(&runs, false);
    Ok(())
}

async fn top(
    model: Option<&str>,
    suite: Option<&str>,
    prompt: Option<&str>,
    ctx: Option<u32>,
    json: bool,
) -> Result<(), String> {
    let digest = digest_of(model).await?;
    let runs = registry()?
        .bench_runs_for(&hw()?, digest.as_deref(), suite, prompt, ctx)
        .map_err(|e| e.to_string())?;
    if json {
        return print_json(&runs);
    }
    print_runs(&runs, true);
    Ok(())
}

fn print_runs(runs: &[BenchRun], show_match: bool) {
    if runs.is_empty() {
        println!("no benchmark runs yet — try `anchor bench run <model>`");
        return;
    }
    // Run ids are 200-char composites — useless in a table, so the last column
    // is what actually distinguishes the rows: which machine (for a ranking) or
    // which prompt (for this machine's own history). `--json` carries the id.
    println!(
        "{:<26} {:>7} {:>11} {:>11} {:>9} {:<12} {}",
        "MODEL",
        "CTX",
        "PREFILL",
        "DECODE",
        "LOAD ms",
        "SUITE",
        if show_match { "MACHINE" } else { "PROMPT" }
    );
    for r in runs {
        let tail = if show_match {
            match r.match_quality {
                Some(anchor_core::MatchQuality::Exact) => format!("{} (exact)", r.hw.chip),
                Some(anchor_core::MatchQuality::SameChipMemory) => {
                    format!("{} (same memory)", r.hw.chip)
                }
                Some(anchor_core::MatchQuality::SameFamily) => {
                    format!("{} (same family)", r.hw.chip)
                }
                None => r.hw.chip.clone(),
            }
        } else {
            r.prompt_id.clone().unwrap_or_else(|| "—".into())
        };
        println!(
            "{:<26} {:>7} {:>11} {:>11} {:>9} {:<12} {}",
            r.model_name,
            r.num_ctx,
            opt1(r.prefill_tps_median),
            opt1(r.decode_tps_median),
            r.load_ms.map(|v| v.to_string()).unwrap_or_else(|| "—".into()),
            r.suite_id,
            tail,
        );
    }
}

fn opt1(v: Option<f64>) -> String {
    v.map(|v| format!("{v:.1}")).unwrap_or_else(|| "—".into())
}
