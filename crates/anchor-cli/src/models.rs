//! The models hub: what's installed, what's browsable, and
//! side-by-side comparison. Mirrors the `Models` section of the desktop app.

use anchor_core::Model;
use anchor_hub::{CompareEvent, Phase, Slot};
use clap::Subcommand;

use crate::Runtime;
use crate::{
    confirm, ensure_server, fmt_bytes, print_json, progress_done, progress_line, registry,
};

/// How long the scraped Ollama library listing stays good. Models are published
/// on a scale of days, and the page is ~700 KB — a day-old list is fine.
const LIBRARY_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Subcommand)]
pub enum Cmd {
    /// List installed models.
    Ls {
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
    },
    /// Curated supported models and runtime counterparts.
    Catalog {
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
    },
    /// Everything known about one model, including its memory breakdown.
    Info {
        id: String,
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
    },
    /// Download an Ollama model or a pinned supported MLX checkpoint.
    Pull {
        id: String,
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
    },
    /// Remove an installed model.
    Rm {
        id: String,
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Models Ollama currently has resident in memory.
    Ps,
    /// Evict a model's weights from memory.
    Unload { model: String },
    /// Every model published on ollama.com.
    Browse {
        #[arg(long, value_enum, default_value_t = Runtime::Ollama)]
        runtime: Runtime,
        /// Re-scrape instead of using the cached listing.
        #[arg(long)]
        refresh: bool,
        /// Only show models whose name contains this.
        #[arg(long)]
        filter: Option<String>,
    },
    /// Every pullable tag of one library model.
    Tags { name: String },
    /// Run one prompt through two models, one after the other.
    Compare {
        model_a: String,
        model_b: String,
        #[arg(conflicts_with_all = ["file", "stdin"])]
        prompt: Option<String>,
        #[arg(long, conflicts_with = "stdin")]
        file: Option<std::path::PathBuf>,
        #[arg(long)]
        stdin: bool,
    },
}

pub async fn run(cmd: Cmd, json: bool) -> Result<(), String> {
    match cmd {
        Cmd::Ls {
            runtime: Runtime::Ollama,
        } => ls(json).await,
        Cmd::Ls {
            runtime: Runtime::Mlx,
        } => {
            let models = anchor_hub::bench::mlx::cached_models();
            if json {
                return print_json(&models);
            }
            for m in models {
                println!("{}  {}", m.name, m.path.display());
            }
            Ok(())
        }
        Cmd::Catalog { runtime } => catalog(runtime, None, json),
        Cmd::Info {
            id,
            runtime: Runtime::Ollama,
        } => info(&id, json).await,
        Cmd::Info {
            id,
            runtime: Runtime::Mlx,
        } => {
            let m = mlx_model(&id)?;
            if json {
                print_json(&m)
            } else {
                println!("{}  {}", m.name, m.path.display());
                Ok(())
            }
        }
        Cmd::Pull {
            id,
            runtime: Runtime::Ollama,
        } => pull(&id, json).await,
        Cmd::Pull {
            id,
            runtime: Runtime::Mlx,
        } => {
            let cancel = crate::cancel_flag();
            let root = crate::data_dir()?.join("mlx-worker");
            let model = tokio::task::spawn_blocking(move || {
                anchor_hub::bench::mlx_catalog::download(&id, &root, &cancel, |p| {
                    if json {
                        eprintln!(
                            "{}",
                            serde_json::to_string(&p).expect("download progress is serializable")
                        );
                    } else {
                        eprintln!(
                            "{}  {} / {}",
                            p.status,
                            fmt_bytes(p.completed),
                            fmt_bytes(p.total)
                        );
                    }
                })
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
            if json {
                print_json(&model)
            } else {
                println!("ready {}  {}", model.name, model.path.display());
                Ok(())
            }
        }
        Cmd::Rm { id, yes } => {
            // Asked before `ensure_server`, so declining never leaves a daemon
            // running that was started only to delete something.
            if !yes && !confirm(&format!("delete {id}? this removes it from Ollama"))? {
                return crate::mutation(json, "declined", Some(&id));
            }
            let registry = registry()?;
            let _work = registry.try_work_lock().map_err(|e| e.to_string())?;
            ensure_server().await?;
            registry.remove(&id).await.map_err(|e| e.to_string())?;
            crate::mutation(json, "removed", Some(&id))
        }
        Cmd::Ps => ps(json).await,
        Cmd::Unload { model } => {
            let registry = registry()?;
            let _work = registry.try_work_lock().map_err(|e| e.to_string())?;
            registry.unload(&model).await.map_err(|e| e.to_string())?;
            crate::mutation(json, "unloaded", Some(&model))
        }
        Cmd::Browse {
            runtime: Runtime::Ollama,
            refresh,
            filter,
        } => browse(refresh, filter.as_deref(), json).await,
        Cmd::Browse {
            runtime: Runtime::Mlx,
            filter,
            ..
        } => catalog(Runtime::Mlx, filter.as_deref(), json),
        Cmd::Tags { name } => tags(&name, json).await,
        Cmd::Compare {
            model_a,
            model_b,
            prompt,
            file,
            stdin,
        } => {
            compare(
                &model_a,
                &model_b,
                &crate::prompt_input(prompt, file, stdin)?,
                json,
            )
            .await
        }
    }
}

/// Installed models, syncing from Ollama and falling back to the last-synced
/// cache when it's unreachable — the same contract as the app's `list_models`.
pub async fn installed() -> Result<Vec<Model>, String> {
    let registry = registry()?;
    match registry.sync().await {
        Ok(models) => Ok(models),
        // A down server serves the cache — but an empty cache would hide the
        // failure behind an empty list, so surface the original error instead.
        Err(sync_err) => match registry.cached_models() {
            Ok(cached) if !cached.is_empty() => Ok(cached),
            Ok(_) => Err(sync_err.to_string()),
            Err(db_err) => Err(format!("{sync_err}; cache unavailable: {db_err}")),
        },
    }
}

async fn ls(json: bool) -> Result<(), String> {
    let models = installed().await?;
    if json {
        return print_json(&models);
    }
    if models.is_empty() {
        println!("no models installed — try `anchor models browse`");
        return Ok(());
    }
    println!(
        "{:<34} {:>10} {:>9} {:>10} {:>10}",
        "MODEL", "PARAMS", "QUANT", "SIZE", "CONTEXT"
    );
    for m in &models {
        println!(
            "{:<34} {:>10} {:>9} {:>10} {:>10}",
            m.id,
            m.parameter_size.as_deref().unwrap_or("—"),
            m.quantization.as_deref().unwrap_or("—"),
            m.size_bytes.map(fmt_bytes).unwrap_or_else(|| "—".into()),
            m.context_tokens
                .map(|c| c.to_string())
                .unwrap_or_else(|| "—".into()),
        );
    }
    Ok(())
}

async fn info(id: &str, json: bool) -> Result<(), String> {
    let models = installed().await?;
    let model = models
        .iter()
        .find(|m| m.id == id || m.name == id)
        .ok_or_else(|| format!("{id} is not installed (see `anchor models ls`)"))?;
    if json {
        return print_json(model);
    }
    println!("{}", model.id);
    println!("  family     {}", model.family);
    println!(
        "  publisher  {}",
        model.publisher.as_deref().unwrap_or("unknown")
    );
    println!(
        "  params     {}",
        model.parameter_size.as_deref().unwrap_or("—")
    );
    println!(
        "  quant      {}",
        model.quantization.as_deref().unwrap_or("—")
    );
    println!(
        "  size       {}",
        model
            .size_bytes
            .map(fmt_bytes)
            .unwrap_or_else(|| "—".into())
    );
    println!(
        "  context    {}",
        model
            .context_tokens
            .map(|c| c.to_string())
            .unwrap_or_else(|| "—".into())
    );
    if let Some(modified) = &model.modified_at {
        println!("  modified   {modified}");
    }
    println!();
    crate::fit::print_breakdown(model)
}

async fn pull(id: &str, json: bool) -> Result<(), String> {
    let cancel = crate::cancel_flag();
    crate::prepare_server(&cancel).await?;
    registry()?
        .pull(id, &cancel, |p| {
            if json {
                eprintln!(
                    "{}",
                    serde_json::to_string(&p).expect("pull progress is serializable")
                );
                return;
            }
            // A determinate bar once Ollama reports byte counts; before that
            // (manifest fetch, digest verification) it reports a status string
            // and nothing to measure, so a spinner carries it instead.
            match (p.completed, p.total) {
                (Some(done), Some(total)) if total > 0 => {
                    let fraction = done as f64 / total as f64;
                    progress_line(&format!(
                        "{} {:>5.1}%  {}  {} / {}",
                        crate::ui::bar(fraction, 24),
                        100.0 * fraction,
                        p.status,
                        fmt_bytes(done),
                        fmt_bytes(total),
                    ));
                }
                _ => progress_line(&format!("{} {}", crate::ui::spinner(), p.status)),
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    if !json {
        progress_done();
    }
    crate::mutation(json, "pulled", Some(id))
}

async fn ps(json: bool) -> Result<(), String> {
    // Deliberately no `ensure_server`: a down server has nothing resident,
    // which is exactly an empty list.
    let running = anchor_hub::status::running(&registry()?)
        .await
        .map_err(|e| e.to_string())?;
    if json {
        return print_json(&running);
    }
    if running.is_empty() {
        println!("nothing loaded");
        return Ok(());
    }
    println!("{:<34} {:>10} {:>10}", "MODEL", "RESIDENT", "CONTEXT");
    for m in &running {
        println!(
            "{:<34} {:>10} {:>10}",
            m.name,
            m.size.map(fmt_bytes).unwrap_or_else(|| "—".into()),
            m.context_length
                .map(|c| c.to_string())
                .unwrap_or_else(|| "—".into())
        );
    }
    Ok(())
}

async fn browse(refresh: bool, filter: Option<&str>, json: bool) -> Result<(), String> {
    // No server needed: this is about what *could* be installed.
    let max_age = if refresh { 0 } else { LIBRARY_MAX_AGE_MS };
    let entries = registry()?
        .library(max_age, crate::now_ms())
        .await
        .map_err(|e| e.to_string())?;
    let needle = filter.map(str::to_lowercase);
    let entries: Vec<_> = entries
        .into_iter()
        .filter(|e| {
            needle
                .as_ref()
                .is_none_or(|n| e.name.to_lowercase().contains(n))
        })
        .collect();
    if json {
        return print_json(&entries);
    }
    println!(
        "{:<26} {:>9} {:>6} {:<28} {}",
        "MODEL", "PULLS", "TAGS", "SIZES", "UPDATED"
    );
    for e in &entries {
        println!(
            "{:<26} {:>9} {:>6} {:<28} {}",
            e.name,
            fmt_count(e.pulls),
            e.tag_count,
            clip(&e.sizes.join(", "), 28),
            e.updated
        );
    }
    Ok(())
}

/// Truncates to `max` display columns so one long cell can't shear the table.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    // The ellipsis needs a column of its own, so a zero-width cell has nothing
    // left to spend on content — and `max - 1` would underflow.
    if max == 0 {
        return String::new();
    }
    s.chars().take(max - 1).collect::<String>() + "…"
}

/// `118100000` → `118.1M`, the shorthand the library listing itself uses.
fn fmt_count(n: u64) -> String {
    match n {
        n if n >= 1_000_000_000 => format!("{:.1}B", n as f64 / 1e9),
        n if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        n if n >= 1_000 => format!("{:.1}K", n as f64 / 1e3),
        n => n.to_string(),
    }
}

async fn tags(name: &str, json: bool) -> Result<(), String> {
    let tags = registry()?
        .library_tags(name)
        .await
        .map_err(|e| e.to_string())?;
    if json {
        return print_json(&tags);
    }
    println!(
        "{:<32} {:>8} {:>9} {:<14} {}",
        "TAG", "SIZE", "CONTEXT", "MODALITY", "DIGEST"
    );
    for t in &tags {
        println!(
            "{:<32} {:>8} {:>9} {:<14} {}",
            t.tag, t.size, t.context, t.modality, t.digest
        );
    }
    Ok(())
}

/// Runs both models sequentially (each evicts its weights on finish) so they
/// never have to fit in RAM at once — the same reason the app serialises them.
async fn compare(model_a: &str, model_b: &str, prompt: &str, json: bool) -> Result<(), String> {
    let cancel = crate::cancel_flag();
    let registry = registry()?;
    let _work = registry.try_work_lock().map_err(|e| e.to_string())?;
    crate::prepare_server(&cancel).await?;
    let mut results = Vec::new();
    let mut failed = false;
    registry
        .compare_cancellable(model_a, model_b, prompt, &cancel, |event| match &event {
            CompareEvent::Token { text, .. } if !json => {
                print!("{text}");
                let _ = std::io::Write::flush(&mut std::io::stdout());
            }
            CompareEvent::Status {
                slot,
                phase: Phase::Loading,
            } => eprintln!("[{}] loading", label(*slot)),
            CompareEvent::Result { slot, stats, .. } => {
                if !json {
                    println!(
                        "\n[{}] {} tokens · {} (runtime counters) · TTFT {} ms",
                        label(*slot),
                        stats
                            .eval_count
                            .map(|n| n.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                        crate::tokens_per_second(stats)
                            .map(|r| format!("{r:.1} tok/s"))
                            .unwrap_or_else(|| "rate unknown".into()),
                        stats
                            .ttft_ms
                            .map(|t| format!("{t:.1}"))
                            .unwrap_or_else(|| "unknown".into())
                    );
                }
                results.push(event);
            }
            CompareEvent::Failed { slot, message } => {
                failed = true;
                eprintln!("[{}] {message}", label(*slot));
                results.push(event);
            }
            _ => {}
        })
        .await;
    if json {
        print_json(&results)?;
    }
    if failed {
        Err("comparison did not complete both slots".into())
    } else {
        Ok(())
    }
}

fn label(slot: Slot) -> &'static str {
    match slot {
        Slot::A => "A",
        Slot::B => "B",
    }
}

/// Resolve a supported cached model or an explicit local checkpoint, without Ollama.
pub fn mlx_model(id: &str) -> Result<anchor_hub::bench::mlx::NativeModel, String> {
    let path = std::path::Path::new(id);
    if path.is_dir() {
        return anchor_hub::bench::mlx::local_model(path).map_err(|e| e.to_string());
    }
    let entry = anchor_hub::bench::mlx_catalog::catalog()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown MLX model {id}; see models catalog --runtime mlx"))?;
    let path = entry
        .path
        .ok_or_else(|| format!("download first: anchor models pull {id} --runtime mlx"))?;
    anchor_hub::bench::mlx::local_model(&path).map_err(|e| e.to_string())
}

fn catalog(runtime: Runtime, filter: Option<&str>, json: bool) -> Result<(), String> {
    let needle = filter.unwrap_or("").to_lowercase();
    if runtime == Runtime::Mlx {
        let models: Vec<_> = anchor_hub::bench::mlx_catalog::catalog()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|m| {
                m.id.to_lowercase().contains(&needle) || m.name.to_lowercase().contains(&needle)
            })
            .collect();
        if json {
            return print_json(&models);
        }
        for m in models {
            println!(
                "{}  {}  {}  {}",
                m.id,
                fmt_bytes(m.files.iter().map(|f| f.bytes).sum()),
                if m.path.is_some() {
                    "installed"
                } else {
                    "available"
                },
                m.revision
            );
        }
    } else {
        let models = anchor_core::catalog::load_profiles().map_err(|e| e.to_string())?;
        if json {
            return print_json(&models);
        }
        for m in models {
            println!("{}  {}B  {}", m.id, m.params_b, m.quant);
        }
    }
    Ok(())
}
