//! The models hub: what's installed, what's discoverable, what's browsable, and
//! side-by-side comparison. Mirrors the `Models` section of the desktop app.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use anchor_core::Model;
use anchor_hub::{CompareEvent, Phase, Slot};
use clap::Subcommand;

use crate::{ensure_server, fmt_bytes, print_json, progress_done, progress_line, registry};

/// How long the scraped Ollama library listing stays good. Models are published
/// on a scale of days, and the page is ~700 KB — a day-old list is fine.
const LIBRARY_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Subcommand)]
pub enum Cmd {
    /// List installed models.
    Ls,
    /// Everything known about one model, including its memory breakdown.
    Info { id: String },
    /// Download a model from the Ollama library.
    Pull { id: String },
    /// Remove an installed model.
    Rm { id: String },
    /// Models Ollama currently has resident in memory.
    Ps,
    /// Evict a model's weights from memory.
    Unload { model: String },
    /// Semantic search over Anchor's curated catalog.
    Discover {
        /// What you want the model to do, in plain language.
        query: Vec<String>,
        /// How many results to show.
        #[arg(short = 'n', long, default_value_t = 3)]
        limit: usize,
    },
    /// Every model published on ollama.com.
    Browse {
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
        prompt: String,
    },
}

pub async fn run(cmd: Cmd, json: bool) -> Result<(), String> {
    match cmd {
        Cmd::Ls => ls(json).await,
        Cmd::Info { id } => info(&id, json).await,
        Cmd::Pull { id } => pull(&id).await,
        Cmd::Rm { id } => {
            ensure_server().await?;
            registry()?.remove(&id).await.map_err(|e| e.to_string())?;
            println!("removed {id}");
            Ok(())
        }
        Cmd::Ps => ps(json).await,
        Cmd::Unload { model } => {
            registry()?.unload(&model).await.map_err(|e| e.to_string())?;
            println!("unloaded {model}");
            Ok(())
        }
        Cmd::Discover { query, limit } => discover(&query.join(" "), limit, json).await,
        Cmd::Browse { refresh, filter } => browse(refresh, filter.as_deref(), json).await,
        Cmd::Tags { name } => tags(&name, json).await,
        Cmd::Compare {
            model_a,
            model_b,
            prompt,
        } => compare(&model_a, &model_b, &prompt).await,
    }
}

/// Installed models, syncing from Ollama and falling back to the last-synced
/// cache when it's unreachable — the same contract as the app's `list_models`.
pub async fn installed() -> Result<Vec<Model>, String> {
    ensure_server().await?;
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
        println!("no models installed — try `anchor models discover \"...\"`");
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
        model.size_bytes.map(fmt_bytes).unwrap_or_else(|| "—".into())
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

async fn pull(id: &str) -> Result<(), String> {
    ensure_server().await?;
    // Nothing trips this flag: Ctrl-C ends the process, which drops the response
    // and lets Ollama abandon the transfer — exactly what the app's cancel does.
    let never = Arc::new(AtomicBool::new(false));
    registry()?
        .pull(id, &never, |p| {
            let pct = match (p.completed, p.total) {
                (Some(done), Some(total)) if total > 0 => {
                    format!(" {:>5.1}% ({} of {})", 100.0 * done as f64 / total as f64, fmt_bytes(done), fmt_bytes(total))
                }
                _ => String::new(),
            };
            progress_line(&format!("{}{pct}", p.status));
        })
        .await
        .map_err(|e| e.to_string())?;
    progress_done();
    println!("pulled {id}");
    Ok(())
}

async fn ps(json: bool) -> Result<(), String> {
    // Deliberately no `ensure_server`: a down server has nothing resident,
    // which is exactly an empty list.
    let running = anchor_hub::status::running(&registry()?)
        .await
        .unwrap_or_default();
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

async fn discover(query: &str, limit: usize, json: bool) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err("give me something to search for".into());
    }
    let dir = crate::data_dir()?;
    // ponytail: the index is rebuilt per invocation — 38 profiles through a
    // local ONNX embedder, a couple of seconds. Cache the vectors next to the
    // embedding model if that ever grates. The first run downloads BGE-small
    // into the same `embeddings/` cache the app uses.
    let index = anchor_search::SemanticIndex::build(dir.join("embeddings"))
        .map_err(|e| e.to_string())?;
    let results = index.search(query, limit).map_err(|e| e.to_string())?;

    // Best-effort, exactly as in the app: a failed history write must not sink
    // an otherwise-good search.
    let ids: Vec<String> = results.iter().map(|r| r.profile.id.clone()).collect();
    let history = anchor_search::QueryHistory::new(dir.join("search_history.json"));
    if let Err(e) = history.record(query, &ids) {
        eprintln!("note: couldn't record the query in history: {e}");
    }

    if json {
        return print_json(&results);
    }
    for hit in &results {
        let p = &hit.profile;
        println!("{}  ({:.0}% match)", p.id, hit.score * 100.0);
        println!("  {}", p.blurb);
        println!(
            "  {}B · {} · ~{:.1} GiB download · {} ctx",
            p.params_b, p.quant, p.download_gb, p.context_tokens
        );
        println!();
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
async fn compare(model_a: &str, model_b: &str, prompt: &str) -> Result<(), String> {
    ensure_server().await?;
    let mut current: Option<Slot> = None;
    registry()?
        .compare(model_a, model_b, prompt, |event| match event {
            CompareEvent::Pull { slot, progress } => {
                progress_line(&format!("[{}] {}", label(slot), progress.status));
            }
            CompareEvent::Status { slot, phase } => match phase {
                Phase::Generating => {
                    progress_done();
                    println!("\n── {} ──", label(slot));
                    current = Some(slot);
                }
                Phase::Loading => progress_line(&format!("[{}] loading…", label(slot))),
                Phase::Queued | Phase::Done => {}
            },
            CompareEvent::Token { text, .. } => {
                print!("{text}");
                let _ = std::io::Write::flush(&mut std::io::stdout());
            }
            CompareEvent::Result { slot, stats, .. } => {
                println!(
                    "\n[{}] {} tokens · {}",
                    label(slot),
                    stats.eval_count.unwrap_or(0),
                    crate::tokens_per_second(&stats)
                        .map(|t| format!("{t:.1} tok/s"))
                        .unwrap_or_else(|| "rate unknown".into()),
                );
            }
            CompareEvent::Failed { slot, message } => {
                progress_done();
                eprintln!("[{}] failed: {message}", label(slot));
            }
        })
        .await;
    Ok(())
}

fn label(slot: Slot) -> &'static str {
    match slot {
        Slot::A => "A",
        Slot::B => "B",
    }
}
