// The benchmark suite's scenario catalog, for display and for scoping a
// leaderboard to one shape.
//
// **Mirrors `crates/anchor-hub/src/bench/prompts.rs`** — ids, token counts, and
// labels must match it exactly, the same way `kv.ts`/`fit.ts` mirror
// `anchor_core::fit`. Context is derived by the same formula on both sides
// rather than restated, so at least that number can't drift.

/** `anchor_hub::bench::SUITE_ID`. Rows from retired suites are never queried. */
export const SUITE_ID = "anchor-scenarios";

/** The scenario the page header, the share card, and the hardware-truth engine
 *  all read — one canonical number per model instead of nine. */
export const HEADLINE_SCENARIO = "balanced";

export interface Scenario {
  id: string;
  label: string;
  promptTokens: number;
  genTokens: number;
}

export const SCENARIOS: Scenario[] = [
  { id: "classify", label: "Classification, sentiment, keyword extraction", promptTokens: 768, genTokens: 32 },
  { id: "summarize", label: "Article summarization, contextual paragraphs", promptTokens: 1536, genTokens: 256 },
  { id: "expand", label: "Prompt expansion, explanation generation", promptTokens: 320, genTokens: 1280 },
  { id: "creative", label: "Storytelling, short-prompt creative writing", promptTokens: 32, genTokens: 1536 },
  { id: "balanced", label: "Balanced Q&A, content drafting, code generation", promptTokens: 896, genTokens: 1024 },
  { id: "rag", label: "Long-document Q&A, retrieval-augmented generation", promptTokens: 3584, genTokens: 320 },
  { id: "draft", label: "Detailed replies, multi-paragraph sections", promptTokens: 1792, genTokens: 640 },
  { id: "reasoning", label: "Chain-of-thought, long-form reasoning", promptTokens: 1536, genTokens: 2560 },
  { id: "codegen", label: "Code generation, functions and test authoring", promptTokens: 1024, genTokens: 1536 },
];

/** `CTX_MARGIN` in `prompts.rs`. */
const CTX_MARGIN = 64;

/** Context the scenario runs at: prompt + generation + margin, rounded up to a
 *  power of two. Same derivation as `Scenario::num_ctx` in Rust. */
export function numCtxFor(s: Scenario): number {
  return 2 ** Math.ceil(Math.log2(s.promptTokens + s.genTokens + CTX_MARGIN));
}

/** Catalog order for display: cheapest context tier first, then by how much
 *  each generates — the same order the suite runs them in. */
export const SCENARIOS_BY_COST = [...SCENARIOS].sort(
  (a, b) => numCtxFor(a) - numCtxFor(b) || a.genTokens - b.genTokens,
);

export const scenarioLabel = (id: string | null): string =>
  SCENARIOS.find((s) => s.id === id)?.label ?? id ?? "—";
