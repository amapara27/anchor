//! `anchor fit` — what a model costs in memory at a given context length.
//!
//! Presentation only: the math is [`anchor_core::fit`], which mirrors the
//! desktop app's `lib/kv.ts` + `lib/fit.ts` byte for byte, so the two front-ends
//! never disagree about whether something fits.

use anchor_core::fit::{self, FitResult, FitTier, KvSource};
use anchor_core::{ArchMeta, Model};
use clap::Args as ClapArgs;

use crate::{fmt_gib, hardware, print_json, registry};

#[derive(ClapArgs)]
pub struct Args {
    /// An installed model or a catalog id, e.g. `llama3.2:1b`.
    pub model: String,
    /// Context length to size at. Defaults to Ollama's own load default (4096),
    /// capped by the model's maximum.
    #[arg(long)]
    pub ctx: Option<u64>,
    /// Quantisation to assume. Only used when the real on-disk size is unknown
    /// (an uninstalled model); an installed one is sized from its actual bytes.
    #[arg(long)]
    pub quant: Option<String>,
}

pub async fn run(args: Args, json: bool) -> Result<(), String> {
    let source = resolve(&args.model).await?;
    let breakdown = compute(&source, args.ctx, args.quant.as_deref())?;
    if json {
        return print_json(&breakdown.result);
    }
    print(&source, &breakdown);
    Ok(())
}

/// Everything the fit engine needs about one model, from wherever it was found.
pub struct Subject {
    pub id: String,
    pub params_b: f64,
    pub quant: String,
    pub max_context: u64,
    pub arch: Option<ArchMeta>,
    pub size_bytes: Option<u64>,
    /// Where the facts came from, for the footer.
    pub origin: &'static str,
}

pub struct Breakdown {
    pub context: u64,
    pub result: FitResult,
    /// KV bytes per token of context — the figure that actually explains the
    /// slope, and the one the app's detail panel shows.
    pub kv_per_token: f64,
}

/// Finds a model: installed first (real on-disk size and its own GGUF header),
/// then the curated catalog (which ships architecture metadata for models that
/// aren't installed yet, so an uninstalled model still gets exact KV math).
async fn resolve(id: &str) -> Result<Subject, String> {
    let registry = registry()?;
    // Cheap path first: whatever the app last synced. Only if that misses do we
    // talk to Ollama — and a down server is not an error here, it just means we
    // fall through to the catalog.
    let mut cached = registry.cached_models().unwrap_or_default();
    if !cached.iter().any(|m| m.id == id || m.name == id) {
        if let Ok(fresh) = registry.sync().await {
            cached = fresh;
        }
    }
    if let Some(model) = cached.iter().find(|m| m.id == id || m.name == id) {
        return Ok(from_installed(model));
    }

    let profiles = anchor_search::load_profiles().map_err(|e| e.to_string())?;
    if let Some(p) = profiles.iter().find(|p| p.id == id) {
        return Ok(Subject {
            id: p.id.clone(),
            params_b: p.params_b as f64,
            quant: p.quant.clone(),
            max_context: p.context_tokens,
            arch: p.arch.clone(),
            size_bytes: None,
            origin: "catalog (not installed)",
        });
    }
    Err(format!(
        "{id} isn't installed and isn't in the catalog — \
         `anchor models pull {id}` first, or `anchor models browse` to find it"
    ))
}

fn from_installed(model: &Model) -> Subject {
    Subject {
        id: model.id.clone(),
        // The label Ollama reports is authoritative; the tag suffix is the
        // fallback for models that don't carry one.
        params_b: model
            .parameter_size
            .as_deref()
            .and_then(fit::parse_param_size)
            .or_else(|| fit::parse_tag_params(&model.id))
            .unwrap_or(0.0),
        quant: model.quantization.clone().unwrap_or_else(|| "unknown".into()),
        max_context: model.context_tokens.unwrap_or(0),
        arch: model.arch.clone(),
        size_bytes: model.size_bytes,
        origin: "installed",
    }
}

fn compute(
    subject: &Subject,
    ctx: Option<u64>,
    quant_override: Option<&str>,
) -> Result<Breakdown, String> {
    let context = ctx.unwrap_or_else(|| fit::fit_context(subject.max_context));
    if context == 0 {
        return Err("context length must be greater than zero".into());
    }
    let memory_bytes = hardware()?.memory_bytes;
    let quant = quant_override.unwrap_or(&subject.quant);
    // An explicit --quant is a "what if I ran this build instead" question, so
    // the real on-disk size of the build we have must not answer it.
    let size_bytes = if quant_override.is_some() {
        None
    } else {
        subject.size_bytes
    };
    let result = fit::estimate_fit(
        subject.params_b,
        quant,
        context,
        memory_bytes,
        subject.arch.as_ref(),
        size_bytes,
    );
    Ok(Breakdown {
        kv_per_token: result.breakdown.kv_cache_gb * (1024.0 * 1024.0 * 1024.0) / context as f64,
        context,
        result,
    })
}

fn print(subject: &Subject, b: &Breakdown) {
    let arch_line = match &subject.arch {
        Some(a) => format!(
            "arch {} · {} layers · {} kv heads",
            a.architecture.as_deref().unwrap_or("?"),
            a.block_count.map(|v| v.to_string()).unwrap_or("?".into()),
            a.head_count_kv.map(|v| v.to_string()).unwrap_or("?".into()),
        ),
        None => "no architecture metadata".to_string(),
    };
    println!(
        "{}   {}   {}B   {arch_line}",
        subject.id, subject.quant, subject.params_b
    );
    println!();
    let d = &b.result.breakdown;
    let max = if subject.max_context > 0 {
        format!(" (max {})", subject.max_context)
    } else {
        String::new()
    };
    println!("  context      {}{max}", b.context);
    println!("  weights      {}", fmt_gib(d.weights_gb));
    println!(
        "  kv cache     {}   ({:.1} KiB/token, from {})",
        fmt_gib(d.kv_cache_gb),
        b.kv_per_token / 1024.0,
        match b.result.kv_source {
            KvSource::Metadata => "metadata",
            KvSource::Estimated => "a parameter-count estimate",
        }
    );
    println!("  compute buf  {}", fmt_gib(d.compute_buffer_gb));
    println!("  os reserve   {}", fmt_gib(d.os_reserve_gb));
    println!(
        "  ─ total      {} of {}   headroom {}   → {}",
        fmt_gib(d.total_needed_gb),
        fmt_gib(d.available_gb),
        fmt_gib(b.result.headroom_gb),
        verdict(b.result.tier),
    );
    println!();
    println!("  {}", subject.origin);
    if b.result.kv_source == KvSource::Estimated {
        println!("  KV is bucketed from parameter count — treat it as a lower bound.");
    }
}

fn verdict(tier: FitTier) -> &'static str {
    match tier {
        FitTier::Ok => "ok",
        FitTier::Tight => "tight",
        FitTier::WontFit => "won't fit",
        FitTier::Unknown => "unknown (host memory or parameter count is missing)",
    }
}

/// The same breakdown, for `anchor models info` — which already has the model
/// in hand, so it skips resolution.
pub fn print_breakdown(model: &Model) -> Result<(), String> {
    let subject = from_installed(model);
    let breakdown = compute(&subject, None, None)?;
    print(&subject, &breakdown);
    Ok(())
}
