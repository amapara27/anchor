// Owns the benchmark page's backend calls: running the standard suite, loading
// results matched to this machine, and this machine's run history.
//
// Follows the same channel idiom as useComparison — a `runId` ref drops events
// from a superseded run so a stale stream can't overwrite fresh state.
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { BenchProgress, BenchRepeatsMode, BenchRun, MatchQuality } from "../types";
import { HEADLINE_SCENARIO, SUITE_ID } from "./scenarios";
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

/** Live progress for one scenario. Context is derived from the scenario, so
 *  the id alone identifies the row. */
export interface ScenarioProgress {
  scenarioId: string;
  numCtx: number;
  index: number;
  total: number;
  run?: BenchRun;
}

/** Rolling buffer length for the live-run waveform. */
const WAVEFORM_LENGTH = 52;

export function useBenchmarks(modelId: string | null) {
  const [groups, setGroups] = useState<MatchGroup[]>([]);
  // This model's headline scenario, fetched separately because `groups` gets
  // repointed at a cross-model ranking whenever the Leaderboard tab is open —
  // the page's "Your machine" summary and the Share card need one model's
  // number either way.
  const [headlineGroups, setHeadlineGroups] = useState<MatchGroup[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioProgress[]>([]);
  // Real instantaneous decode-tps readings from the backend's `sample` events
  // (token-arrival timing, not a client-side simulation) — the running
  // graphic's waveform. Left in place (not cleared) after a run finishes, so
  // the graphic reads as "last run" rather than vanishing.
  const [waveform, setWaveform] = useState<number[]>([]);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  // How far through the suite the run is, for the segmented progress bar —
  // scenario index/total, not repeat index/total. The repeat counter resets
  // once per scenario, so a bar driven by it never showed overall progress.
  const [runProgress, setRunProgress] = useState<{ index: number; total: number } | null>(null);
  const [history, setHistory] = useState<BenchRun[]>([]);
  const [historyScope, setHistoryScope] = useState<"this" | "all">("this");
  // Bumped whenever a run finishes, so a view driven by `load` knows to refetch.
  const [version, setVersion] = useState(0);
  const runId = useRef(0);

  /** Loads results, optionally filtered to one suite/scenario/context.
   *  `id: null` ranks every benchmarked model against every other one — the
   *  leaderboard's cross-model view, which only means anything once
   *  `scenarioId` pins the comparison to one apples-to-apples shape. */
  const load = useCallback(
    async (id: string | null, suiteId?: string, scenarioId?: string, numCtx?: number) => {
      try {
        setGroups(
          group(
            await invoke<BenchRun[]>("bench_runs_for_model", {
              model: id,
              suiteId: suiteId ?? null,
              promptId: scenarioId ?? null,
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
      setHeadlineGroups([]);
      return;
    }
    invoke<BenchRun[]>("bench_runs_for_model", {
      model: modelId,
      suiteId: SUITE_ID,
      promptId: HEADLINE_SCENARIO,
      numCtx: null,
    })
      .then((runs) => !cancelled && setHeadlineGroups(group(runs)))
      .catch(() => !cancelled && setHeadlineGroups([]));
    return () => {
      cancelled = true;
    };
  }, [modelId, version]);

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
    (id: string, repeats: BenchRepeatsMode) => {
      const myRun = ++runId.current;
      recordUse(id); // feeds Storage's last-used column and its stale check
      setRunning(true);
      setError(null);
      setProgress("starting");
      setScenarios([]);
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
            break;
          case "sample":
            setWaveform((w) => [...w, event.tps].slice(-WAVEFORM_LENGTH));
            break;
          case "scenario_started":
            setProgress(`scenario ${event.index} of ${event.total} · ${event.scenario_id} @ ${event.num_ctx}`);
            // The bar fills as scenarios complete, so `index - 1` are done.
            setRunProgress({ index: event.index - 1, total: event.total });
            setScenarios((ss) => [
              ...ss,
              { scenarioId: event.scenario_id, numCtx: event.num_ctx, index: event.index, total: event.total },
            ]);
            break;
          case "scenario_done":
            setRunProgress({ index: event.index, total: event.total });
            // Only the headline scenario feeds the hardware-truth engine: it is
            // the shape the model pickers' tok/s estimate is calibrated against.
            if (event.run.prompt_id === HEADLINE_SCENARIO) recordMeasured(event.run);
            setScenarios((ss) =>
              ss.map((s) => (s.scenarioId === event.run.prompt_id ? { ...s, run: event.run } : s)),
            );
            break;
          case "done":
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

      invoke("run_benchmark", { model: id, repeats, onEvent: channel }).catch((e) => {
        if (runId.current !== myRun) return;
        setProgress(null);
        setRunning(false);
        setRunStartedAt(null);
        setError(String(e));
      });
    },
    [],
  );

  return {
    groups,
    headlineGroups,
    progress,
    running,
    error,
    scenarios,
    waveform,
    runStartedAt,
    runProgress,
    history,
    historyScope,
    setHistoryScope,
    version,
    run,
    load,
  };
}
