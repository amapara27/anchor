// Owns the benchmark page's backend calls: running the standard suite, loading
// results matched to this machine, and the weekly written-review allowance.
//
// Follows the same channel idiom as useComparison — a `runId` ref drops events
// from a superseded run so a stale stream can't overwrite fresh state.
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { BenchProgress, BenchRun, MatchQuality, ReviewAllowance } from "../types";

/** Results grouped by how well the measuring machine matches this one. */
export interface MatchGroup {
  quality: MatchQuality;
  runs: BenchRun[];
}

/** Group order, most specific first. Mirrors the backend's numeric tier. */
const GROUP_ORDER: MatchQuality[] = ["exact", "same_chip_memory", "same_family"];

/** Human labels for each tier. A looser match must never read as an exact one. */
export const MATCH_LABEL: Record<MatchQuality, string> = {
  exact: "Your exact Mac",
  same_chip_memory: "Same chip, different cores",
  same_family: "Same chip family",
};

function group(runs: BenchRun[]): MatchGroup[] {
  return GROUP_ORDER.map((quality) => ({
    quality,
    runs: runs.filter((r) => (r.match_quality ?? "same_family") === quality),
  })).filter((g) => g.runs.length > 0);
}

export function useBenchmarks(modelId: string | null) {
  const [groups, setGroups] = useState<MatchGroup[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<ReviewAllowance | null>(null);
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const runId = useRef(0);

  const load = useCallback(async (id: string | null) => {
    if (!id) {
      setGroups([]);
      return;
    }
    try {
      setGroups(group(await invoke<BenchRun[]>("bench_runs_for_model", { model: id })));
      setError(null);
    } catch (e) {
      // A model that isn't installed has no digest to match on — not an error
      // worth shouting about, just nothing to show.
      setGroups([]);
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load(modelId);
  }, [modelId, load]);

  useEffect(() => {
    invoke<ReviewAllowance>("review_allowance").then(setAllowance).catch(() => {});
  }, []);

  const run = useCallback(
    (id: string) => {
      const myRun = ++runId.current;
      setRunning(true);
      setError(null);
      setProgress("starting");

      const channel = new Channel<BenchProgress>();
      channel.onmessage = (event) => {
        if (runId.current !== myRun) return; // stale run — ignore
        switch (event.kind) {
          case "status":
            setProgress(event.message);
            break;
          case "run":
            setProgress(`run ${event.index} of ${event.total} · ${event.decode_tps.toFixed(1)} tok/s`);
            break;
          case "done":
            setProgress(null);
            setRunning(false);
            void load(id);
            break;
          case "failed":
            setProgress(null);
            setRunning(false);
            setError(event.message);
            break;
        }
      };

      invoke("run_benchmark", { model: id, onEvent: channel }).catch((e) => {
        if (runId.current !== myRun) return;
        setProgress(null);
        setRunning(false);
        setError(String(e));
      });
    },
    [load],
  );

  /** Opens one written review, spending a slot unless it's already unlocked. */
  const unlockReview = useCallback(async (id: string) => {
    const result = await invoke<ReviewAllowance>("unlock_review", { runId: id });
    setAllowance(result);
    if (result.unlocked) setUnlocked((s) => new Set(s).add(id));
    return result.unlocked;
  }, []);

  return { groups, progress, running, error, allowance, unlocked, run, unlockReview, reload: load };
}
