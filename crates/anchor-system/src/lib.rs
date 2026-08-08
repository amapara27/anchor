//! Static hardware profiling for Anchor.
//!
//! On macOS this shells out to `system_profiler` once, parses the chip, memory,
//! CPU/GPU core counts and OS version, and caches the result to a JSON file so
//! it never re-runs on subsequent launches. The profile drives the home-screen
//! "Your Mac" panel, the model-library "too large for your hardware" flags, and
//! the hardware identity that benchmark results are matched on.
//!
//! Like `anchor-hub`'s `Registry`, this crate is free of any Tauri/UI dependency
//! and takes its cache path from the caller, so it stays testable and reusable.
//! It's named generically (not `anchor-hardware`) so a future live monitor can
//! land here without a new crate. The benchmark *runner* lives in `anchor-hub`,
//! which owns both the SQLite connection and the Ollama client it needs.

use std::path::PathBuf;

use serde::Deserialize;

pub use anchor_core::HardwareProfile;

pub mod telemetry;

/// Errors surfaced by the profiler. Stringified at the Tauri boundary.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `system_profiler` couldn't be spawned, exited non-zero, or returned
    /// non-UTF-8 output.
    #[error("system_profiler failed: {0}")]
    Profiler(String),
    /// The `system_profiler` JSON couldn't be parsed.
    #[error("malformed system_profiler output: {0}")]
    Json(#[from] serde_json::Error),
    /// A cache read/write failure (best-effort; rarely surfaced).
    #[error("hardware cache io error: {0}")]
    Io(String),
}

/// Convenience alias for profiler results.
pub type Result<T> = std::result::Result<T, Error>;

/// Caches a [`HardwareProfile`] at a JSON file path.
///
/// Holds only the cache path (mirroring `Registry::open(db_path)`); profiling is
/// a one-shot subprocess, so there's no live handle to keep.
#[derive(Debug, Clone)]
pub struct Profiler {
    cache_path: PathBuf,
}

impl Profiler {
    /// Builds a profiler backed by the JSON cache at `cache_path`.
    pub fn new(cache_path: impl Into<PathBuf>) -> Self {
        Self { cache_path: cache_path.into() }
    }

    /// Returns the cached profile if present and parseable, otherwise profiles
    /// the machine fresh and writes the cache.
    ///
    /// A corrupt or schema-drifted cache is treated as a miss (re-profile +
    /// overwrite) rather than an error, so a bad file can never wedge the app.
    pub fn get(&self) -> Result<HardwareProfile> {
        if let Some(cached) = self.read_cache() {
            return Ok(cached);
        }
        let profile = Self::profile_now();
        self.write_cache(&profile);
        Ok(profile)
    }

    /// Re-runs `system_profiler`, overwriting the cache. Backs a manual refresh.
    pub fn refresh(&self) -> Result<HardwareProfile> {
        let profile = Self::profile_now();
        self.write_cache(&profile);
        Ok(profile)
    }

    /// Profiles the host now (spawn + parse), with no cache I/O.
    ///
    /// Best-effort: if `system_profiler` is unavailable or its output can't be
    /// parsed, falls back to a minimal profile derived from `std::env` so the
    /// caller always gets *something* renderable.
    pub fn profile_now() -> HardwareProfile {
        match run_system_profiler() {
            Ok(json) => parse_profile(&json).unwrap_or_else(|_| minimal_profile()),
            Err(_) => minimal_profile(),
        }
    }

    fn read_cache(&self) -> Option<HardwareProfile> {
        let bytes = std::fs::read(&self.cache_path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Best-effort: a failed write still leaves the in-memory profile usable.
    fn write_cache(&self, profile: &HardwareProfile) {
        if let Some(parent) = self.cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(profile) {
            let _ = std::fs::write(&self.cache_path, json);
        }
    }
}

/// Runs `system_profiler -json SPHardwareDataType SPSoftwareDataType SPDisplaysDataType`.
fn run_system_profiler() -> Result<String> {
    let output = std::process::Command::new("system_profiler")
        .args([
            "-json",
            "SPHardwareDataType",
            "SPSoftwareDataType",
            "SPDisplaysDataType",
        ])
        .output()
        .map_err(|e| Error::Profiler(e.to_string()))?;
    if !output.status.success() {
        return Err(Error::Profiler(format!("exited with {}", output.status)));
    }
    String::from_utf8(output.stdout).map_err(|e| Error::Profiler(e.to_string()))
}

/// A minimal profile from `std::env` only, for when `system_profiler` fails.
fn minimal_profile() -> HardwareProfile {
    let arch = std::env::consts::ARCH.to_string();
    let apple_silicon = arch == "aarch64";
    let total_cores = std::thread::available_parallelism().ok().map(|n| n.get() as u32);
    HardwareProfile {
        chip: None,
        arch,
        memory_bytes: None,
        total_cores,
        performance_cores: None,
        efficiency_cores: None,
        gpu_cores: None,
        os_version: None,
        apple_silicon,
        model_name: None,
    }
}

/// Parses a `system_profiler -json` payload into a [`HardwareProfile`].
///
/// Pure (no subprocess), so tests drive it with fixture JSON. `arch` and
/// `apple_silicon` come from the running binary, not the payload — they're a
/// property of *this* machine, which is always the one being profiled.
pub fn parse_profile(json: &str) -> Result<HardwareProfile> {
    let raw: RawReport = serde_json::from_str(json)?;
    let hw = raw.hardware.into_iter().next().unwrap_or_default();
    let sw = raw.software.into_iter().next().unwrap_or_default();

    let arch = std::env::consts::ARCH.to_string();
    let apple_silicon = arch == "aarch64";

    let (total_cores, performance_cores, efficiency_cores) = match hw.number_processors {
        // Apple Silicon reports a "proc total:perf:eff" string; Intel often a bare int.
        Some(serde_json::Value::String(s)) => parse_core_counts(&s),
        Some(serde_json::Value::Number(n)) => (n.as_u64().map(|v| v as u32), None, None),
        _ => (None, None, None),
    };

    Ok(HardwareProfile {
        chip: hw.chip_type.or(hw.cpu_type),
        arch,
        memory_bytes: hw.physical_memory.as_deref().and_then(parse_memory_bytes),
        total_cores,
        performance_cores,
        efficiency_cores,
        gpu_cores: parse_gpu_cores(&raw.displays),
        os_version: sw.os_version.as_deref().and_then(strip_os_version),
        apple_silicon,
        model_name: hw.machine_name,
    })
}

/// GPU core count from the `SPDisplaysDataType` entries.
///
/// Prefers the built-in GPU: an attached eGPU or a second entry would otherwise
/// win on ordering alone, and it's the integrated one that runs inference.
fn parse_gpu_cores(displays: &[RawDisplay]) -> Option<u32> {
    let cores = |d: &RawDisplay| d.sppci_cores.as_deref()?.trim().parse::<u32>().ok();
    displays
        .iter()
        .find(|d| d.sppci_bus.as_deref() == Some("spdisplays_builtin"))
        .and_then(cores)
        .or_else(|| displays.iter().find_map(cores))
}

/// `"18 GB"` → bytes. Returns `None` for missing/unknown units or non-numbers.
fn parse_memory_bytes(raw: &str) -> Option<u64> {
    let mut parts = raw.split_whitespace();
    let value: f64 = parts.next()?.parse().ok()?;
    let factor: u64 = match parts.next()?.to_ascii_uppercase().as_str() {
        "TB" => 1024_u64.pow(4),
        "GB" => 1024_u64.pow(3),
        "MB" => 1024_u64.pow(2),
        "KB" => 1024,
        _ => return None,
    };
    Some((value * factor as f64) as u64)
}

/// `"proc 11:5:6"` → `(total, perf, eff)`. A bare integer → total only; junk → all `None`.
///
/// Newer chips append a fourth field (an M4 reports `"proc 10:4:6:0"`), so we
/// read the leading `total:perf:eff` and ignore anything after.
fn parse_core_counts(raw: &str) -> (Option<u32>, Option<u32>, Option<u32>) {
    if let Some(token) = raw.split_whitespace().find(|t| t.contains(':')) {
        let nums: Vec<Option<u32>> = token.split(':').map(|n| n.parse().ok()).collect();
        if nums.len() >= 3 {
            return (nums[0], nums[1], nums[2]);
        }
    }
    let total = raw.split_whitespace().find_map(|t| t.parse::<u32>().ok());
    (total, None, None)
}

/// `"macOS 15.5 (24F74)"` → `"15.5"`. Returns `None` when nothing's left.
fn strip_os_version(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let without_prefix = trimmed.strip_prefix("macOS ").unwrap_or(trimmed);
    let version = without_prefix.split(" (").next().unwrap_or(without_prefix).trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// The slice of `system_profiler` JSON we care about. Every field is optional so
/// a missing key degrades to `None` rather than failing the whole parse.
#[derive(Deserialize)]
struct RawReport {
    #[serde(rename = "SPHardwareDataType", default)]
    hardware: Vec<RawHardware>,
    #[serde(rename = "SPSoftwareDataType", default)]
    software: Vec<RawSoftware>,
    #[serde(rename = "SPDisplaysDataType", default)]
    displays: Vec<RawDisplay>,
}

#[derive(Deserialize, Default)]
struct RawHardware {
    machine_name: Option<String>,
    /// Apple Silicon marketing name, e.g. "Apple M3 Pro".
    chip_type: Option<String>,
    /// Intel CPU name (older key), e.g. "Intel Core i7".
    cpu_type: Option<String>,
    physical_memory: Option<String>,
    /// String "proc t:p:e" on Apple Silicon, sometimes a bare integer on Intel.
    number_processors: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
struct RawSoftware {
    os_version: Option<String>,
}

/// One GPU from `SPDisplaysDataType`.
#[derive(Deserialize, Default)]
struct RawDisplay {
    /// Core count, reported as a *string* (e.g. `"10"`), not a number.
    sppci_cores: Option<String>,
    /// `"spdisplays_builtin"` for the integrated Apple Silicon GPU.
    sppci_bus: Option<String>,
}

#[cfg(test)]
mod tests;
