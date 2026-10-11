import { useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { BenchProgress } from "../types";
import { HEADLINE_SCENARIO } from "./scenarios";
import { MEASUREMENTS_EVENT } from "./useMeasurements";
import { recordUse } from "./lastUsed";

interface QuickMeasure {
  /** Model being measured, or null when idle. */
  running: string | null;
  failed: { model: string; message: string } | null;
}

// ponytail: module store so a run started from the inspector survives it
// unmounting on selection change. It shares the backend's single bench cancel
// flag with BenchmarksPage, so Stop stops whichever run holds the lock.
let state: QuickMeasure = { running: null, failed: null };
const listeners = new Set<() => void>();

function set(next: QuickMeasure) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Runs only the headline scenario, so its row is the one a full suite would store. */
export function startQuickMeasure(model: string) {
  if (state.running) return;
  recordUse(model);
  set({ running: model, failed: null });
  const channel = new Channel<BenchProgress>();
  channel.onmessage = (event) => {
    if (event.kind === "done") {
      set({ running: null, failed: null });
      window.dispatchEvent(new Event(MEASUREMENTS_EVENT));
    } else if (event.kind === "failed") {
      set({ running: null, failed: { model, message: event.message } });
    }
  };
  invoke("run_benchmark", { model, repeats: "fast", scenario: HEADLINE_SCENARIO, onEvent: channel }).catch((e) => {
    if (state.running === model) set({ running: null, failed: { model, message: String(e) } });
  });
}

export function stopQuickMeasure() {
  invoke("stop_benchmark").catch(() => {});
}

export function useQuickMeasure(): QuickMeasure {
  return useSyncExternalStore(subscribe, () => state);
}
