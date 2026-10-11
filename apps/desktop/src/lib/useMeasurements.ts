import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BenchRun } from "../types";

/** Fired after any benchmark finishes, so measured speeds on Models refresh. */
export const MEASUREMENTS_EVENT = "anchor:measurements";

// This machine's latest headline run per installed model, keyed by model id.
let byModel: Record<string, BenchRun> = {};
let started = false;
const listeners = new Set<() => void>();

/** Re-reads measurements; cheap, and safe to call whenever the installed list changes. */
export function refreshMeasurements() {
  invoke<BenchRun[]>("latest_measurements")
    .then((runs) => {
      byModel = Object.fromEntries(runs.map((r) => [r.model_name, r]));
      listeners.forEach((l) => l());
    })
    .catch(() => {}); // Server not up yet: rows keep their estimates until the next refresh.
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    refreshMeasurements();
    window.addEventListener(MEASUREMENTS_EVENT, refreshMeasurements);
  }
  return () => listeners.delete(listener);
}

/** Measured headline runs by model id. Absent means "not measured on this Mac". */
export function useMeasurements(): Record<string, BenchRun> {
  return useSyncExternalStore(subscribe, () => byModel);
}
