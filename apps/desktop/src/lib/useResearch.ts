import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  GenerationStats,
  ResearchConfig,
  ResearchEvent,
  ResearchPhase,
} from "../types";

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

/**
 * Owns a single Research Assistant run: wires a Tauri `Channel`, reduces the
 * streamed events, and evicts the model on cancel/unmount. Mirrors
 * `useComparison`'s channel + `runId` idiom.
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

    const channel = new Channel<ResearchEvent>();
    channel.onmessage = (event) => {
      if (runId.current !== myRun) return; // stale run — ignore
      // Run finished: weights are already evicted (keep_alive:0), so don't
      // re-unload on a later reset/unmount.
      if (event.kind === "result" || event.kind === "failed") activeModel.current = null;
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
