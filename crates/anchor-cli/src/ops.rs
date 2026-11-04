//! Storage and settings: the two "operate the install" sections of the app.

use anchor_hub::server;
use clap::Subcommand;

use crate::{confirm, data_dir, fmt_bytes, hardware, print_json, registry};

#[derive(Subcommand)]
pub enum StorageCmd {
    /// What Ollama's model store holds: sharing savings and orphaned blobs.
    Scan,
    /// Delete blobs no manifest references anymore.
    Clean {
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
}

pub async fn storage(cmd: StorageCmd, json: bool) -> Result<(), String> {
    // No server needed either way: this walks the filesystem.
    let scan = anchor_hub::storage::scan()
        .map_err(|e| e.to_string())?
        .ok_or("Ollama's model store doesn't exist yet — nothing has been pulled")?;
    match cmd {
        StorageCmd::Scan => {
            if json {
                return print_json(&scan);
            }
            println!("{}", scan.root);
            println!("  blobs         {}", fmt_bytes(scan.blobs_bytes));
            println!("  manifests     {}", fmt_bytes(scan.manifests_bytes));
            println!(
                "  shared        {} saved by content-addressing",
                fmt_bytes(scan.dedup_savings_bytes)
            );
            println!(
                "  orphaned      {} across {} blobs",
                fmt_bytes(scan.orphaned_bytes),
                scan.orphaned_blobs.len()
            );
            if scan.unreadable_manifests > 0 {
                println!(
                    "\n  {} manifest(s) couldn't be read, so no blob is reported as orphaned —\n  \
                     a manifest we can't read contributes no references, and its blobs would\n  \
                     look deletable when they are live model data.",
                    scan.unreadable_manifests
                );
            } else if !scan.orphaned_blobs.is_empty() {
                println!("\n  `anchor storage clean` frees the orphaned bytes.");
            }
            Ok(())
        }
        StorageCmd::Clean { yes } => {
            if scan.unreadable_manifests > 0 {
                return Err("cannot clean an incomplete reference graph".into());
            }
            if scan.orphaned_blobs.is_empty() {
                return crate::mutation(json, "nothing to clean", None);
            }
            if !yes
                && !confirm(&format!(
                    "delete {} orphaned blob(s), freeing {}?",
                    scan.orphaned_blobs.len(),
                    fmt_bytes(scan.orphaned_bytes)
                ))?
            {
                return crate::mutation(json, "declined", None);
            }
            let freed = anchor_hub::storage::clean_orphaned(&scan);
            if json {
                print_json(&serde_json::json!({"freed_bytes":freed}))
            } else {
                println!("freed {}", fmt_bytes(freed));
                Ok(())
            }
        }
    }
}

#[derive(Subcommand)]
pub enum SettingsCmd {
    /// Ollama server status.
    Server {
        /// Start a server if none is running.
        #[arg(long)]
        start: bool,
    },
    /// This machine's profiled hardware.
    Hardware {
        /// Re-profile instead of reading the cache.
        #[arg(long)]
        refresh: bool,
    },
    /// Generation presets (system prompt, temperature, context, top-p).
    Presets {
        #[command(subcommand)]
        cmd: PresetCmd,
    },
    /// Where Anchor keeps its state.
    Paths,
}

#[derive(Subcommand)]
pub enum PresetCmd {
    Ls,
    Show {
        id: String,
    },
    Rm {
        id: String,
        #[arg(long)]
        yes: bool,
    },
    /// Create or update a preset. Unspecified fields retain their values.
    Save {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        system: Option<String>,
        #[arg(long)]
        temperature: Option<f32>,
        #[arg(long)]
        num_ctx: Option<u32>,
        #[arg(long)]
        top_p: Option<f32>,
        #[arg(long)]
        model: Option<String>,
        /// Reset optional fields to runtime defaults, e.g. --clear system,num-ctx.
        #[arg(long, value_delimiter = ',')]
        clear: Vec<String>,
    },
}

pub async fn settings(cmd: SettingsCmd, json: bool) -> Result<(), String> {
    match cmd {
        SettingsCmd::Server { start } => server_status(start, json).await,
        SettingsCmd::Hardware { refresh } => {
            let profile = if refresh {
                anchor_system::Profiler::new(data_dir()?.join("hardware.json"))
                    .refresh()
                    .map_err(|e| e.to_string())?
            } else {
                hardware()?
            };
            if json {
                return print_json(&profile);
            }
            println!("{}", profile.chip.as_deref().unwrap_or("unknown chip"));
            println!(
                "  model       {}",
                profile.model_name.as_deref().unwrap_or("—")
            );
            println!("  arch        {}", profile.arch);
            println!(
                "  memory      {}",
                profile
                    .memory_bytes
                    .map(fmt_bytes)
                    .unwrap_or_else(|| "—".into())
            );
            println!(
                "  cpu cores   {} ({}P + {}E)",
                opt(profile.total_cores),
                opt(profile.performance_cores),
                opt(profile.efficiency_cores)
            );
            println!("  gpu cores   {}", opt(profile.gpu_cores));
            println!(
                "  macOS       {}",
                profile.os_version.as_deref().unwrap_or("—")
            );
            Ok(())
        }
        SettingsCmd::Presets { cmd } => presets(cmd, json),
        SettingsCmd::Paths => {
            let dir = data_dir()?;
            if json {
                return print_json(&serde_json::json!({
                    "data_dir":dir,"registry":dir.join("registry.db"),"hardware":dir.join("hardware.json"),
                    "ollama_host":anchor_hub::ollama_host(),"model_store":anchor_hub::storage::models_root()
                }));
            }
            println!("data dir     {}", dir.display());
            println!("registry     {}", dir.join("registry.db").display());
            println!("hardware     {}", dir.join("hardware.json").display());
            println!("ollama host  {}", anchor_hub::ollama_host());
            println!(
                "model store  {}",
                anchor_hub::storage::models_root()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "—".into())
            );
            Ok(())
        }
    }
}

fn opt<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map(|v| v.to_string()).unwrap_or_else(|| "—".into())
}

async fn server_status(start: bool, json: bool) -> Result<(), String> {
    let host = anchor_hub::ollama_host();
    if start {
        crate::ensure_server().await?;
    }
    // Otherwise a plain status read, which must never start anything.
    let reachable = server::is_running(&host).await;
    let version = if reachable {
        anchor_hub::ollama::version(&host).await.ok()
    } else {
        None
    };
    let local = anchor_hub::is_local_host(&host);
    if json {
        return print_json(&serde_json::json!({
            "host": host,
            "reachable": reachable,
            "version": version,
            "local": local,
        }));
    }
    println!("host       {host}");
    println!(
        "status     {}",
        if reachable { "running" } else { "stopped" }
    );
    println!("version    {}", version.as_deref().unwrap_or("—"));
    if !local {
        println!("\nwarning: {host} is not this machine — prompts and responses leave this Mac.");
    } else if !reachable {
        println!("\n`anchor settings server --start` starts one.");
    }
    Ok(())
}

fn presets(cmd: PresetCmd, json: bool) -> Result<(), String> {
    let registry = registry()?;
    match cmd {
        PresetCmd::Ls => {
            let presets = registry.presets().map_err(|e| e.to_string())?;
            if json {
                return print_json(&presets);
            }
            // Preset ids are frontend-minted uuids, hence the wide column.
            println!(
                "{:<38} {:<24} {:>6} {:>8} {:>6}",
                "ID", "NAME", "TEMP", "NUM_CTX", "TOP_P"
            );
            for p in &presets {
                println!(
                    "{:<38} {:<24} {:>6} {:>8} {:>6}",
                    p.id,
                    p.name,
                    opt(p.temperature),
                    opt(p.num_ctx),
                    opt(p.top_p),
                );
            }
            Ok(())
        }
        PresetCmd::Show { id } => {
            let preset = registry
                .presets()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("no preset {id}"))?;
            if json {
                return print_json(&preset);
            }
            println!("{} ({})", preset.name, preset.id);
            println!("  temperature {}", opt(preset.temperature));
            println!("  num_ctx     {}", opt(preset.num_ctx));
            println!("  top_p       {}", opt(preset.top_p));
            println!("  model       {}", preset.model.as_deref().unwrap_or("any"));
            if let Some(system) = preset.system.as_deref().filter(|s| !s.trim().is_empty()) {
                println!("\n{system}");
            }
            Ok(())
        }
        PresetCmd::Save {
            id,
            name,
            system,
            temperature,
            num_ctx,
            top_p,
            model,
            clear,
        } => {
            let mut p = registry
                .presets()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|p| p.id == id)
                .unwrap_or(anchor_hub::Preset {
                    id: id.clone(),
                    name: id,
                    system: None,
                    temperature: None,
                    num_ctx: None,
                    top_p: None,
                    model: None,
                    created_ms: crate::now_ms(),
                });
            if let Some(n) = name {
                p.name = n;
            }
            if system.is_some() {
                p.system = system;
            }
            if temperature.is_some() {
                p.temperature = temperature;
            }
            if num_ctx.is_some() {
                p.num_ctx = num_ctx;
            }
            if top_p.is_some() {
                p.top_p = top_p;
            }
            if model.is_some() {
                p.model = model;
            }
            for field in clear {
                match field.as_str() {
                    "system" => p.system = None,
                    "temperature" => p.temperature = None,
                    "num-ctx" => p.num_ctx = None,
                    "top-p" => p.top_p = None,
                    "model" => p.model = None,
                    _ => return Err(format!("unknown preset field {field}")),
                }
            }
            registry.save_preset(&p).map_err(|e| e.to_string())?;
            if json {
                print_json(&p)
            } else {
                crate::mutation(false, "saved", Some(&p.id))
            }
        }
        PresetCmd::Rm { id, yes } => {
            // The default preset is protected — conversations resolve through
            // it — so deleting it is a no-op rather than an error.
            if id == anchor_hub::DEFAULT_PRESET_ID {
                return crate::mutation(json, "protected", Some(&id));
            }
            if !yes && !confirm(&format!("delete preset {id}?"))? {
                return crate::mutation(json, "declined", Some(&id));
            }
            registry.delete_preset(&id).map_err(|e| e.to_string())?;
            crate::mutation(json, "deleted", Some(&id))
        }
    }
}
