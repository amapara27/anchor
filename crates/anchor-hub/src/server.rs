//! Ollama server lifecycle: locate the binary, health-check, and start the
//! daemon when it isn't already running.
//!
//! Anchor's whole point is "local AI without a terminal", so users shouldn't
//! have to launch the Ollama menubar app to get a running server. On startup the
//! app calls [`ensure_running`]: if a server already answers (menubar app, a
//! manual `ollama serve`, a login item — doesn't matter), we reuse it untouched;
//! otherwise we spawn `ollama serve` ourselves and own its lifecycle.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Well-known `ollama` install locations, in priority order.
///
/// A GUI app launched from Finder/Dock does **not** inherit the shell `PATH`
/// (`~/.zshrc` etc.), so `Command::new("ollama")` would fail in a release build
/// while working under `pnpm dev`. Probe the known paths first, then fall back
/// to `PATH` for the terminal-launched dev case.
const BINARY_CANDIDATES: &[&str] = &[
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "/Applications/Ollama.app/Contents/Resources/ollama",
];

/// How long to wait for a freshly spawned server to start answering.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);

/// Result of trying to make sure a server is running.
#[derive(Debug)]
pub enum EnsureOutcome {
    /// A server was already up; Anchor did not start it and must not stop it.
    AlreadyRunning,
    /// Anchor spawned `ollama serve`; the caller owns this child and should kill
    /// it on app exit.
    Started(Child),
    /// The `ollama` binary couldn't be found — nothing to start.
    NotInstalled,
    /// The binary was found but the server didn't come up in time.
    FailedToStart(String),
}

/// Locates the `ollama` binary, or `None` if it isn't installed.
pub fn locate_binary() -> Option<PathBuf> {
    BINARY_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .or_else(|| which_in_path("ollama"))
}

/// Finds an executable by scanning `PATH` (the dev/terminal fallback).
fn which_in_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|p| p.exists())
}

/// Returns true if an Ollama server answers at `host`.
pub async fn is_running(host: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    client
        .get(format!("{host}/api/tags"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Polls [`is_running`] until the server answers or `timeout` elapses.
pub async fn wait_ready(host: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if is_running(host).await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Ensures an Ollama server is reachable at `host`, starting one if needed.
///
/// The child inherits this process's environment, so a user-set `OLLAMA_HOST`
/// flows through to `ollama serve` and matches the `host` we health-check.
pub async fn ensure_running(host: &str) -> EnsureOutcome {
    if is_running(host).await {
        return EnsureOutcome::AlreadyRunning;
    }
    let Some(binary) = locate_binary() else {
        return EnsureOutcome::NotInstalled;
    };
    let child = match Command::new(&binary)
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return EnsureOutcome::FailedToStart(e.to_string()),
    };

    if wait_ready(host, STARTUP_TIMEOUT).await {
        EnsureOutcome::Started(child)
    } else {
        // Don't leak the process we started if it never became healthy.
        let mut child = child;
        let _ = child.kill();
        EnsureOutcome::FailedToStart("`ollama serve` did not become ready in time".into())
    }
}

#[cfg(test)]
mod tests;
