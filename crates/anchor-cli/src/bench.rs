//! `anchor bench` — run a suite, and read what previous runs measured.
//!
//! Rows land in the same table the desktop app's Benchmarks page reads, keyed by
//! the same install id and hardware identity, so a run here shows up there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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

/// Sparkline cells in the live line. Sized so the whole status line — scenario
/// counter, waveform, rate — stays inside the 78 columns `progress_line` pads to.
const WAVEFORM_WIDTH: usize = 24;

/// Turns Ctrl-C into the suite's Stop button rather than a kill.
///
/// A killed `anchor bench` strands the weights in Ollama — the process dies
/// before the run can unload them, and the next thing to need that RAM finds it
/// taken. Stopping cleanly keeps the scenarios already measured, discards the
/// interrupted one, and still unloads. A second Ctrl-C exits immediately, since
/// installing a handler otherwise takes the escape hatch away.
fn watch_for_interrupt() -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    tokio::spawn(async move {
        while tokio::signal::ctrl_c().await.is_ok() {
            if flag.swap(true, Ordering::Relaxed) {
                std::process::exit(130);
            }
            crate::progress_done();
            eprintln!("stopping after this scenario — Ctrl-C again to quit now");
        }
    });
    cancel
}

async fn bench(model: &str, repeats: Repeats, json: bool) -> Result<(), String> {
    ensure_server().await?;
    let registry = registry()?;
    let hw = hw()?;
    let install_id = anchor_hub::install_id(&crate::data_dir()?).map_err(|e| e.to_string())?;
    let mut finished: Vec<BenchRun> = Vec::new();
    let cancel = watch_for_interrupt();

    // A suite is minutes of near-silence between finished runs, so the live
    // decode-rate samples the engine already emits (the app's waveform) are what
    // the terminal shows too: same data, drawn in blocks instead of bars. On a
    // redirected stdout none of this is drawn — see the `is_terminal` gates.
    let animated = crate::is_terminal();
    let mut waveform: Vec<f64> = Vec::new();
    // The scenario being measured, kept so a sample can redraw the whole line.
    let mut current = String::new();

    let mut on_progress = |event: BenchProgress| match event {
        BenchProgress::Status { message } => {
            current = message.clone();
            waveform.clear();
            progress_line(&format!("{} {message}", crate::ui::spinner()));
        }
        BenchProgress::Run {
            index,
            total,
            decode_tps,
        } => progress_line(&format!("  {current} · run {index}/{total} · {decode_tps:.1} tok/s")),
        BenchProgress::ScenarioStarted {
            scenario_id,
            num_ctx,
            index,
            total,
        } => {
            current = format!("{index}/{total} {scenario_id} @ {num_ctx} ctx");
            waveform.clear();
            progress_line(&format!("{} {current}", crate::ui::spinner()));
        }
        BenchProgress::ScenarioDone { run, index, total } => {
            let rate = run
                .decode_tps_median
                .map(|v| format!("{v:.1} tok/s"))
                .unwrap_or_else(|| "no reading".into());
            // Committed with a newline: finished scenarios scroll up as a log
            // while the animated line keeps redrawing beneath them.
            crate::progress_done();
            println!(
                "  ✓ {:<10} {:>7} ctx  {:>12}",
                run.prompt_id.as_deref().unwrap_or("—"),
                run.num_ctx,
                rate,
            );
            let _ = (index, total);
            finished.push(*run);
        }
        BenchProgress::Done { runs } => finished = runs,
        BenchProgress::Failed { message } => eprintln!("\n{message}"),
        BenchProgress::Sample { tps } => {
            if !animated {
                return;
            }
            waveform.push(tps);
            progress_line(&format!(
                "{} {current}  {}  {tps:>6.1} tok/s",
                crate::ui::spinner(),
                crate::ui::sparkline(&waveform, WAVEFORM_WIDTH),
            ));
        }
    };

    let result = registry
        .run_benchmark(model, &hw, &install_id, repeats.into(), &cancel, &mut on_progress)
        .await
        .map(|_| ());
    crate::progress_done();
    result.map_err(|e| e.to_string())?;

    if json {
        return print_json(&finished);
    }
    println!();
    if cancel.load(Ordering::Relaxed) {
        println!(
            "stopped early — {} of {} scenarios measured\n",
            finished.len(),
            anchor_hub::CATALOG.len()
        );
    }
    print_runs(&finished, false);
    if let Some(line) = conditions_line(&finished) {
        println!("\n{line}");
    }
    Ok(())
}

/// What the suite was measured under, in one line. `None` when the machine
/// reported no thermal state at all (pre-Apple-Silicon-fix rows, or a Mac
/// where the pressure level can't be read) — better silent than "unknown".
///
/// Worth printing even when nothing went wrong: a decode rate is only
/// comparable against another run measured under the same conditions, and the
/// reader can't tell a cool run from a hot one by the number alone.
fn conditions_line(runs: &[BenchRun]) -> Option<String> {
    let known: Vec<&BenchRun> = runs.iter().filter(|r| r.thermal_label.as_deref() != Some("unknown")).collect();
    if known.is_empty() {
        return None;
    }
    let hot = known.iter().filter(|r| r.thermal_label.as_deref() == Some("throttled")).count();
    let mut line = if hot > 0 {
        format!("thermal pressure during {hot} of {} scenarios — expect lower numbers than a cool run", known.len())
    } else {
        "thermal nominal throughout".to_string()
    };
    if known.iter().any(|r| r.env_start.as_ref().and_then(|e| e.on_ac_power) == Some(false)) {
        line.push_str("; ran on battery");
    }
    Some(line)
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

    fn run_with(thermal: Option<&str>, on_ac: bool) -> BenchRun {
        let mut r = BenchRun {
            id: "r".into(),
            hw: anchor_core::HwIdentity {
                hw_key: "hw".into(),
                chip_key: "chip".into(),
                chip: "Apple M4".into(),
                cpu_cores: None,
                gpu_cores: None,
                memory_gb: None,
                os_version: None,
            },
            model_name: "m".into(),
            model_digest: "d".into(),
            quant: None,
            num_ctx: 2048,
            kv_cache_type: "f16".into(),
            flash_attn: false,
            ollama_version: None,
            suite_id: "anchor-scenarios".into(),
            suite_version: 2,
            prefill_tps_median: None,
            decode_tps_median: None,
            load_ms: None,
            peak_rss_bytes: None,
            repeats: 1,
            install_id: "i".into(),
            rating: None,
            review: None,
            visible: true,
            created_at: 0,
            updated_at: 0,
            source: anchor_core::BenchSource::Local,
            synced_at: None,
            match_quality: None,
            prompt_id: None,
            prompt_version: None,
            ttft_ms_median: None,
            env_start: None,
            env_end: None,
            thermal_label: thermal.map(str::to_string),
            notes: None,
        };
        r.env_start = Some(anchor_core::EnvTelemetry {
            thermal_pressure_pct: None,
            thermal_level: Some(0),
            on_ac_power: Some(on_ac),
            uptime_secs: None,
            free_memory_bytes: None,
            resident_model_count: None,
        });
        r
    }

    // A rate is only comparable against a run measured under the same
    // conditions, so a clean suite has to say so rather than staying silent.
    #[test]
    fn the_conditions_line_reports_a_clean_run_and_a_hot_one() {
        assert_eq!(conditions_line(&[]), None);
        assert_eq!(
            conditions_line(&[run_with(Some("unknown"), true)]),
            None,
            "no readable thermal state says nothing at all"
        );
        assert_eq!(
            conditions_line(&[run_with(Some("sustained"), true)]).as_deref(),
            Some("thermal nominal throughout")
        );
        let hot = conditions_line(&[run_with(Some("throttled"), false), run_with(Some("sustained"), false)]).unwrap();
        assert!(hot.starts_with("thermal pressure during 1 of 2 scenarios"), "{hot}");
        assert!(hot.ends_with("ran on battery"), "{hot}");
    }
}
