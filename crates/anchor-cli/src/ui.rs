//! Terminal drawing primitives for the progress lines.
//!
//! Deliberately tiny and dependency-free: a spinner, a bar, and a sparkline,
//! all rendered into a `String` that [`crate::progress_line`] paints over the
//! previous one. No `indicatif`/`crossterm` — nothing here needs cursor
//! addressing, colour negotiation, or a redraw thread, and a progress widget is
//! not worth a dependency tree.
//!
//! Everything degrades on its own: when stdout is not a terminal,
//! `progress_line` prints plain lines instead of overwriting, and callers gate
//! the animated widgets on [`crate::is_terminal`] so a redirected run doesn't
//! collect thousands of sparkline frames.

use std::sync::atomic::{AtomicUsize, Ordering};

/// Braille spinner frames — one glyph wide in every monospace font, unlike the
/// `|/-\` ASCII cycle, which visibly changes width as it turns.
const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
    format!("{}{}", "█".repeat(filled), "░".repeat(width.saturating_sub(filled)))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_widgets_handle_empty_and_out_of_range_input() {
        for fraction in [-1.0, 0.0, 0.5, 1.0, 42.0, f64::NAN] {
            assert_eq!(bar(fraction, 20).chars().count(), 20);
        }
        assert_eq!(sparkline(&[], 12), "");
        assert_eq!(sparkline(&[0.0, 0.0], 12), "▁▁");
        assert_eq!(sparkline(&[0.0, 50.0, 100.0], 2), "▅█");
    }
}
