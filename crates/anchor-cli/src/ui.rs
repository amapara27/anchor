//! Terminal drawing primitives for the progress lines.
//!
//! Small string widgets shared by direct commands and the terminal workspace.
//! `Progress` owns transient stderr output so permanent statuses never join a
//! live frame; the workspace itself has one Ratatui renderer.
//!
//! Everything degrades on its own: when stdout is not a terminal,
//! `progress_line` prints plain lines instead of overwriting, and callers gate
//! the animated widgets on [`crate::is_terminal`] so a redirected run doesn't
//! collect thousands of sparkline frames.

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicUsize, Ordering};

/// One owner for transient stderr output; status messages cannot join a live frame.
#[derive(Default)]
pub struct Progress {
    active: bool,
}

impl Progress {
    pub fn line(&mut self, text: &str) {
        self.active = false;
        message(text);
    }

    pub fn frame(&mut self, text: &str) {
        if std::io::stderr().is_terminal() {
            eprint!("\r\x1b[2K{text}");
            let _ = std::io::stderr().flush();
            self.active = true;
        }
    }

    fn clear(&mut self) {
        if self.active {
            eprint!("\r\x1b[2K");
            let _ = std::io::stderr().flush();
            self.active = false;
        }
    }
}

pub fn message(text: &str) {
    if std::io::stderr().is_terminal() {
        eprintln!("\r\x1b[2K{text}");
    } else {
        eprintln!("{text}");
    }
}

impl Drop for Progress {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Braille spinner frames — one glyph wide in every monospace font, unlike the
/// `|/-\` ASCII cycle, which visibly changes width as it turns.
pub const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// Advanced by the caller, not a clock, so the spinner only turns when there is
/// genuinely new progress to show — a frozen spinner is honest about a stall.
static TICK: AtomicUsize = AtomicUsize::new(0);

/// The next spinner frame.
pub fn spinner() -> char {
    SPINNER[TICK.fetch_add(1, Ordering::Relaxed) % SPINNER.len()]
}

/// A determinate progress bar, `width` cells wide. `fraction` is clamped, so a
/// server reporting more bytes than it promised can't overrun the line.
pub fn bar(fraction: f64, width: usize) -> String {
    let filled = ((fraction.clamp(0.0, 1.0)) * width as f64).round() as usize;
    format!(
        "{}{}",
        "█".repeat(filled),
        "░".repeat(width.saturating_sub(filled))
    )
}

/// Block-character levels, lowest to highest.
const LEVELS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/// A sparkline of the last `width` values, scaled to the window's own maximum.
///
/// Scaled to the window rather than to an absolute ceiling: a benchmark's decode
/// rate is only interesting relative to itself, and a fixed ceiling would flatten
/// every small model into one indistinguishable row of `▁`. An all-equal window
/// renders at the top rather than the bottom — a steady fast rate reading as an
/// empty line would be exactly backwards.
pub fn sparkline(values: &[f64], width: usize) -> String {
    let window = &values[values.len().saturating_sub(width)..];
    if window.is_empty() {
        return String::new();
    }
    let max = window.iter().copied().fold(f64::MIN, f64::max);
    if max <= 0.0 {
        return LEVELS[0].to_string().repeat(window.len());
    }
    window
        .iter()
        .map(|v| {
            let level = ((v / max) * (LEVELS.len() - 1) as f64).round() as usize;
            LEVELS[level.min(LEVELS.len() - 1)]
        })
        .collect()
}
