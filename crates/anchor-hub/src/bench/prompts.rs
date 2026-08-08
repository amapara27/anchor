//! The Full suite's prompt catalog and context-size matrix.
//!
//! Pure and I/O-free on purpose: the feasibility filter and grouping logic are
//! the part most worth unit-testing in isolation, without a live Ollama server.

/// Suite id for the Full (multi-prompt, multi-context) suite, distinct from
/// [`super::SUITE_ID`] (`"anchor-std"`, the single-prompt Quick suite).
pub const FULL_SUITE_ID: &str = "anchor-full";
/// Bump when the matrix/repeat *logic* changes (context sizes, feasibility
/// rule, cell structure). Independent of [`PROMPT_CATALOG_VERSION`], which
/// versions the prompt *text*.
pub const FULL_SUITE_VERSION: u32 = 1;
/// Bump when `SHORT`/`LONG_CONTEXT`/`GENERATION_HEAVY`'s text changes.
pub const PROMPT_CATALOG_VERSION: u32 = 1;

/// Context sizes the Full matrix is evaluated at. 4096 matches the Quick
/// suite's `SUITE_NUM_CTX` (so that cell is roughly comparable to Quick);
/// 8192/16384 are large enough to show KV-cache/bandwidth cost growing even
/// for prompts that don't need the extra room — Ollama allocates KV for the
/// full `num_ctx` regardless of how much of it a prompt actually uses.
const FULL_CTX_SIZES: [u32; 3] = [4096, 8192, 16384];

/// Repeats behind a Full-mode cell's median.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepeatsMode {
    /// 3 repeats everywhere, matching the Quick suite's rigor.
    Thorough,
    /// 3 repeats on the cheap prompts, 1 on `generation_heavy` (its 1000-token
    /// output dominates a Full run's wall-clock time across 3 context sizes).
    Fast,
}

struct PromptSpec {
    id: &'static str,
    text: fn() -> String,
    /// Hand-estimated input length, used only to decide whether a cell fits a
    /// given `num_ctx` — not fed to Ollama, which reports the real count.
    input_tokens_estimate: u32,
    num_predict: u64,
}

const SHORT: PromptSpec = PromptSpec {
    id: "short",
    text: short_text,
    input_tokens_estimate: 100,
    num_predict: 200,
};
const LONG_CONTEXT: PromptSpec = PromptSpec {
    id: "long_context",
    text: long_context_text,
    input_tokens_estimate: 4000,
    num_predict: 200,
};
const GENERATION_HEAVY: PromptSpec = PromptSpec {
    id: "generation_heavy",
    text: generation_heavy_text,
    input_tokens_estimate: 50,
    num_predict: 1000,
};

const CATALOG: [&PromptSpec; 3] = [&SHORT, &LONG_CONTEXT, &GENERATION_HEAVY];

fn short_text() -> String {
    "You are helping a new engineer understand a codebase. Explain what a hash \
     table is, how it achieves average O(1) lookup, and describe one real \
     situation where you'd reach for one over a sorted array or a tree map. \
     Keep the explanation grounded in a concrete example rather than abstract \
     definitions."
        .to_string()
}

fn generation_heavy_text() -> String {
    "Write a detailed, thorough explanation of how transformer self-attention \
     works, covering the mathematical formulation, multi-head attention, and \
     why scaling the dot product matters."
        .to_string()
}

/// Deterministic, no file I/O: repeats a fixed neutral filler paragraph to
/// roughly `input_tokens_estimate` tokens (~4 chars/token), then appends a
/// fixed question so the model has to actually attend to the text, not just
/// echo the tail of it.
fn long_context_text() -> String {
    const FILLER: &str = "The history of the printing press begins with the \
        observation that movable type could reproduce a page far faster than \
        a scribe copying it by hand, and that a single set of cast letters \
        could be rearranged indefinitely rather than carved anew for every \
        new text. ";
    // ~4000 tokens * ~4 chars/token ≈ 16000 chars.
    let mut s = FILLER.repeat(16_000 / FILLER.len() + 1);
    s.push_str("\n\nSummarize the key theme of the passage above in two sentences.");
    s
}

/// One (prompt, context size) cell of the Full matrix.
pub struct Cell {
    id: &'static str,
    text_fn: fn() -> String,
    pub num_ctx: u32,
    pub num_predict: u64,
}

impl Cell {
    pub fn prompt_id(&self) -> &'static str {
        self.id
    }

    pub fn text(&self) -> String {
        (self.text_fn)()
    }
}

/// The feasibility-filtered matrix: a cell only runs if the prompt's
/// estimated input plus its capped output plausibly fits `num_ctx`, with a
/// safety margin for estimation error. `long_context` (~4000 in + 200 out)
/// doesn't fit at 4096, so that cell is skipped rather than run truncated.
pub fn full_matrix() -> Vec<Cell> {
    const SAFETY_MARGIN: u32 = 64;
    FULL_CTX_SIZES
        .iter()
        .flat_map(|&ctx| {
            CATALOG.iter().filter_map(move |p| {
                let needed = p.input_tokens_estimate + p.num_predict as u32 + SAFETY_MARGIN;
                (needed <= ctx).then_some(Cell {
                    id: p.id,
                    text_fn: p.text,
                    num_ctx: ctx,
                    num_predict: p.num_predict,
                })
            })
        })
        .collect()
}

/// Groups cells by `num_ctx`, in ascending order, so a Full run reloads the
/// model once per distinct context size rather than once per cell — Ollama
/// reloads on a `num_ctx` change, not on a prompt change.
pub fn grouped_by_ctx(cells: Vec<Cell>) -> Vec<(u32, Vec<Cell>)> {
    let mut groups: Vec<(u32, Vec<Cell>)> = Vec::new();
    for cell in cells {
        match groups.last_mut() {
            Some((ctx, group)) if *ctx == cell.num_ctx => group.push(cell),
            _ => groups.push((cell.num_ctx, vec![cell])),
        }
    }
    groups
}

/// Repeats for a cell given the toggle: `generation_heavy` gets 1 in Fast / 3
/// in Thorough (it's the expensive one — 1000 tokens out, three context
/// sizes); everything else always gets 3, since it's cheap either way.
pub fn repeats_for(prompt_id: &str, mode: RepeatsMode) -> u32 {
    match (prompt_id, mode) {
        ("generation_heavy", RepeatsMode::Fast) => 1,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_context_is_skipped_at_4096_but_included_at_larger_sizes() {
        let matrix = full_matrix();
        assert!(!matrix.iter().any(|c| c.prompt_id() == "long_context" && c.num_ctx == 4096));
        assert!(matrix.iter().any(|c| c.prompt_id() == "long_context" && c.num_ctx == 8192));
        assert!(matrix.iter().any(|c| c.prompt_id() == "long_context" && c.num_ctx == 16384));
    }

    #[test]
    fn short_and_generation_heavy_run_at_every_context_size() {
        let matrix = full_matrix();
        for ctx in FULL_CTX_SIZES {
            assert!(matrix.iter().any(|c| c.prompt_id() == "short" && c.num_ctx == ctx));
            assert!(matrix.iter().any(|c| c.prompt_id() == "generation_heavy" && c.num_ctx == ctx));
        }
    }

    #[test]
    fn matrix_has_exactly_eight_feasible_cells() {
        // 3 prompts x 3 ctx sizes, minus the one infeasible cell
        // (long_context @ 4096).
        assert_eq!(full_matrix().len(), 8);
    }

    #[test]
    fn cells_group_by_ascending_ctx_without_splitting_a_ctx_across_groups() {
        let groups = grouped_by_ctx(full_matrix());
        let ctxs: Vec<u32> = groups.iter().map(|(ctx, _)| *ctx).collect();
        assert_eq!(ctxs, vec![4096, 8192, 16384]);
        // 4096 only fits short + generation_heavy (long_context excluded).
        assert_eq!(groups[0].1.len(), 2);
        assert_eq!(groups[1].1.len(), 3);
        assert_eq!(groups[2].1.len(), 3);
    }

    #[test]
    fn repeats_for_generation_heavy_drops_to_one_in_fast_mode() {
        assert_eq!(repeats_for("generation_heavy", RepeatsMode::Fast), 1);
        assert_eq!(repeats_for("generation_heavy", RepeatsMode::Thorough), 3);
        assert_eq!(repeats_for("short", RepeatsMode::Fast), 3);
        assert_eq!(repeats_for("long_context", RepeatsMode::Fast), 3);
    }
}
