// Owns the benchmark page's backend calls: running the standard suite, loading
// results matched to this machine, and this machine's run history.
//
// Follows the same channel idiom as useComparison — a `runId` ref drops events
// from a superseded run so a stale stream can't overwrite fresh state.
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { BenchProgress, BenchRepeatsMode, BenchRun, BenchSessionSummary, CalibrationSummary, MatchQuality, BenchRuntime } from "../types";
import { HEADLINE_SCENARIO, SUITE_ID } from "./scenarios";
import { MEASUREMENTS_EVENT } from "./useMeasurements";
import { recordUse } from "./lastUsed";

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

export function useBenchmarks(modelId: string | null, runtime: BenchRuntime = "ollama") {
  const [groups, setGroups] = useState<MatchGroup[]>([]);
  // This model's headline scenario, fetched separately because `groups` gets
  // repointed at a cross-model ranking whenever the Leaderboard tab is open —
  // the page's "Your machine" summary and the Share card need one model's
  // number either way.
  const [headlineGroups, setHeadlineGroups] = useState<MatchGroup[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const [sessions, setSessions] = useState<BenchSessionSummary[]>([]);
  const [history, setHistory] = useState<BenchRun[]>([]);
  const [historyScope, setHistoryScope] = useState<"this" | "all">("this");
  // Bumped whenever a run finishes, so a view driven by `load` knows to refetch.
  const [version, setVersion] = useState(0);
  const runId = useRef(0);
  const active = useRef(false);
  const loadId = useRef(0);
  const [calibrating, setCalibrating] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationSummary | null>(null);
  const [calibrationProgress, setCalibrationProgress] = useState<string | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [calibrationLoading, setCalibrationLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setCalibration(current => current?.model_name === modelId ? current : null);
    if (!modelId || runtime !== "ollama") { setCalibration(null); setCalibrationLoading(false); return; }
    setCalibrationLoading(true);
    invoke<CalibrationSummary | null>("latest_calibration", { model: modelId })
      .then(result => { if (!cancelled) setCalibration(result); })
      .catch(e => { if (!cancelled) setCalibrationError(`Could not load the saved check. ${String(e)}`); })
      .finally(() => { if (!cancelled) setCalibrationLoading(false); });
    return () => { cancelled = true; };
  }, [modelId, runtime, version]);

  useEffect(() => { setCalibrationError(null); setCalibrationProgress(null); setScenarios([]); setWaveform([]); setError(null); }, [modelId, runtime]);

  const calibrate = useCallback((id: string) => {
    if (active.current) return;
    active.current = true;
    const myRun = ++runId.current;
    setCalibrating(true);
    setCalibration(null);
    setCalibrationError(null);
    setCalibrationProgress("Preparing Ollama…");
    const channel = new Channel<BenchProgress>();
    channel.onmessage = event => {
      if (runId.current === myRun && event.kind === "status") setCalibrationProgress(event.message);
    };
    invoke<CalibrationSummary | null>("calibrate_model", { model: id, onEvent: channel })
      .then(result => {
        if (runId.current !== myRun) return;
        setCalibration(result);
        setCalibrationProgress(result ? null : "Stopped before any checks began.");
      })
      .catch(e => { if (runId.current === myRun) { setCalibrationError(`Validation could not finish. ${String(e)}`); setCalibrationProgress(null); } })
      .finally(() => {
        if (runId.current !== myRun) return;
        active.current = false;
        setCalibrating(false);
        setVersion(v => v + 1);
      });
  }, []);

  /** Loads results, optionally filtered to one suite/scenario/context.
   *  `id: null` ranks every benchmarked model against every other one — the
   *  leaderboard's cross-model view, which only means anything once
   *  `scenarioId` pins the comparison to one apples-to-apples shape. */
  const load = useCallback(
    async (id: string | null, suiteId?: string, scenarioId?: string, numCtx?: number) => {
      const requestId=++loadId.current;
      try {
        const runs=await invoke<BenchRun[]>(runtime === "mlx" ? "mlx_suite_runs" : "bench_runs_for_model", {
          modelPath:id,referencePath:modelId,history:false,model:id,suiteId:suiteId ?? null,promptId:scenarioId ?? null,numCtx:numCtx ?? null,
        });
        if(requestId!==loadId.current)return;
        setGroups(
          group(
            runs,
          ),
        );
        setLoadError(null);
      } catch (e) {
        if(requestId!==loadId.current)return;
        // A model that isn't installed has no digest to match on — not an error
        // worth shouting about, just nothing to show.
        setGroups([]);
        setLoadError(String(e));
      }
    },
    [runtime, modelId],
  );

  useEffect(() => {
    let cancelled = false;
    if (!modelId) {
      setHeadlineGroups([]);
      return;
    }
    invoke<BenchRun[]>(runtime === "mlx" ? "mlx_suite_runs" : "bench_runs_for_model", {
      modelPath: modelId, referencePath: modelId, history: false,
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
  }, [modelId, runtime, version]);

  // History panel: chronological (`bench_history`), distinct from the
  // rank-by-speed queries above. `limit` is fetched generously (50) even
  // though only a handful render, so the panel's own summary line ("N runs ·
  // M models") reflects real totals rather than just what's on screen.
  useEffect(() => {
    let cancelled = false;
    const model = historyScope === "this" ? modelId : null;
    if (historyScope === "this" && !modelId) {
      setHistory([]);
      setSessions([]);
      return;
    }
    invoke<BenchSessionSummary[]>("bench_sessions", { limit: 50 })
      .then((rows) => !cancelled && setSessions(rows.filter(s => historyScope === "all" || (s.model_key ?? s.model_name) === modelId)))
      .catch((e) => !cancelled && setError(String(e)));
    invoke<BenchRun[]>(runtime === "mlx" ? "mlx_suite_runs" : "bench_history", { model, modelPath: model, referencePath: null, promptId: null, history: true, limit: 50 })
      .then((runs) => !cancelled && setHistory(runs))
      .catch(() => !cancelled && setHistory([]));
    return () => {
      cancelled = true;
    };
  }, [modelId, runtime, historyScope, version]);

  /** Ends the running suite, keeping the scenarios it already measured. The
   *  backend unloads the model and emits its usual `done`, so nothing special
   *  is needed here beyond asking it to stop. */
  const stop = useCallback(() => {
    invoke("stop_benchmark").catch(e => setError(`Could not stop the measurement: ${String(e)}`));
  }, []);

  const run = useCallback(
    (id: string, repeats: BenchRepeatsMode) => {
      if (active.current) return;
      active.current = true;
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
            setWaveform((w) => [...w, event.chunks_per_sec].slice(-WAVEFORM_LENGTH));
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
            setScenarios((ss) =>
              ss.map((s) => (s.scenarioId === event.run.prompt_id ? { ...s, run: event.run } : s)),
            );
            break;
          case "done":
            setProgress(null);
            setRunning(false);
            setRunStartedAt(null);
            setVersion((v) => v + 1);
            window.dispatchEvent(new Event(MEASUREMENTS_EVENT));
            break;
          case "failed":
            setVersion((v) => v + 1);
            setProgress(null);
            setRunning(false);
            setRunStartedAt(null);
            setError(event.message);
            break;
        }
      };

      invoke(runtime === "mlx" ? "run_mlx_suite" : "run_benchmark", { model: id, modelPath: id, repeats, scenario: null, onEvent: channel }).catch((e) => {
        if (runId.current !== myRun) return;
        setProgress(null);
        setRunning(false);
        setRunStartedAt(null);
        if (runtime === "mlx") setScenarios([]);
        setError(String(e));
        setVersion((v) => v + 1);
      }).finally(() => {
        if (runId.current === myRun) { active.current = false; setRunning(false); }
      });
    },
    [runtime],
  );

  return {
    groups,
    headlineGroups,
    progress,
    running,
    error: error ?? loadError,
    scenarios,
    waveform,
    runStartedAt,
    runProgress,
    history,
    sessions,
    historyScope,
    setHistoryScope,
    version,
    run,
    stop,
    load,
    calibrating,
    calibration,
    calibrationProgress,
    calibrationError,
    calibrationLoading,
    calibrate,
  };
}
