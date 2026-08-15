//! Anchor's terminal front-end.
//!
//! Like the Tauri shell, this is deliberately thin: every command resolves the
//! shared data directory, makes sure Ollama is reachable, and delegates to
//! [`anchor_hub`] / [`anchor_search`] / [`anchor_system`]. It reads and writes
//! the *same* files the desktop app does — `registry.db`, `hardware.json`,
//! `install_id` — so a conversation started here shows up in the app, and a
//! benchmark run here lands in the app's history.

use std::io::Write;
use std::path::PathBuf;

use anchor_hub::server::{self, EnsureOutcome};
use anchor_hub::Registry;
use clap::{Parser, Subcommand};

mod bench;
mod chat;
mod fit;
mod models;
mod ops;

/// The desktop app's bundle identifier, from
/// `apps/desktop/src-tauri/tauri.conf.json`. Tauri's `app_data_dir()` resolves
/// to `~/Library/Application Support/{identifier}` on macOS, so this is what
/// makes the CLI and the app share one database.
const APP_IDENTIFIER: &str = "com.anchor.desktop";

#[derive(Parser)]
#[command(
    name = "anchor",
    version,
    about = "Control center for local AI — the terminal half of Anchor",
    long_about = "Manage local models, chat, benchmark, and size memory use.\n\
                  Shares its database with the Anchor desktop app."
)]
struct Cli {
    /// Print the raw result as JSON instead of a table.
    #[arg(long, global = true)]
    json: bool,

    /// Ollama base URL, e.g. http://localhost:11434 (overrides OLLAMA_HOST).
    #[arg(long, global = true)]
    host: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Installed models, discovery, and the public Ollama library.
    Models {
        #[command(subcommand)]
        cmd: models::Cmd,
    },
    /// Memory breakdown for a model: weights, KV cache, and whether it fits.
    Fit(fit::Args),
    /// Chat with a model; conversations are shared with the desktop app.
    Chat(chat::Args),
    /// Run and read benchmarks.
    Bench {
        #[command(subcommand)]
        cmd: bench::Cmd,
    },
    /// Inspect and clean up Ollama's on-disk model store.
    Storage {
        #[command(subcommand)]
        cmd: ops::StorageCmd,
    },
    /// Server status, hardware profile, presets, and stored secrets.
    Settings {
        #[command(subcommand)]
        cmd: ops::SettingsCmd,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    // Set before anything reads it: `anchor_hub::ollama_host()` and the server
    // it spawns both go through OLLAMA_HOST, the same knob the `ollama` CLI uses.
    if let Some(host) = &cli.host {
        std::env::set_var("OLLAMA_HOST", host);
    }
    let json = cli.json;
    let result = match cli.command {
        Command::Models { cmd } => models::run(cmd, json).await,
        Command::Fit(args) => fit::run(args, json).await,
        Command::Chat(args) => chat::run(args, json).await,
        Command::Bench { cmd } => bench::run(cmd, json).await,
        Command::Storage { cmd } => ops::storage(cmd, json).await,
        Command::Settings { cmd } => ops::settings(cmd, json).await,
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// The directory Anchor keeps its state in — shared with the desktop app.
pub fn data_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home)
        .join("Library/Application Support")
        .join(APP_IDENTIFIER))
}

/// Opens the shared registry. `Registry::connect` already waits out a
/// concurrent writer, so the app and the CLI can both have it open.
pub fn registry() -> Result<Registry, String> {
    Registry::open(data_dir()?.join("registry.db")).map_err(|e| e.to_string())
}

/// Makes sure an Ollama server is reachable, starting one if needed.
///
/// Unlike the desktop app, the CLI never records or kills the server it starts:
/// a short-lived command that tore the daemon down on exit would evict weights
/// the next command wants (and the app's, if it is running). A server started
/// here behaves like the user's own `ollama serve` and outlives the process.
///
/// Read-only status commands must not call this — a status read should never be
/// the thing that starts a server.
pub async fn ensure_server() -> Result<(), String> {
    let host = anchor_hub::ollama_host();
    if server::is_running(&host).await {
        return Ok(());
    }
    match server::ensure_running(&host).await {
        EnsureOutcome::AlreadyRunning | EnsureOutcome::Started(_) => Ok(()),
        EnsureOutcome::NotInstalled => Err(
            "Ollama isn't installed (or couldn't be found). Install it from https://ollama.com."
                .into(),
        ),
        EnsureOutcome::FailedToStart(e) => Err(format!("couldn't start the Ollama server: {e}")),
    }
}

/// The host's cached hardware profile (profiled on first use, like the app).
pub fn hardware() -> Result<anchor_core::HardwareProfile, String> {
    anchor_system::Profiler::new(data_dir()?.join("hardware.json"))
        .get()
        .map_err(|e| e.to_string())
}

/// Which stdin answers mean yes. Anything else — including EOF, which leaves the
/// buffer empty — means no, so a piped or redirected delete fails safe.
pub fn is_affirmative(answer: &str) -> bool {
    matches!(answer.trim(), "y" | "Y" | "yes")
}

/// Asks before something irreversible. Every destructive command routes through
/// this, so there is one prompt to reason about rather than one per call site.
pub fn confirm(question: &str) -> Result<bool, String> {
    println!("{question} [y/N]");
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|e| e.to_string())?;
    Ok(is_affirmative(&answer))
}

pub fn print_json<T: serde::Serialize>(value: &T) -> Result<(), String> {
    let out = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    println!("{out}");
    Ok(())
}

/// Unix epoch milliseconds — the timestamp every stored row uses.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Human byte size, binary units — matching what the app shows.
pub fn fmt_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.2} {}", UNITS[unit])
    }
}

pub fn fmt_gib(gb: f64) -> String {
    format!("{gb:.2} GiB")
}

/// Decode throughput from a finished generation. Ollama reports counts and
/// durations, never the rate itself.
pub fn tokens_per_second(stats: &anchor_hub::GenerationStats) -> Option<f64> {
    let tokens = stats.eval_count? as f64;
    let secs = stats.eval_duration_ns? as f64 / 1e9;
    (secs > 0.0).then(|| tokens / secs)
}

/// Prints a line that overwrites the previous one, for streaming progress.
/// Falls back to plain lines when stdout isn't a terminal (piped/redirected),
/// where `\r` would produce one unreadable smear.
pub fn progress_line(text: &str) {
    let mut stdout = std::io::stdout();
    if is_terminal() {
        // Pad to clear the tail of a longer previous line.
        let _ = write!(stdout, "\r{text:<78}");
    } else {
        let _ = writeln!(stdout, "{text}");
    }
    let _ = stdout.flush();
}

/// Ends a run of [`progress_line`] output with a newline.
pub fn progress_done() {
    if is_terminal() {
        println!();
    }
}

fn is_terminal() -> bool {
    std::io::IsTerminal::is_terminal(&std::io::stdout())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_hub::GenerationStats;

    fn stats(eval_count: Option<u64>, eval_duration_ns: Option<u64>) -> GenerationStats {
        GenerationStats {
            eval_count,
            eval_duration_ns,
            ..Default::default()
        }
    }

    // Bytes are the one unit printed without decimals, so a single `{:.2}`
    // format string for every unit would render 512 bytes as "512.00 B".
    #[test]
    fn bytes_under_a_kibibyte_print_without_decimals() {
        assert_eq!(fmt_bytes(0), "0 B");
        assert_eq!(fmt_bytes(512), "512 B");
        assert_eq!(fmt_bytes(1023), "1023 B", "1023 is still bytes, not 1.00 KiB");
    }

    // The loop divides while `value >= 1024.0`, so the boundary belongs to the
    // larger unit — off-by-one here shows up as "1024.00 B".
    #[test]
    fn the_kibibyte_boundary_rolls_over_to_the_larger_unit() {
        assert_eq!(fmt_bytes(1024), "1.00 KiB");
        assert_eq!(fmt_bytes(1024 * 1024), "1.00 MiB");
        assert_eq!(fmt_bytes(1024 * 1024 * 1024), "1.00 GiB");
    }

    // Binary units, not decimal: a 4 GB (decimal) figure is under 4 GiB.
    #[test]
    fn sizes_are_binary_not_decimal() {
        assert_eq!(fmt_bytes(4_000_000_000), "3.73 GiB");
    }

    // The unit table stops at TiB, so anything larger has to keep using it
    // rather than running off the end of the array.
    #[test]
    fn sizes_past_the_largest_unit_stay_in_tebibytes() {
        assert_eq!(fmt_bytes(2048_u64 * 1024 * 1024 * 1024 * 1024), "2048.00 TiB");
    }

    #[test]
    fn throughput_needs_both_a_count_and_a_duration() {
        assert_eq!(tokens_per_second(&stats(Some(100), Some(2_000_000_000))), Some(50.0));
        assert_eq!(tokens_per_second(&stats(None, Some(2_000_000_000))), None);
        assert_eq!(tokens_per_second(&stats(Some(100), None)), None);
    }

    // Ollama reports a zero duration for a generation that produced nothing;
    // dividing by it would yield inf rather than "no rate to report".
    #[test]
    fn a_zero_duration_yields_no_throughput_rather_than_infinity() {
        assert_eq!(tokens_per_second(&stats(Some(100), Some(0))), None);
    }

    #[test]
    fn only_lowercase_y_and_yes_confirm() {
        assert!(is_affirmative("y"));
        assert!(is_affirmative("Y"));
        assert!(is_affirmative("yes"));
        // Trailing newline is what read_line actually hands us.
        assert!(is_affirmative("y\n"));
        assert!(is_affirmative("  yes  \n"));
    }

    // Everything not on the accept list declines, which is the safe direction:
    // "Yes" reading as no costs a retype, "n" reading as yes costs a model.
    #[test]
    fn anything_else_declines() {
        for answer in ["n", "N", "no", "Yes", "YES", "yep", "1", "delete"] {
            assert!(!is_affirmative(answer), "{answer:?} must not confirm");
        }
    }

    // EOF leaves read_line's buffer untouched, so a piped or redirected delete
    // has to land here rather than reading an empty line as consent.
    #[test]
    fn an_empty_answer_from_eof_declines() {
        assert!(!is_affirmative(""), "EOF must not confirm");
        assert!(!is_affirmative("\n"), "a bare newline must not confirm");
    }
}
