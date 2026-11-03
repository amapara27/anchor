//! The suite's scenario catalog.
//!
//! A scenario is a (prompt tokens, generation tokens) pair with a use case
//! attached — the shape `llama-bench` calls `pp`/`tg`. Context size is not a
//! separate axis: it is derived from what the scenario itself needs, so a
//! scenario can never fail to fit the context it runs in.
//!
//! Pure and I/O-free on purpose: the sizing and grouping logic is the part
//! most worth unit-testing in isolation, without a live Ollama server.
//!
//! **Mirrored in `apps/desktop/src/lib/scenarios.ts` (`SCENARIOS`)** for display
//! only — ids, token counts, and labels must stay in sync, and
//! `the_typescript_mirror_matches_this_catalog` below reads that file and fails
//! on drift.

/// Bump when the catalog's *structure* changes (scenarios added/removed,
/// context derivation, repeat policy) or the result calculation method changes.
pub const SUITE_ID: &str = "anchor-scenarios";
pub const SUITE_VERSION: u32 = 5;
/// Bump when a scenario's prompt *text* changes without changing its shape.
pub const PROMPT_CATALOG_VERSION: u32 = 1;
/// The scenario model rows quote and the app's quick measure runs. Mirrors
/// the frontend's `HEADLINE_SCENARIO` in `lib/scenarios.ts`.
pub const HEADLINE_SCENARIO: &str = "balanced";

/// Headroom over prompt + generation before rounding up to a power of two, so
/// a token-estimate that runs slightly long can't overflow the context.
const CTX_MARGIN: u32 = 64;

/// Rough bytes per token for the filler prose below. Only used to size the
/// padding — Ollama reports the real `prompt_eval_count`.
const CHARS_PER_TOKEN: usize = 4;

/// Repeats behind a scenario's median.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepeatsMode {
    /// 3 repeats everywhere.
    Thorough,
    /// 1 repeat for the long-generation scenarios (their output dominates the
    /// suite's wall-clock time), 3 for the rest.
    Fast,
}

/// Generation length at or above which `Fast` drops to a single repeat. Keyed
/// on the token count rather than a scenario id so a new scenario can't slip
/// past the policy.
const HEAVY_GEN_TOKENS: u32 = 1024;

pub struct Scenario {
    pub id: &'static str,
    /// What this shape is for, shown in the UI next to the numbers.
    pub label: &'static str,
    pub prompt_tokens: u32,
    pub gen_tokens: u32,
    /// The actual task. Padded out to `prompt_tokens` with filler when it is
    /// shorter than the budget.
    instruction: &'static str,
}

pub const CATALOG: [Scenario; 9] = [
    Scenario {
        id: "classify",
        label: "Classification, sentiment, keyword extraction",
        prompt_tokens: 768,
        gen_tokens: 32,
        instruction: "Classify the passage above as one of: technical, historical, or commercial. \
                      Then list the three keywords that best characterise it. Answer in one line.",
    },
    Scenario {
        id: "summarize",
        label: "Article summarization, contextual paragraphs",
        prompt_tokens: 1536,
        gen_tokens: 256,
        instruction: "Summarize the passage above in a single paragraph. Keep the central claims \
                      and drop the illustrative detail.",
    },
    Scenario {
        id: "expand",
        label: "Prompt expansion, explanation generation",
        prompt_tokens: 320,
        gen_tokens: 1280,
        instruction: "Using the passage above as background, write a thorough explanation of the \
                      subject for a reader encountering it for the first time. Work through a \
                      concrete example rather than staying abstract.",
    },
    Scenario {
        id: "creative",
        label: "Storytelling, short-prompt creative writing",
        prompt_tokens: 32,
        gen_tokens: 1536,
        instruction: "Write the opening scene of a story about a lighthouse keeper who finds a \
                      letter bearing no postmark, no sender, and tomorrow's date.",
    },
    Scenario {
        id: "balanced",
        label: "Balanced Q&A, content drafting, code generation",
        prompt_tokens: 896,
        gen_tokens: 1024,
        instruction: "Answer the question the passage above raises, then draft a short section of \
                      documentation covering it, including one worked code example.",
    },
    Scenario {
        id: "rag",
        label: "Long-document Q&A, retrieval-augmented generation",
        prompt_tokens: 3584,
        gen_tokens: 320,
        instruction: "Answer using only the passage above: what changed, why it mattered, and what \
                      it displaced? Cite the sentences you relied on.",
    },
    Scenario {
        id: "draft",
        label: "Detailed replies, multi-paragraph sections",
        prompt_tokens: 1792,
        gen_tokens: 640,
        instruction: "Draft a detailed reply to a colleague who sent the passage above, covering \
                      what you agree with, what you would push back on, and what you would do next.",
    },
    Scenario {
        id: "reasoning",
        label: "Chain-of-thought, long-form reasoning",
        prompt_tokens: 1536,
        gen_tokens: 2560,
        instruction: "Reason step by step about the passage above: identify the causal chain it \
                      describes, test each link against the evidence given, and state where the \
                      argument is weakest before giving your conclusion.",
    },
    Scenario {
        id: "codegen",
        label: "Code generation, functions and test authoring",
        prompt_tokens: 1024,
        gen_tokens: 1536,
        instruction: "Using the passage above as the spec, write a well-documented function that \
                      implements it, including type hints, a docstring, and two unit tests that \
                      exercise its edge cases.",
    },
];

/// Neutral filler. Deliberately dull and self-contained: it pads a prompt to a
/// target length without steering the model toward a longer or shorter answer.
const FILLER: &str = "The history of the printing press begins with the observation that movable \
    type could reproduce a page far faster than a scribe copying it by hand, and that a single set \
    of cast letters could be rearranged indefinitely rather than carved anew for every new text. ";

impl Scenario {
    /// Context to load with: enough for the prompt, the capped output, and a
    /// margin — rounded up to a power of two so scenarios share context tiers
    /// and the model reloads a handful of times, not once per scenario.
    pub fn num_ctx(&self) -> u32 {
        (self.prompt_tokens + self.gen_tokens + CTX_MARGIN).next_power_of_two()
    }

    /// The prompt text: filler padded to `prompt_tokens`, then the instruction,
    /// so the model has to attend to the padding rather than echo its tail.
    /// An instruction already at budget is used unpadded.
    pub fn text(&self) -> String {
        let budget = self.prompt_tokens as usize * CHARS_PER_TOKEN;
        let Some(pad) = budget.checked_sub(self.instruction.len() + 2) else {
            return self.instruction.to_string();
        };
        // FILLER is ASCII, so truncating on a byte index is char-safe.
        let mut text = FILLER.repeat(pad / FILLER.len() + 1);
        text.truncate(pad);
        text.push_str("\n\n");
        text.push_str(self.instruction);
        text
    }
}

/// Scenarios grouped by context size, ascending, so the suite reloads the model
/// once per distinct context rather than once per scenario — Ollama reloads on
/// a `num_ctx` change, not on a prompt change.
pub fn grouped_by_ctx() -> Vec<(u32, Vec<&'static Scenario>)> {
    let mut groups: Vec<(u32, Vec<&'static Scenario>)> = Vec::new();
    let mut sorted: Vec<&'static Scenario> = CATALOG.iter().collect();
    sorted.sort_by_key(|s| (s.num_ctx(), s.gen_tokens));
    for scenario in sorted {
        let ctx = scenario.num_ctx();
        match groups.last_mut() {
            Some((c, group)) if *c == ctx => group.push(scenario),
            _ => groups.push((ctx, vec![scenario])),
        }
    }
    groups
}

/// Repeats for one scenario under the chosen mode.
pub fn repeats_for(scenario: &Scenario, mode: RepeatsMode) -> u32 {
    match mode {
        RepeatsMode::Fast if scenario.gen_tokens >= HEAVY_GEN_TOKENS => 1,
        _ => 3,
    }
}
