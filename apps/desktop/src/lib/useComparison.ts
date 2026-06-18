import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { CompareEvent, GenerationStats, PullProgress, Slot } from "../types";

/** Lifecycle of one model's run, frontend-side. Adds "downloading" (driven by
 * pull events) and "idle" to the backend's `Phase`. */
export type SlotPhase =
  | "idle"
  | "queued"
  | "downloading"
  | "loading"
  | "generating"
  | "done"
  | "failed";

export interface SlotState {
  phase: SlotPhase;
  /** Real download progress while the model is being pulled. */
  pull?: PullProgress;
  /** Tokens accumulated as they stream — intentionally NOT shown until reveal. */
  buffer: string;
  /** Final response text once the slot completes. */
  response?: string;
  stats?: GenerationStats;
  error?: string;
}

interface ComparisonState {
  a: SlotState;
  b: SlotState;
}

const IDLE_SLOT: SlotState = { phase: "idle", buffer: "" };
const INITIAL: ComparisonState = { a: IDLE_SLOT, b: IDLE_SLOT };

/** A slot has nothing left to do. */
function isTerminal(phase: SlotPhase): boolean {
  return phase === "done" || phase === "failed";
}

/** Fold one streamed `CompareEvent` into the per-slot state. */
function applyEvent(state: ComparisonState, event: CompareEvent): ComparisonState {
  const key: Slot = event.slot;
  const cur = state[key];
  let next: SlotState;
  switch (event.kind) {
    case "pull":
      next = { ...cur, phase: "downloading", pull: event.progress };
      break;
    case "status":
      // Leaving the download phase: drop the stale pull progress.
      next = { ...cur, phase: event.phase, pull: undefined };
      break;
    case "token":
      next = { ...cur, buffer: cur.buffer + event.text };
      break;
    case "result":
      next = { ...cur, phase: "done", response: event.response, stats: event.stats };
      break;
    case "failed":
      next = { ...cur, phase: "failed", error: event.message };
      break;
  }
  return { ...state, [key]: next };
}

/**
 * Owns a single Model Comparison run: wires a Tauri `Channel`, reduces streamed
 * events into per-slot state, and flips `revealed` once both models finish so the
 * page can type both responses out together. Mirrors `useModels`'s channel idiom;
 * a `runId` ref drops late events from a previous/reset run.
 */
export function useComparison() {
  const [{ a, b }, setState] = useState<ComparisonState>(INITIAL);
  const [running, setRunning] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const runId = useRef(0);

  const run = useCallback((modelA: string, modelB: string, prompt: string) => {
    const myRun = ++runId.current;
    setState({ a: { ...IDLE_SLOT, phase: "queued" }, b: { ...IDLE_SLOT, phase: "queued" } });
    setRevealed(false);
    setRunning(true);

    const channel = new Channel<CompareEvent>();
    channel.onmessage = (event) => {
      if (runId.current !== myRun) return; // stale run — ignore
      setState((s) => applyEvent(s, event));
    };

    invoke("compare_models", { modelA, modelB, prompt, onEvent: channel }).catch((e) => {
      if (runId.current !== myRun) return;
      // Command-level failure (e.g. Ollama unreachable): fail whichever slots
      // haven't already reported a per-slot result.
      const message = String(e);
      setState((s) => ({
        a: isTerminal(s.a.phase) ? s.a : { ...s.a, phase: "failed", error: message },
        b: isTerminal(s.b.phase) ? s.b : { ...s.b, phase: "failed", error: message },
      }));
      setRunning(false);
    });
  }, []);

  const reset = useCallback(() => {
    runId.current++; // invalidate any in-flight run's events
    setState(INITIAL);
    setRunning(false);
    setRevealed(false);
  }, []);

  // Both models finished → stop running and trigger the simultaneous reveal.
  useEffect(() => {
    if (running && isTerminal(a.phase) && isTerminal(b.phase)) {
      setRunning(false);
      setRevealed(true);
    }
  }, [running, a.phase, b.phase]);

  return { a, b, running, revealed, run, reset };
}
