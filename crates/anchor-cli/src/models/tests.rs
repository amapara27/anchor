//! Table-cell formatting for the models listings. Kept in their own file so the
//! browse/discover logic above stays readable.

use super::*;

// Truncation has to be a no-op at exactly the column width, or every full-width
// cell would lose its last character to an ellipsis it didn't need.
#[test]
fn a_string_that_fits_is_left_alone() {
    assert_eq!(clip("llama3.2:1b", 20), "llama3.2:1b");
    assert_eq!(clip("exactly-ten", 11), "exactly-ten");
}

#[test]
fn an_overlong_string_is_cut_to_the_column_width() {
    // The ellipsis occupies the last column, so the result is `max` wide, not
    // `max + 1` — a table that widened by a column here would shear.
    let clipped = clip("registry.ollama.ai/library/llama3.1", 10);
    assert_eq!(clipped, "registry.…");
    assert_eq!(clipped.chars().count(), 10, "the result must fit the column");
}

// `max - 1` on a usize underflows and panics. No caller passes 0 today, but a
// zero-width column is arithmetic away from one that does.
#[test]
fn a_zero_width_column_yields_nothing_rather_than_panicking() {
    assert_eq!(clip("anything", 0), "");
}

// Counting bytes instead of chars would both mis-measure the fit and slice a
// multibyte character in half, which panics on a char boundary.
#[test]
fn truncation_counts_characters_not_bytes() {
    // 11 chars, 22 bytes.
    let cjk = "模型模型模型模型模型模";
    assert_eq!(clip(cjk, 11), cjk, "11 chars fits an 11-column cell");
    assert_eq!(clip(cjk, 5), "模型模型…");
}

#[test]
fn pull_counts_use_the_libraries_own_shorthand() {
    assert_eq!(fmt_count(118_100_000), "118.1M");
    assert_eq!(fmt_count(2_400_000_000), "2.4B");
    assert_eq!(fmt_count(15_300), "15.3K");
}

// Each threshold belongs to the larger unit; an off-by-one renders 1000 pulls
// as "1000" in a column sized for "1.0K".
#[test]
fn each_magnitude_boundary_rolls_over() {
    assert_eq!(fmt_count(999), "999");
    assert_eq!(fmt_count(1_000), "1.0K");
    assert_eq!(fmt_count(999_999), "1000.0K");
    assert_eq!(fmt_count(1_000_000), "1.0M");
    assert_eq!(fmt_count(1_000_000_000), "1.0B");
}
