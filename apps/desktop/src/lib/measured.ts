// Local store of measured tok/s runs from the Compare tool. Persisted so the
// hardware-truth engine can prefer a real number over a lookup estimate.
// localStorage only — these are per-machine facts, not shared state.
import type { MeasuredRun } from "../types";

const KEY = "anchor.measured";
const CAP = 200; // newest kept; comparisons are cheap and rare, this is plenty

function readAll(): MeasuredRun[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as MeasuredRun[]) : [];
  } catch {
    return []; // corrupt/unavailable storage must never break the app
  }
}

/** Append a measured run, newest first, capped. */
export function saveMeasuredRun(run: MeasuredRun): void {
  try {
    const next = [run, ...readAll()].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // best-effort: a failed write just means we fall back to estimates
  }
}

/** All measured runs, optionally filtered to one model, newest first. */
export function getMeasuredRuns(modelId?: string): MeasuredRun[] {
  const all = readAll();
  return modelId ? all.filter((r) => r.modelId === modelId) : all;
}
