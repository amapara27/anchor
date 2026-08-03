/**
 * The shared agent contract: one streamed event union and one registry entry
 * shape, so every agent plugs into the Agents page the same way.
 *
 * The Research Assistant predates this and keeps its own richer `ResearchEvent`
 * in `types.ts` — it is registered here by adapting its existing component
 * rather than by being rewritten.
 */
import type { GenerationStats } from "../types";

/**
 * One streamed event from any agent. Mirrors `anchor_workflows::AgentEvent`
 * (serde-tagged on `kind`).
 */
export type AgentEvent =
  /** A lifecycle transition; consecutive transitions become the run's trace. */
  | { kind: "status"; phase: string }
  /** Something worth showing mid-run — a query, a file read, a chunk. */
  | { kind: "note"; label: string; text: string }
  /** A citable source, numbered in arrival order. */
  | { kind: "source"; title: string; url: string }
  /** One streamed answer delta. */
  | { kind: "token"; text: string }
  /** The finished answer. Sources are not repeated — they already arrived. */
  | { kind: "result"; response: string; stats: GenerationStats }
  /** The run failed. */
  | { kind: "failed"; message: string };

/** Live state of one agent run, folded from the event stream. */
export interface AgentState {
  /** The current phase, or `idle` before a run and `failed` after a failure. */
  phase: string;
  notes: { label: string; text: string }[];
  sources: { title: string; url: string }[];
  /** Answer text accumulated as it streams. */
  text: string;
  stats?: GenerationStats;
  error?: string;
}

/** How one phase renders in the stepper and the run inspector's trace. */
export interface PhaseMeta {
  /** Short label, e.g. "Searching". */
  label: string;
  /** What actually happens in it, shown in the run inspector. */
  detail: string;
  /** A `var(--…)` design token. Never a raw colour. */
  color: string;
}

/**
 * What an agent contributes to the Agents page. Each agent's own `index.ts` is
 * the only place this is declared, which is what keeps agents mergeable when
 * several are built at once.
 */
export interface AgentEntry {
  /** Matches the template id in `lib/workflows.ts` and the stored `agent_id`. */
  id: string;
  /** The full-page panel launched from the agent's card. */
  Panel: (props: { onBack: () => void }) => React.ReactNode;
  /** Whether the card's "Spin up" is live. `false` keeps it disabled. */
  ready: boolean;
  /** Phase id → how it renders, in lifecycle order. */
  phases: Record<string, PhaseMeta>;
}
