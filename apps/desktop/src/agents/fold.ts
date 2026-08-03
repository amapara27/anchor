/**
 * The pure half of a run: folding streamed events into state, and turning phase
 * transitions into real per-phase durations.
 *
 * Split out of `useAgent.ts` so it carries no React or Tauri import and can be
 * exercised by `fold.selfcheck.ts`.
 */
import type { AgentRunDetail } from "../types.ts";
import type { AgentEvent, AgentState } from "./types.ts";

/** A phase transition and when it happened. */
export type Mark = { phase: string; at: number };

export const INITIAL: AgentState = { phase: "idle", notes: [], sources: [], text: "" };

/** Phases that end a run. Anything else means work is still in flight. */
export const TERMINAL = ["idle", "done", "failed"];

/** Fold one streamed event into the run state. */
export function applyEvent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.kind) {
    case "status":
      return { ...state, phase: event.phase };
    case "note":
      return { ...state, notes: [...state.notes, { label: event.label, text: event.text }] };
    case "source":
      return { ...state, sources: [...state.sources, { title: event.title, url: event.url }] };
    case "token":
      return { ...state, text: state.text + event.text };
    case "result":
      return { ...state, phase: "done", text: event.response, stats: event.stats };
    case "failed":
      return { ...state, phase: "failed", error: event.message };
  }
}

/**
 * Marks → per-phase wall time. The terminal `done` mark only closes the last
 * real phase, so it carries no duration of its own.
 */
export function tracePhases(marks: Mark[], endedMs: number): AgentRunDetail["phases"] {
  // Map before filtering: each duration reads the *next* mark, so dropping
  // entries first would shift every index by one.
  return marks
    .map((m, i) => ({ phase: m.phase, ms: (marks[i + 1]?.at ?? endedMs) - m.at }))
    .filter((p) => p.phase !== "done");
}

/**
 * Appends a transition, ignoring a repeat of the phase already in flight — the
 * trace should have one entry per real phase, not one per status event.
 */
export function mark(marks: Mark[], phase: string, at: number): void {
  if (marks[marks.length - 1]?.phase !== phase) marks.push({ phase, at });
}
