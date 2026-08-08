// Owns the benchmark page's backend calls: running the standard suite, loading
// results matched to this machine, and the weekly written-review allowance.
//
// Follows the same channel idiom as useComparison — a `runId` ref drops events
// from a superseded run so a stale stream can't overwrite fresh state.
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  BenchProgress,
  BenchRepeatsMode,
  BenchRun,
  BenchSuiteKind,
  MatchQuality,
  ReviewAllowance,
} from "../types";
import { recordUse } from "./lastUsed";
import { saveMeasuredRun } from "./measured";

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

/**
 * Feed a finished suite back into the hardware-truth engine, so every model
 * picker upgrades from a bandwidth estimate to this machine's real number.
 * The run's `hw.chip` and `quant` are the same strings `resolveTokPerSec` looks
 * up (`HardwareProfile.chip`, `Model.quantization`) — if either drifts the match
 * silently misses and the estimate keeps winning.
 *
 * ponytail: localStorage bridge, mirroring what Compare already writes. Swap for
 * a `bench_medians()` query when results need to outlive it — a restored DB or
 * cloud-synced runs, neither of which exists yet.
 */
function recordMeasured(run: BenchRun): void {
  if (run.decode_tps_median == null) return;
  saveMeasuredRun({
    modelId: run.model_name,
    chip: run.hw.chip,
    quant: run.quant ?? "unknown",
    tokPerSec: run.decode_tps_median,
    prompt: `${run.suite_id} v${run.suite_version}`,
    ts: Date.now(),
  });
}

/** Live progress for one Full-suite matrix cell, keyed by (promptId, numCtx). */
export interface CellProgress {
  promptId: string;
  numCtx: number;
  cellIndex: number;
  cellTotal: number;
  run?: BenchRun;
}

/** Rolling buffer length for the live-run waveform. */
const WAVEFORM_LENGTH = 52;

export function useBenchmarks(modelId: string | null) {
  const [groups, setGroups] = useState<MatchGroup[]>([]);
  // Always the Quick (anchor-std) suite, independent of whatever `groups` is
  // currently showing — the page's "Your machine" summary and the Share card
  // both need Quick's number even while the Full tab is on screen.
  const [quickGroups, setQuickGroups] = useState<MatchGroup[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<ReviewAllowance | null>(null);
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [cells, setCells] = useState<CellProgress[]>([]);
  // Real instantaneous decode-tps readings from the backend's `sample` events
  // (token-arrival timing, not a client-side simulation) — the running
  // graphic's waveform. Left in place (not cleared) after a run finishes, so
  // the graphic reads as "last run" rather than vanishing.
  const [waveform, setWaveform] = useState<number[]>([]);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  // The latest measured repeat's index/total, for the segmented progress bar
  // — structured data from the `run` event rather than parsed back out of
  // the human-readable `progress` string.
  const [runProgress, setRunProgress] = useState<{ index: number; total: number } | null>(null);
  const [history, setHistory] = useState<BenchRun[]>([]);
  const [historyScope, setHistoryScope] = useState<"this" | "all">("this");
  // Bumped whenever a run finishes, so a view driven by `load` knows to refetch.
  const [version, setVersion] = useState(0);
  const runId = useRef(0);

  /** Loads results, optionally filtered to one suite/prompt/context — pass
   *  `suiteId: "anchor-std"` for the Quick tab so Full-mode cells (once any
   *  exist) never blend into a leaderboard the caller expects to be one
   *  suite's numbers. `id: null` ranks every benchmarked model against every
   *  other one instead of scoping to one — the leaderboard's cross-model
   *  view, meaningful once `suiteId`/`promptId`/`numCtx` pin the comparison
   *  to one apples-to-apples configuration. */
  const load = useCallback(
    async (id: string | null, suiteId?: string, promptId?: string, numCtx?: number) => {
      try {
        setGroups(
          group(
            await invoke<BenchRun[]>("bench_runs_for_model", {
              model: id,
              suiteId: suiteId ?? null,
              promptId: promptId ?? null,
              numCtx: numCtx ?? null,
            }),
          ),
        );
        setError(null);
      } catch (e) {
        // A model that isn't installed has no digest to match on — not an error
        // worth shouting about, just nothing to show.
        setGroups([]);
        setError(String(e));
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    if (!modelId) {
      setQuickGroups([]);
      return;
    }
    invoke<BenchRun[]>("bench_runs_for_model", { model: modelId, suiteId: "anchor-std", promptId: null, numCtx: null })
      .then((runs) => !cancelled && setQuickGroups(group(runs)))
      .catch(() => !cancelled && setQuickGroups([]));
    return () => {
      cancelled = true;
    };
  }, [modelId, version]);

  useEffect(() => {
    invoke<ReviewAllowance>("review_allowance").then(setAllowance).catch(() => {});
  }, []);

  // History panel: chronological (`bench_history`), distinct from the
  // rank-by-speed queries above. `limit` is fetched generously (50) even
  // though only a handful render, so the panel's own summary line ("N runs ·
  // M models") reflects real totals rather than just what's on screen.
  useEffect(() => {
    let cancelled = false;
    const model = historyScope === "this" ? modelId : null;
    if (historyScope === "this" && !modelId) {
      setHistory([]);
      return;
    }
    invoke<BenchRun[]>("bench_history", { model, limit: 50 })
      .then((runs) => !cancelled && setHistory(runs))
      .catch(() => !cancelled && setHistory([]));
    return () => {
      cancelled = true;
    };
  }, [modelId, historyScope, version]);

  const run = useCallback(
    (id: string, suite: BenchSuiteKind, repeats: BenchRepeatsMode) => {
      const myRun = ++runId.current;
      recordUse(id); // feeds Storage's last-used column and its stale check
      setRunning(true);
      setError(null);
      setProgress("starting");
      setCells([]);
      setWaveform([]);
      setRunStartedAt(Date.now());
      setRunProgress(null);

      const channel = new Channel<BenchProgress>();
      channel.onmessage = (event) => {
        if (runId.current !== myRun) return; // stale run — ignore
        switch (event.kind) {
          case "status":
            setProgress(event.message);
            break;
          case "run":
            setProgress(`run ${event.index} of ${event.total} · ${event.decode_tps.toFixed(1)} tok/s`);
            setRunProgress({ index: event.index, total: event.total });
            break;
          case "sample":
            setWaveform((w) => [...w, event.tps].slice(-WAVEFORM_LENGTH));
            break;
          case "done":
            setProgress(null);
            setRunning(false);
            setRunStartedAt(null);
            recordMeasured(event.run);
            setVersion((v) => v + 1);
            break;
          case "cell_started":
            setProgress(`cell ${event.cell_index} of ${event.cell_total} · ${event.prompt_id} @ ${event.num_ctx}`);
            setCells((cs) => [
              ...cs,
              { promptId: event.prompt_id, numCtx: event.num_ctx, cellIndex: event.cell_index, cellTotal: event.cell_total },
            ]);
            break;
          case "cell_done":
            recordMeasured(event.run);
            setCells((cs) =>
              cs.map((c) =>
                c.promptId === event.run.prompt_id && c.numCtx === event.run.num_ctx ? { ...c, run: event.run } : c,
              ),
            );
            break;
          case "full_done":
            setProgress(null);
            setRunning(false);
            setRunStartedAt(null);
            setVersion((v) => v + 1);
            break;
          case "failed":
            setProgress(null);
            setRunning(false);
            setRunStartedAt(null);
            setError(event.message);
            break;
        }
      };

      invoke("run_benchmark", { model: id, suite, repeats, onEvent: channel }).catch((e) => {
        if (runId.current !== myRun) return;
        setProgress(null);
        setRunning(false);
        setRunStartedAt(null);
        setError(String(e));
      });
    },
    [],
  );

  /** Opens one written review, spending a slot unless it's already unlocked. */
  const unlockReview = useCallback(async (id: string) => {
    const result = await invoke<ReviewAllowance>("unlock_review", { runId: id });
    setAllowance(result);
    if (result.unlocked) setUnlocked((s) => new Set(s).add(id));
    return result.unlocked;
  }, []);

  return {
    groups,
    quickGroups,
    progress,
    running,
    error,
    allowance,
    unlocked,
    cells,
    waveform,
    runStartedAt,
    runProgress,
    history,
    historyScope,
    setHistoryScope,
    version,
    run,
    unlockReview,
    load,
  };
}
