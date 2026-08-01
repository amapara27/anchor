import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AgentRunDetail,
  GenerationStats,
  ResearchConfig,
  ResearchEvent,
  ResearchPhase,
} from "../types";

/** The agent id every run from this hook is filed under. */
const AGENT_ID = "research-assistant";

/** A phase transition and when it happened — folded into real trace durations. */
type Mark = { phase: string; at: number };

/** Frontend run state: the backend's `ResearchPhase` plus "idle"/"failed". */
type RunPhase = ResearchPhase | "idle" | "failed";

export interface ResearchState {
  phase: RunPhase;
  /** Planned search queries, in order. */
  queries: string[];
  /** Sources found, numbered as [1..] in the brief. */
  sources: { title: string; url: string }[];
  /** Synthesis text accumulated as it streams. */
  text: string;
  stats?: GenerationStats;
  error?: string;
}

const INITIAL: ResearchState = { phase: "idle", queries: [], sources: [], text: "" };

/** Fold one streamed `ResearchEvent` into the run state. */
function applyEvent(state: ResearchState, event: ResearchEvent): ResearchState {
  switch (event.kind) {
    case "status":
      return { ...state, phase: event.phase };
    case "query":
      return { ...state, queries: [...state.queries, event.text] };
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

/** Marks → per-phase wall time. The terminal `done` mark only closes the last
 *  real phase, so it carries no duration of its own. */
function tracePhases(marks: Mark[], endedMs: number): AgentRunDetail["phases"] {
  // Map before filtering: each duration reads the *next* mark, so dropping
  // entries first would shift every index by one.
  return marks
    .map((m, i) => ({ phase: m.phase, ms: (marks[i + 1]?.at ?? endedMs) - m.at }))
    .filter((p) => p.phase !== "done");
}

/**
 * Files a settled run in the history the Agents page reads. Best-effort: the
 * brief is already on screen, so a failed write must not surface as a run
 * failure.
 */
function saveRun(
  config: ResearchConfig,
  event: Extract<ResearchEvent, { kind: "result" | "failed" }>,
  ctx: { startedMs: number; queries: string[]; marks: Mark[] },
): void {
  const endedMs = Date.now();
  const failed = event.kind === "failed";
  const detail: AgentRunDetail = {
    output: failed ? "" : event.response,
    queries: ctx.queries,
    // Source bodies are dropped — the brief already quotes what mattered.
    sources: failed ? [] : event.sources.map((s) => ({ title: s.title, url: s.url })),
    phases: tracePhases(ctx.marks, endedMs),
    error: failed ? event.message : undefined,
  };
  invoke("save_agent_run", {
    run: {
      id: crypto.randomUUID(),
      agent_id: AGENT_ID,
      model: config.model,
      task: config.focus,
      status: failed ? "failed" : "completed",
      started_ms: ctx.startedMs,
      duration_ms: endedMs - ctx.startedMs,
      tokens: failed ? null : (event.stats.eval_count ?? null),
      detail_json: JSON.stringify(detail),
    },
  }).catch(() => {});
}

/**
 * Owns a single Research Assistant run: wires a Tauri `Channel`, reduces the
 * streamed events, persists the settled run, and evicts the model on
 * cancel/unmount. Mirrors `useComparison`'s channel + `runId` idiom.
 */
export function useResearch() {
  const [state, setState] = useState<ResearchState>(INITIAL);
  const runId = useRef(0);
  // The model still loaded server-side, so cancel/unmount can evict it. Cleared
  // once a run ends (backend used keep_alive:0, so it's already gone by then).
  const activeModel = useRef<string | null>(null);

  const running = !["idle", "done", "failed"].includes(state.phase);

  const unload = useCallback(() => {
    const model = activeModel.current;
    if (!model) return;
    activeModel.current = null;
    invoke("unload_model", { model }).catch(() => {}); // best-effort
  }, []);

  const run = useCallback((config: ResearchConfig) => {
    const myRun = ++runId.current;
    activeModel.current = config.model;
    setState({ ...INITIAL, phase: "planning" });

    // Run-local record of what gets stored. Kept in the closure rather than in
    // state so persisting never has to read through a setState updater.
    const startedMs = Date.now();
    const queries: string[] = [];
    const marks: Mark[] = [{ phase: "planning", at: startedMs }];

    const channel = new Channel<ResearchEvent>();
    channel.onmessage = (event) => {
      if (runId.current !== myRun) return; // stale run — ignore
      if (event.kind === "query") queries.push(event.text);
      if (event.kind === "status" && marks[marks.length - 1].phase !== event.phase) {
        marks.push({ phase: event.phase, at: Date.now() });
      }
      // Run finished: weights are already evicted (keep_alive:0), so don't
      // re-unload on a later reset/unmount.
      if (event.kind === "result" || event.kind === "failed") {
        activeModel.current = null;
        saveRun(config, event, { startedMs, queries, marks });
      }
      setState((s) => applyEvent(s, event));
    };

    invoke("run_research", { config, onEvent: channel }).catch((e) => {
      if (runId.current !== myRun) return;
      activeModel.current = null; // command failed before anything loaded
      setState((s) => ({ ...s, phase: "failed", error: String(e) }));
    });
  }, []);

  const reset = useCallback(() => {
    runId.current++; // invalidate in-flight events
    unload(); // cancelling mid-run: evict the loaded model
    setState(INITIAL);
  }, [unload]);

  // Navigating away mid-run must not strand a loaded model.
  useEffect(() => () => unload(), [unload]);

  return { state, running, run, reset };
}
