//! Live system telemetry for Anchor's benchmark suite.
//!
//! Unlike [`crate::Profiler`] (static, cached forever), everything here is a
//! point-in-time snapshot taken fresh around each benchmark run: thermal
//! pressure, power source, uptime, and free memory all drift within a session
//! in ways a benchmark result should carry. Same `std::process::Command` +
//! text-parse idiom as the rest of this crate — no new dependency.

use anchor_core::EnvTelemetry;

/// A live snapshot. `resident_model_count` is always `None` here — this crate
/// has no Ollama client; the caller (`anchor-hub`) fills it in from `/api/ps`.
pub fn snapshot() -> EnvTelemetry {
    EnvTelemetry {
        thermal_pressure_pct: thermal_pressure_pct(),
        thermal_level: thermal_level(),
        on_ac_power: on_ac_power(),
        uptime_secs: uptime_secs(),
        free_memory_bytes: free_memory_bytes(),
        resident_model_count: None,
    }
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(cmd).args(args).output().ok()?;
    String::from_utf8(output.stdout).ok()
}

/// The OS thermal pressure level — the only thermal signal Apple Silicon
/// publishes, and the same one `ProcessInfo.thermalState` reads.
///
/// `pmset -g therm` is Intel-era: on an Apple Silicon Mac it prints "No CPU
/// power status has been recorded" and [`thermal_pressure_pct`] is always
/// `None`, which left every benchmark labelled "unknown" on the app's primary
/// target. This reads libSystem's notify state instead: a register/get/cancel
/// triple with no subprocess and no new dependency.
///
/// Values are Apple's `OSThermalPressureLevel` (`<libkern/OSThermalNotification.h>`):
/// 0 nominal, 10 moderate, 20 heavy, 30 trapping, 40 sleeping.
fn thermal_level() -> Option<u8> {
    /// `kOSThermalNotificationPressureLevelName`.
    const KEY: &[u8] = b"com.apple.system.thermalpressurelevel\0";
    const NOTIFY_STATUS_OK: u32 = 0;

    extern "C" {
        fn notify_register_check(name: *const std::ffi::c_char, out_token: *mut i32) -> u32;
        fn notify_get_state(token: i32, state: *mut u64) -> u32;
        fn notify_cancel(token: i32) -> u32;
    }

    let mut token: i32 = 0;
    let mut state: u64 = 0;
    // SAFETY: `KEY` is a NUL-terminated literal, both out-params are stack
    // locals we own, and the token is cancelled on every path out.
    unsafe {
        if notify_register_check(KEY.as_ptr().cast(), &mut token) != NOTIFY_STATUS_OK {
            return None;
        }
        let rc = notify_get_state(token, &mut state);
        notify_cancel(token);
        (rc == NOTIFY_STATUS_OK).then(|| state.min(u8::MAX as u64) as u8)
    }
}

/// `pmset -g therm`'s `CPU_Speed_Limit`, percent. 100 = unthrottled.
fn thermal_pressure_pct() -> Option<u8> {
    parse_thermal_pressure_pct(&run("pmset", &["-g", "therm"])?)
}

fn parse_thermal_pressure_pct(raw: &str) -> Option<u8> {
    raw.lines()
        .find(|l| l.contains("CPU_Speed_Limit"))
        .and_then(|l| l.rsplit(|c: char| !c.is_ascii_digit()).find(|s| !s.is_empty()))
        .and_then(|n| n.parse().ok())
}

/// `pmset -g batt`'s power source, from its first line.
fn on_ac_power() -> Option<bool> {
    parse_on_ac_power(&run("pmset", &["-g", "batt"])?)
}

fn parse_on_ac_power(raw: &str) -> Option<bool> {
    let first = raw.lines().next()?;
    if first.contains("AC Power") {
        Some(true)
    } else if first.contains("Battery Power") {
        Some(false)
    } else {
        None
    }
}

/// Seconds since boot, from `sysctl kern.boottime`'s epoch diffed against now.
fn uptime_secs() -> Option<u64> {
    parse_uptime_secs(&run("sysctl", &["-n", "kern.boottime"])?, now_secs())
}

fn parse_uptime_secs(raw: &str, now: u64) -> Option<u64> {
    let boot: u64 = raw.split("sec = ").nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    now.checked_sub(boot)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// Free physical memory, from `vm_stat`'s "Pages free" × the reported page size.
fn free_memory_bytes() -> Option<u64> {
    parse_free_memory_bytes(&run("vm_stat", &[])?)
}

fn parse_free_memory_bytes(raw: &str) -> Option<u64> {
    let page_size: u64 = raw.lines().next()?.split("page size of ").nth(1)?.split_whitespace().next()?.parse().ok()?;
    let free_pages: u64 = raw
        .lines()
        .find(|l| l.starts_with("Pages free:"))?
        .split(':')
        .nth(1)?
        .trim()
        .trim_end_matches('.')
        .parse()
        .ok()?;
    Some(free_pages * page_size)
}

#[cfg(test)]
mod tests;
