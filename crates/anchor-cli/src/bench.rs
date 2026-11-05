//! `anchor bench` — run a suite, and read what previous runs measured.
//!
//! Rows land in the same table the desktop app's Benchmarks page reads, keyed by
//! the same install id and hardware identity, so a run here shows up there.

use anchor_core::{BenchRun, HwIdentity};
use anchor_hub::{BenchProgress, RepeatsMode};
use clap::{Subcommand, ValueEnum};

use crate::{hardware, print_json, registry, Runtime};

#[derive(Subcommand)]
pub enum Cmd {
    /// Benchmark a model on this machine.
    ///
    /// Anchor refuses competing work in its GUI/CLI. Close unrelated inference
    /// applications too: they do not participate in Anchor's work lock.
    Run {
        model: String,
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
        /// Run just this workload from bench scenarios.
        #[arg(long)]
        scenario: Option<String>,
        /// `thorough` runs every scenario three times; `fast` drops the
        /// long-generation scenarios to a single run.
        #[arg(long, value_enum, default_value_t = Repeats::Thorough)]
        repeats: Repeats,
    },
    /// Recent runs on this machine, newest first.
    Ls {
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
        /// Only this model.
        #[arg(long)]
        model: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: u32,
    },
    /// Runs from machines like this one, fastest first.
    Top {
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
        /// MLX checkpoint defining the tokenizer/template/runtime comparison group.
        #[arg(long)]
        reference: Option<String>,
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
    /// By default this
    /// picks the newest run matching the filters. `--json` on the other
    /// commands carries the full id when a script needs one.
    Samples {
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
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
    /// All execution outcomes, including failed and cancelled sessions.
    Sessions {
        #[arg(long, value_enum)]
        runtime: Option<Runtime>,
        #[arg(long, default_value_t = 20)]
        limit: u32,
    },
    /// Export reproducible evidence as JSON, including prompts and raw output.
    Export {
        /// Session id from `bench sessions`, or a successful run id.
        id: String,
        #[arg(long, required = true)]
        include_content: bool,
    },
    /// Recalculate metrics from an evidence JSON file, without a runtime or database.
    Replay { path: std::path::PathBuf },
    /// Inspect saved session details and measurement validation without new probes.
    Report { id: String },
    /// Probe the installed Ollama build and record which counters are verified.
    #[command(name = "validate", alias = "calibrate")]
    Calibrate {
        model: String,
        /// Use an isolated database here and save the full synthetic-probe evidence JSON.
        #[arg(long)]
        output: Option<std::path::PathBuf>,
    },
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
            repeats,
            runtime,
            scenario,
        } => bench(model, repeats, runtime, scenario, json).await,
        Cmd::Ls {
            model,
            limit,
            runtime,
        } => {
            if runtime == Runtime::Mlx {
                return mlx_results(model.as_deref(), None, None, None, true, limit, json);
            }
            history(model.as_deref(), limit, json).await
        }
        Cmd::Top {
            model,
            suite,
            scenario,
            ctx,
            runtime,
            reference,
        } => {
            let scenario = scenario
                .as_deref()
                .unwrap_or(anchor_hub::bench::HEADLINE_SCENARIO);
            check_scenario(Some(scenario))?;
            if runtime == Runtime::Mlx {
                if suite != anchor_hub::SUITE_ID && suite != anchor_hub::bench::mlx_suite::SUITE_ID
                {
                    return Err("suite does not match MLX".into());
                }
                if model.is_none()
                    && reference.is_none()
                    && std::env::var_os("ANCHOR_TUI_EVENTS").is_some()
                {
                    return print_json(
                        &registry()?
                            .mlx_leaderboard(&hw()?, Some(scenario))
                            .map_err(|e| e.to_string())?,
                    );
                }
                return mlx_results(
                    model.as_deref(),
                    reference.as_deref(),
                    Some(scenario),
                    ctx,
                    false,
                    u32::MAX,
                    json,
                );
            }
            if reference.is_some() {
                return Err("--reference applies to MLX rankings".into());
            }
            top(model.as_deref(), Some(&suite), Some(scenario), ctx, json).await
        }
        Cmd::Scenarios => scenarios(json),
        Cmd::Sessions { limit, runtime } => {
            let sessions = registry()?
                .bench_sessions(if runtime.is_some() { u32::MAX } else { limit })
                .map_err(|e| e.to_string())?;
            let rows: Vec<_> = sessions.iter().filter(|s| runtime.is_none_or(|r| (r == Runtime::Mlx) == s.config.protocol.starts_with("mlx_"))).take(limit as usize).map(|s| serde_json::json!({
                "id": s.id, "model": s.config.model_name, "outcome": s.outcome, "error": s.error,
                "created_at": s.created_at, "finished_at": s.finished_at,
                "planned_attempts": s.config.attempts.len(), "formula_version": s.formula_version,
                "protocol":s.config.protocol,"runtime_version":s.config.runtime_version,"suite":s.config.suite_id,
            })).collect();
            if json {
                return print_json(&rows);
            }
            for row in rows {
                println!(
                    "{}  {:<26} {}",
                    row["id"].as_str().unwrap(),
                    row["model"].as_str().unwrap(),
                    row["outcome"].as_str().unwrap()
                );
            }
            Ok(())
        }
        Cmd::Report { id } => {
            let e = registry()?.bench_evidence(&id).map_err(|e| e.to_string())?;
            let mut session = serde_json::to_value(&e.session).map_err(|e| e.to_string())?;
            // Prompt/output content remains an explicit bench export --include-content action.
            session["config"]["attempts"] = serde_json::json!(e.session.config.attempts.iter().map(|a| serde_json::json!({
                "scenario_id":a.scenario_id,"repeat_index":a.repeat_index,"is_warmup":a.is_warmup,
                "prompt_tokens_target":a.prompt_tokens_target,"num_ctx":a.request.num_ctx,"num_predict":a.request.num_predict,
                "temperature":a.request.temperature,"think":a.request.think,"keep_alive_secs":a.request.keep_alive_secs,
            })).collect::<Vec<_>>());
            print_json(&serde_json::json!({"session":session,"report":e.derived}))
        }
        Cmd::Export {
            id,
            include_content: _,
        } => print_json(&registry()?.bench_evidence(&id).map_err(|e| e.to_string())?),
        Cmd::Replay { path } => {
            let raw = std::fs::read(path).map_err(|e| e.to_string())?;
            let export: anchor_hub::bench::evidence::EvidenceExport =
                serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            print_json(&export.recalculate().map_err(|e| e.to_string())?)
        }
        Cmd::Calibrate { model, output } => {
            let cancel = crate::cancel_flag();
            let _work = registry()?.try_work_lock().map_err(|e| e.to_string())?;
            crate::prepare_server(&cancel).await?;
            let dir = match &output {
                Some(dir) => dir.clone(),
                None => crate::data_dir()?,
            };
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let registry =
                anchor_hub::Registry::open(dir.join("registry.db")).map_err(|e| e.to_string())?;
            let profile = anchor_system::Profiler::new(dir.join("hardware.json"))
                .get()
                .map_err(|e| e.to_string())?;
            let install = anchor_hub::install_id(&dir).map_err(|e| e.to_string())?;
            let export = registry
                .calibrate_ollama(
                    &model,
                    &HwIdentity::from_profile(&profile),
                    &install,
                    &cancel,
                    |p| {
                        if let BenchProgress::Status { message } = p {
                            eprintln!("{message}");
                        }
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
            if output.is_some() {
                let path = dir.join(format!("{}.json", export.session.id));
                std::fs::write(
                    &path,
                    serde_json::to_vec_pretty(&export).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                eprintln!("Evidence: {}", path.display());
            }
            if json {
                print_json(&export.derived)?;
            } else {
                println!(
                    "Session {} · {:?}",
                    export.session.id, export.session.outcome
                );
                for probe in &export.derived.calibration.as_ref().unwrap().probes {
                    println!(
                        "{}: {:?} · input {} · cache {} · finish {} · {}",
                        probe.attempt_id,
                        probe.outcome,
                        probe.input_count,
                        probe.cache,
                        probe.finish,
                        probe.stream
                    );
                }
                println!("Engine counts and phase rates are runtime-reported; see the evidence report for verified counts and timing limits.");
            }
            if export.session.outcome != anchor_hub::bench::evidence::Outcome::Completed
                || export.derived.calibration.as_ref().is_some_and(|r| {
                    r.probes
                        .iter()
                        .any(|p| p.input_count == "mismatch" || p.finish == "length_count_mismatch")
                })
            {
                return Err(format!(
                    "calibration has failures; evidence retained in {}",
                    export.session.id
                ));
            }
            Ok(())
        }
        Cmd::Samples {
            run_id,
            model,
            ctx,
            scenario,
            runtime,
        } => {
            check_scenario(scenario.as_deref())?;
            let run_id = match run_id {
                Some(id) => id,
                None if runtime == Runtime::Mlx => {
                    let runs = mlx_rows(model.as_deref(), None, scenario.as_deref(), ctx, true)?;
                    runs.first().ok_or("no matching MLX run")?.id.clone()
                }
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
            // Context-tier warmups and unsuccessful attempts live in session evidence.
            println!(
                "{:>6} {:>12} {:>12} {:>10}",
                "REPEAT", "PREFILL t/s", "DECODE t/s", "TTFT ms"
            );
            println!("Token counts and timing scopes depend on the recorded runtime/method; TTFT is client-observed.");
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
    println!(
        "{:<12} {:>8} {:>8} {:>7}  {}",
        "SCENARIO", "PROMPT", "GEN", "CTX", "USE CASE"
    );
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

fn check_scenario(scenario: Option<&str>) -> Result<(), String> {
    if scenario.is_some_and(|id| !anchor_hub::CATALOG.iter().any(|s| s.id == id)) {
        return Err("unknown scenario; see anchor bench scenarios".into());
    }
    Ok(())
}

async fn bench(
    model: String,
    repeats: Repeats,
    runtime: Runtime,
    scenario: Option<String>,
    json: bool,
) -> Result<(), String> {
    check_scenario(scenario.as_deref())?;
    let cancel = crate::cancel_flag();
    let registry = registry()?;
    let _work = registry.try_work_lock().map_err(|e| e.to_string())?;
    let hw = hw()?;
    let install_id = anchor_hub::install_id(&crate::data_dir()?).map_err(|e| e.to_string())?;
    eprintln!("Runtime {runtime:?}; repeats {}; scenario {}; timing scopes: docs/benchmark-methodology.md",
        if matches!(repeats, Repeats::Fast) { "fast" } else { "thorough" }, scenario.as_deref().unwrap_or("all nine"));
    let mut waveform = Vec::new();
    let mut display = crate::ui::Progress::default();
    let progress = move |event| {
        crate::tui_event(&event);
        match event {
            BenchProgress::Status { message } => display.line(&message),
            BenchProgress::ScenarioStarted {
                scenario_id,
                index,
                total,
                num_ctx,
            } => {
                waveform.clear();
                display.line(&format!("{index}/{total} {scenario_id} @ {num_ctx} ctx"));
            }
            BenchProgress::ScenarioDone { run, .. } => display.line(&format!(
                "completed {}",
                run.prompt_id.as_deref().unwrap_or("unknown")
            )),
            BenchProgress::Failed { message } => display.line(&message),
            BenchProgress::Run { index, total, .. } => {
                display.line(&format!("repeat {index}/{total}"))
            }
            BenchProgress::Sample { chunks_per_sec }
                if !json && std::io::IsTerminal::is_terminal(&std::io::stderr()) =>
            {
                waveform.push(chunks_per_sec);
                display.frame(&format!(
                    "{} {chunks_per_sec:.1} chunks/s",
                    crate::ui::sparkline(&waveform, 24)
                ));
            }
            _ => {}
        }
    };
    let runs = if runtime == Runtime::Mlx {
        let model = crate::models::mlx_model(&model)?;
        let root = crate::data_dir()?.join("mlx-worker");
        tokio::task::spawn_blocking(move || {
            registry.run_mlx_suite(
                &model.path,
                &root,
                &hw,
                &install_id,
                repeats.into(),
                scenario.as_deref(),
                &cancel,
                progress,
            )
        })
        .await
        .map_err(|e| e.to_string())?
    } else {
        crate::prepare_server(&cancel).await?;
        registry
            .run_benchmark(
                &model,
                &hw,
                &install_id,
                repeats.into(),
                scenario.as_deref(),
                &cancel,
                progress,
            )
            .await
    }
    .map_err(|e| e.to_string())?;
    if json {
        return print_json(&runs);
    }
    print_runs(&runs, false);
    if let Some(line) = conditions_line(&runs) {
        println!("{line}");
    }
    Ok(())
}

fn mlx_rows(
    model: Option<&str>,
    reference: Option<&str>,
    scenario: Option<&str>,
    ctx: Option<u32>,
    history: bool,
) -> Result<Vec<BenchRun>, String> {
    check_scenario(scenario)?;
    let registry = registry()?;
    // Saved checkpoint paths remain inspectable after their weights are removed.
    let path_for = |id: &str| -> Result<std::path::PathBuf, String> {
        let catalog = anchor_hub::bench::mlx_catalog::catalog().map_err(|e| e.to_string())?;
        if let Some(m) = catalog.into_iter().find(|m| m.id == id) {
            return Ok(anchor_hub::bench::mlx_catalog::checkpoint_path(&m));
        }
        let p = std::path::PathBuf::from(id);
        if let Ok(path) = p.canonicalize() {
            return Ok(path);
        }
        if p.is_absolute() {
            Ok(p)
        } else {
            Ok(std::env::current_dir().map_err(|e| e.to_string())?.join(p))
        }
    };
    let model = model.map(path_for).transpose()?;
    let reference = reference
        .map(path_for)
        .transpose()?
        .or_else(|| model.clone());
    if !history && reference.is_none() {
        return Err("MLX rankings require --reference <model-or-checkpoint> (or --model) for matching tokenizer/template/runtime settings".into());
    }
    Ok(registry
        .mlx_suite_runs(
            &hw()?,
            model.as_deref(),
            reference.as_deref(),
            scenario,
            history,
        )
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| ctx.is_none_or(|c| r.num_ctx == c))
        .collect())
}

fn mlx_results(
    model: Option<&str>,
    reference: Option<&str>,
    scenario: Option<&str>,
    ctx: Option<u32>,
    history: bool,
    limit: u32,
    json: bool,
) -> Result<(), String> {
    let rows: Vec<_> = mlx_rows(model, reference, scenario, ctx, history)?
        .into_iter()
        .take(limit as usize)
        .collect();
    if json {
        print_json(&rows)
    } else {
        print_runs(&rows, !history);
        Ok(())
    }
}

/// What the suite was measured under, in one line. `None` when the machine
/// reported no thermal state at all (pre-Apple-Silicon-fix rows, or a Mac
/// where the pressure level can't be read) — better silent than "unknown".
///
/// Worth printing even when nothing went wrong: a decode rate is only
/// comparable against another run measured under the same conditions, and the
/// reader can't tell a cool run from a hot one by the number alone.
fn conditions_line(runs: &[BenchRun]) -> Option<String> {
    let known: Vec<&BenchRun> = runs
        .iter()
        .filter(|r| r.thermal_label.as_deref() != Some("unknown"))
        .collect();
    if known.is_empty() {
        return None;
    }
    let hot = known
        .iter()
        .filter(|r| matches!(r.thermal_label.as_deref(), Some("throttled" | "pressure")))
        .count();
    let mut line = if hot > 0 {
        format!("thermal pressure observed at boundaries of {hot} of {} scenarios — expect lower numbers than a cool run", known.len())
    } else {
        "thermal nominal at scenario boundaries".to_string()
    };
    if known
        .iter()
        .any(|r| r.env_start.as_ref().and_then(|e| e.on_ac_power) == Some(false))
    {
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
    let registry = registry()?;
    let runs = registry
        .bench_history(&hw()?, None, u32::MAX)
        .map_err(|e| e.to_string())?;
    runs.into_iter()
        .find(|r| r.model_name == model)
        .map(|r| Some(r.model_digest))
        .ok_or_else(|| format!("no stored model or benchmark named {model}"))
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
    println!("PREFILL, DECODE and LOAD use the recorded runtime/method timing scopes; see the benchmark methodology.");
    // Run ids are 200-char composites — useless in a table, so the last column
    // is what actually distinguishes the rows: which machine (for a ranking) or
    // which scenario (for this machine's own history). `--json` carries the id.
    println!(
        "{:<26} {:<12} {:>7} {:>11} {:>11} {:>9} {:>9} {:>12} {}",
        "MODEL",
        "SCENARIO",
        "CTX",
        "PREFILL",
        "DECODE",
        "TTFT ms",
        "LOAD ms",
        "RESIDENT",
        if show_match { "MACHINE" } else { "SUITE" }
    );
    for r in runs {
        let tail = if show_match {
            format!("{}{}", r.hw.chip, match_suffix(r.match_quality))
        } else {
            r.suite_id.clone()
        };
        println!(
            "{:<26} {:<12} {:>7} {:>11} {:>11} {:>9} {:>9} {:>12} {}",
            r.model_name,
            r.prompt_id.as_deref().unwrap_or("—"),
            r.num_ctx,
            opt1(r.prefill_tps_median),
            opt1(r.decode_tps_median),
            opt1(r.ttft_ms_median),
            r.load_ms
                .map(|v| v.to_string())
                .unwrap_or_else(|| "—".into()),
            r.resident_bytes
                .map(crate::fmt_bytes)
                .unwrap_or_else(|| "—".into()),
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
