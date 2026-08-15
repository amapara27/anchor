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
        /// `thorough` runs every scenario three times; `fast` drops the
        /// long-generation scenarios to a single run.
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
        /// Restrict to one suite id, so numbers from a retired suite are never
        /// blended into one table. Defaults to the current suite.
        #[arg(long, default_value = anchor_hub::SUITE_ID)]
        suite: String,
        /// Rank one scenario, e.g. `reasoning`. Throughput only compares
        /// like-for-like, so a ranking across every scenario at once is noise.
        #[arg(long)]
        scenario: Option<String>,
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
        /// Restrict to one scenario, e.g. `reasoning`.
        #[arg(long)]
        scenario: Option<String>,
    },
    /// The scenarios the suite measures, and the shape of each.
    Scenarios,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Repeats {
    Thorough,
    Fast,
}

pub async fn run(cmd: Cmd, json: bool) -> Result<(), String> {
    match cmd {
        Cmd::Run { model, repeats } => bench(&model, repeats, json).await,
        Cmd::Ls { model, limit } => history(model.as_deref(), limit, json).await,
        Cmd::Top {
            model,
            suite,
            scenario,
            ctx,
        } => top(model.as_deref(), Some(&suite), scenario.as_deref(), ctx, json).await,
        Cmd::Scenarios => scenarios(json),
        Cmd::Samples {
            run_id,
            model,
            ctx,
            scenario,
        } => {
            let run_id = match run_id {
                Some(id) => id,
                None => newest_run(model.as_deref(), ctx, scenario.as_deref()).await?,
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
            // The suite's warmup is per context tier, not per scenario, so it
            // is never stored as a sample — every row here is a measured repeat.
            println!("{:>6} {:>12} {:>12} {:>10}", "REPEAT", "PREFILL t/s", "DECODE t/s", "TTFT ms");
            for s in &samples {
                println!(
                    "{:>6} {:>12} {:>12} {:>10}",
                    s.repeat_index,
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
    scenario: Option<&str>,
) -> Result<String, String> {
    let digest = digest_of(model).await?;
    let run = registry()?
        .bench_history(&hw()?, digest.as_deref(), 200)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|r| {
            ctx.is_none_or(|c| r.num_ctx == c)
                && scenario.is_none_or(|s| r.prompt_id.as_deref() == Some(s))
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

/// The catalog itself — what `--scenario` accepts, and the shape behind each
/// id. Read from the engine's own catalog rather than restated here.
fn scenarios(json: bool) -> Result<(), String> {
    if json {
        let rows: Vec<_> = anchor_hub::CATALOG
            .iter()
            .map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "label": s.label,
                    "prompt_tokens": s.prompt_tokens,
                    "gen_tokens": s.gen_tokens,
                    "num_ctx": s.num_ctx(),
                })
            })
            .collect();
        return print_json(&rows);
    }
    println!("{:<12} {:>8} {:>8} {:>7}  {}", "SCENARIO", "PROMPT", "GEN", "CTX", "USE CASE");
    for s in &anchor_hub::CATALOG {
        println!(
            "{:<12} {:>8} {:>8} {:>7}  {}",
            s.id,
            s.prompt_tokens,
            s.gen_tokens,
            s.num_ctx(),
            s.label
        );
    }
    Ok(())
}

async fn bench(model: &str, repeats: Repeats, json: bool) -> Result<(), String> {
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
        BenchProgress::ScenarioStarted {
            scenario_id,
            num_ctx,
            index,
            total,
        } => progress_line(&format!(
            "scenario {index}/{total}: {scenario_id} at {num_ctx} ctx"
        )),
        BenchProgress::ScenarioDone { run, .. } => finished.push(*run),
        BenchProgress::Done { runs } => finished = runs,
        BenchProgress::Failed { message } => eprintln!("\n{message}"),
        // Live tok/s readings drive the app's running graphic; a terminal
        // already sees the per-run lines.
        BenchProgress::Sample { .. } => {}
    };

    let result = registry
        .run_benchmark(model, &hw, &install_id, repeats.into(), on_progress)
        .await
        .map(|_| ());
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
    scenario: Option<&str>,
    ctx: Option<u32>,
    json: bool,
) -> Result<(), String> {
    let digest = digest_of(model).await?;
    let runs = registry()?
        .bench_runs_for(&hw()?, digest.as_deref(), suite, scenario, ctx)
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
    // which scenario (for this machine's own history). `--json` carries the id.
    println!(
        "{:<26} {:<12} {:>7} {:>11} {:>11} {:>9} {}",
        "MODEL",
        "SCENARIO",
        "CTX",
        "PREFILL",
        "DECODE",
        "LOAD ms",
        if show_match { "MACHINE" } else { "SUITE" }
    );
    for r in runs {
        let tail = if show_match {
            format!("{}{}", r.hw.chip, match_suffix(r.match_quality))
        } else {
            r.suite_id.clone()
        };
        println!(
            "{:<26} {:<12} {:>7} {:>11} {:>11} {:>9} {}",
            r.model_name,
            r.prompt_id.as_deref().unwrap_or("—"),
            r.num_ctx,
            opt1(r.prefill_tps_median),
            opt1(r.decode_tps_median),
            r.load_ms.map(|v| v.to_string()).unwrap_or_else(|| "—".into()),
            tail,
        );
    }
}

/// How close another machine's run is to this one, appended to its chip name.
/// An unqualified chip means the run is this machine's own.
fn match_suffix(quality: Option<anchor_core::MatchQuality>) -> &'static str {
    match quality {
        Some(anchor_core::MatchQuality::Exact) => " (exact)",
        Some(anchor_core::MatchQuality::SameChipMemory) => " (same memory)",
        Some(anchor_core::MatchQuality::SameFamily) => " (same family)",
        None => "",
    }
}

fn opt1(v: Option<f64>) -> String {
    v.map(|v| format!("{v:.1}")).unwrap_or_else(|| "—".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_core::MatchQuality;

    #[test]
    fn a_missing_measurement_renders_as_an_em_dash() {
        assert_eq!(opt1(None), "—");
        assert_eq!(opt1(Some(42.06)), "42.1", "rates are shown to one decimal");
        assert_eq!(opt1(Some(0.0)), "0.0", "zero is a real reading, not a gap");
    }

    // The chip alone means "this machine's own run". Every borrowed row has to
    // carry its distance, or a ranking would present another machine's numbers
    // as if they were yours.
    #[test]
    fn only_this_machines_own_runs_are_unqualified() {
        assert_eq!(match_suffix(None), "");
        for q in [
            MatchQuality::Exact,
            MatchQuality::SameChipMemory,
            MatchQuality::SameFamily,
        ] {
            assert!(
                match_suffix(Some(q)).starts_with(' '),
                "{q:?} must be labelled and separated from the chip name"
            );
        }
    }

    #[test]
    fn each_match_tier_is_labelled_distinctly() {
        let labels = [
            match_suffix(Some(MatchQuality::Exact)),
            match_suffix(Some(MatchQuality::SameChipMemory)),
            match_suffix(Some(MatchQuality::SameFamily)),
        ];
        let mut seen = labels.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), labels.len(), "tiers must not share a label");
    }

    // The CLI's own flag enum has to map onto the engine's mode one-for-one;
    // a wrong arm here silently changes how many repeats a benchmark runs.
    #[test]
    fn the_repeats_flag_maps_onto_the_engines_mode() {
        assert_eq!(RepeatsMode::from(Repeats::Thorough), RepeatsMode::Thorough);
        assert_eq!(RepeatsMode::from(Repeats::Fast), RepeatsMode::Fast);
    }
}
