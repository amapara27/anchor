//! Storage and settings: the two "operate the install" sections of the app.

use anchor_hub::server;
use clap::Subcommand;

use crate::{confirm, data_dir, fmt_bytes, hardware, print_json, registry};

/// Keychain service name every Anchor secret is filed under — the same one the
/// desktop app uses, so a key set here is the key the app reads.
const KEYCHAIN_SERVICE: &str = "com.anchor.desktop";

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
            if scan.orphaned_blobs.is_empty() {
                println!("nothing to clean");
                return Ok(());
            }
            if !yes
                && !confirm(&format!(
                    "delete {} orphaned blob(s), freeing {}?",
                    scan.orphaned_blobs.len(),
                    fmt_bytes(scan.orphaned_bytes)
                ))?
            {
                println!("left alone");
                return Ok(());
            }
            let freed = anchor_hub::storage::clean_orphaned(&scan);
            println!("freed {}", fmt_bytes(freed));
            Ok(())
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
    /// Secrets in the macOS Keychain, shared with the app.
    Secret {
        #[command(subcommand)]
        cmd: SecretCmd,
    },
    /// Where Anchor keeps its state.
    Paths,
}

#[derive(Subcommand)]
pub enum PresetCmd {
    Ls,
    Show { id: String },
    Rm { id: String },
}

#[derive(Subcommand)]
pub enum SecretCmd {
    /// Print a stored secret.
    Get { key: String },
    /// Store a secret. With no value it is read from stdin, so the key never
    /// lands in shell history; passing an explicit empty string deletes it.
    Set { key: String, value: Option<String> },
}

/// What an incoming secret value means.
#[derive(Debug, PartialEq)]
enum SecretAction {
    Store,
    Clear,
}

/// Clearing is destructive and unrecoverable, so it has to be asked for
/// explicitly. An empty line arriving on stdin is far more often a closed pipe
/// or an empty file than a deliberate delete, so that case is an error rather
/// than a silent wipe of a key the app still needs.
fn secret_action(value: &str, from_stdin: bool) -> Result<SecretAction, String> {
    if !value.is_empty() {
        Ok(SecretAction::Store)
    } else if from_stdin {
        Err("no value on stdin; pass an explicit \"\" to clear the key".into())
    } else {
        Ok(SecretAction::Clear)
    }
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
                profile.memory_bytes.map(fmt_bytes).unwrap_or_else(|| "—".into())
            );
            println!(
                "  cpu cores   {} ({}P + {}E)",
                opt(profile.total_cores),
                opt(profile.performance_cores),
                opt(profile.efficiency_cores)
            );
            println!("  gpu cores   {}", opt(profile.gpu_cores));
            println!("  macOS       {}", profile.os_version.as_deref().unwrap_or("—"));
            Ok(())
        }
        SettingsCmd::Presets { cmd } => presets(cmd, json),
        SettingsCmd::Secret { cmd } => secret(cmd),
        SettingsCmd::Paths => {
            let dir = data_dir()?;
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
    println!("status     {}", if reachable { "running" } else { "stopped" });
    println!("version    {}", version.as_deref().unwrap_or("—"));
    if !local {
        println!(
            "\nwarning: {host} is not this machine — prompts and responses leave this Mac."
        );
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
            println!("{:<38} {:<24} {:>6} {:>8} {:>6}", "ID", "NAME", "TEMP", "NUM_CTX", "TOP_P");
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
        PresetCmd::Rm { id } => {
            // The default preset is protected — conversations resolve through
            // it — so deleting it is a no-op rather than an error.
            registry.delete_preset(&id).map_err(|e| e.to_string())?;
            println!("deleted {id}");
            Ok(())
        }
    }
}

fn secret(cmd: SecretCmd) -> Result<(), String> {
    match cmd {
        SecretCmd::Get { key } => {
            let entry =
                keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
            match entry.get_password() {
                Ok(value) => {
                    println!("{value}");
                    Ok(())
                }
                Err(keyring::Error::NoEntry) => Err(format!("no secret stored under {key}")),
                Err(e) => Err(e.to_string()),
            }
        }
        SecretCmd::Set { key, value } => {
            let from_stdin = value.is_none();
            let value = match value {
                Some(v) => v,
                None => {
                    let mut buf = String::new();
                    std::io::stdin()
                        .read_line(&mut buf)
                        .map_err(|e| e.to_string())?;
                    buf.trim().to_string()
                }
            };
            let entry =
                keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
            match secret_action(&value, from_stdin)? {
                SecretAction::Clear => {
                    // Deleting a key that was never set is the normal "cleared an
                    // empty field" path, not an error.
                    match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => {
                            println!("cleared {key}");
                            Ok(())
                        }
                        Err(e) => Err(e.to_string()),
                    }
                }
                SecretAction::Store => {
                    entry.set_password(&value).map_err(|e| e.to_string())?;
                    println!("stored {key}");
                    Ok(())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every numeric column shares one em-dash placeholder, so a missing figure
    // reads as "not reported" rather than as a real zero.
    #[test]
    fn a_missing_value_renders_as_an_em_dash() {
        assert_eq!(opt(None::<u64>), "—");
        assert_eq!(opt(Some(0)), "0", "zero is a real reading, not a gap");
        assert_eq!(opt(Some(42)), "42");
    }

    #[test]
    fn a_non_empty_value_is_always_stored() {
        assert_eq!(secret_action("sk-abc", false), Ok(SecretAction::Store));
        assert_eq!(secret_action("sk-abc", true), Ok(SecretAction::Store));
    }

    // `anchor settings secret set KEY ""` is the deliberate delete.
    #[test]
    fn an_explicit_empty_argument_clears_the_key() {
        assert_eq!(secret_action("", false), Ok(SecretAction::Clear));
    }

    // `anchor settings secret set KEY < /dev/null` used to print "cleared KEY"
    // and wipe a live credential. A closed pipe must not be able to do that.
    #[test]
    fn an_empty_read_from_stdin_is_an_error_not_a_wipe() {
        let err = secret_action("", true).unwrap_err();
        assert!(
            err.contains("no value on stdin"),
            "expected a refusal explaining how to clear on purpose, got {err:?}"
        );
    }
}
