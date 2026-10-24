import { useEffect, useMemo, useState } from "react";
import type { BenchRepeatsMode, BenchRun, BenchSessionSummary, HardwareProfile, LibraryModel } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { useBenchmarks, MATCH_LABEL, type MatchGroup } from "../lib/useBenchmarks";
import { formatBytes, formatRelativeTime } from "../lib/format";
import { renderBenchmarkCard, type BenchmarkCardData } from "../lib/exportImage";
import { savePng } from "../lib/savePng";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Meta, PageHeader, GhostButton, PrimaryButton } from "./PageHeader";
import { ModelSelect } from "./ui/ModelSelect";
import { Tabs } from "./ui/Tabs";
import { Meter } from "./ui/SegmentedBar";
import { ScenarioTable, type ScenarioRow } from "./ui/ScenarioTable";
import {
  HEADLINE_SCENARIO,
  SCENARIOS_BY_COST,
  SUITE_ID,
  numCtxFor,
} from "../lib/scenarios";
import { ChevronRightIcon, PlayIcon, DownloadIcon, ShareIcon, CloseIcon, WarningIcon, StopIcon } from "./icons";

type BenchTab = "suite" | "leaderboard";

/** Median of the group's decode throughput — what the tier is summarised by. */
function medianTps(runs: BenchRun[]): number | null {
  const xs = runs
    .map((r) => r.decode_tps_median)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Flags a run measured under thermal pressure. Silent otherwise — in a dense
 *  table only the exception is worth a flag; the full reading lives in the
 *  live-run card's `ThermalReadout`. */
function ThermalBadge({ label }: { label: string | null }) {
  if (label !== "throttled" && label !== "pressure") return null;
  return (
    <span title="The Mac was under thermal pressure during this run — numbers may be lower than a cool run.">
      <WarningIcon className="size-3 shrink-0 text-warn" />
    </span>
  );
}

/** macOS `OSThermalPressureLevel`, as words. Anything above nominal means the
 *  system was actively shedding heat while the run was measured. */
const THERMAL_LEVELS: Record<number, { word: string; tone: string }> = {
  0: { word: "nominal", tone: "bg-ok" },
  10: { word: "moderate", tone: "bg-warn" },
  20: { word: "heavy", tone: "bg-warn" },
  30: { word: "trapping", tone: "bg-danger" },
  40: { word: "sleeping", tone: "bg-danger" },
};

/** The conditions a stored run was measured under: thermal pressure at the end
 *  of the run, plus the power source. Stated even when everything was fine —
 *  "was my Mac hot?" deserves an answer either way, not only a warning icon
 *  that appears once in a blue moon. Renders nothing for a run recorded before
 *  thermal state was readable. */
function ThermalReadout({ run }: { run: BenchRun | undefined }) {
  const level = run?.env_end?.thermal_level ?? run?.env_start?.thermal_level ?? null;
  const state = level != null ? THERMAL_LEVELS[level] : undefined;
  if (!state) return null;
  const onBattery = run?.env_start?.on_ac_power === false;
  return (
    <span className="flex shrink-0 items-center gap-1.5" title="Thermal pressure macOS reported as this run finished">
      <span className={`size-1.5 rounded-full ${state.tone}`} aria-hidden />
      thermal {state.word}
      {onBattery && <span className="text-warn">· on battery</span>}
    </span>
  );
}

/**
 * Benchmarks: pick a model, run it, and watch it happen — then see how it
 * ranks against every other model you've tested, and share a card of the
 * result.
 *
 * Top section (run setup / live run / history) is always visible, above the
 * suite/leaderboard/community tabs. One suite, run in full every time: nine
 * scenarios, each a (prompt tokens, generation tokens) shape with a use case
 * attached, at a context derived from what the scenario needs. The Leaderboard
 * ranks **models** against each other (not a separate leaderboard per model)
 * and is always scoped to one scenario, since tok/s only compares fairly at
 * the same shape. Rows are grouped by hardware match tier so a number from a
 * looser match is never presented as though it came from an identical Mac.
 * The Community tab has no backend — there is no results server to publish to
 * or read from — so it says so rather than showing invented runs.
 */
export function BenchmarksPage({openModel, onBusy}: {openModel?: {id: string; nonce: number} | null; onBusy?: (busy: boolean) => void}) {
  const { models } = useModels();
  const { profile } = useHardwareProfile();
  const installed = useMemo(() => models.filter((m) => m.status === "installed"), [models]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { if(openModel) setSelected(openModel.id); }, [openModel]);
  const [tab, setTab] = useState<BenchTab>("suite");
  const [repeatsMode, setRepeatsMode] = useState<BenchRepeatsMode>("fast");
  const [scenarioFilter, setScenarioFilter] = useState(HEADLINE_SCENARIO);
  const [shareCard, setShareCard] = useState<{ data: BenchmarkCardData; url: string } | null>(null);

  const modelId = selected ?? installed[0]?.id ?? null;
  const {
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
    sessions,
    historyScope,
    setHistoryScope,
    version,
    run,
    stop,
    load,
  } = useBenchmarks(modelId);
  useEffect(() => { onBusy?.(running); }, [running, onBusy]);

  // `groups` is driven entirely by which view is on screen: the Suite tab is
  // about one model's nine scenarios, while the Leaderboard ranks every model
  // against every other one (`model: null`) at one scenario, so tok/s compares
  // like for like.
  useEffect(() => {
    if (tab === "suite") {
      if (modelId) void load(modelId, SUITE_ID);
    } else if (tab === "leaderboard") {
      void load(null, SUITE_ID, scenarioFilter);
    }
  }, [modelId, tab, scenarioFilter, version, load]);

  // Elapsed-time clock for the live-run card. Ticks locally rather than
  // threading a timestamp through every backend event.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const elapsedMs = runStartedAt != null ? nowTick - runStartedAt : 0;

  // Header summary and the share card read the headline scenario only — one
  // canonical number per model rather than eight competing ones.
  const yours = headlineGroups.find((g) => g.quality === "exact");
    const mine = yours?.runs.find((r) => r.source === "local");

  const exactLocal = useMemo(
    () => (groups.find((g) => g.quality === "exact")?.runs ?? []).filter((r) => r.source === "local"),
    [groups],
  );

  // The shape behind the leaderboard's current scenario, spelled out under the
  // chips now that the chips themselves only carry the name.
  const activeScenario = SCENARIOS_BY_COST.find((s) => s.id === scenarioFilter);

  // A live run's rows win over stored ones, so the table fills in as it goes
  // rather than showing the previous run's numbers until the whole suite ends.
  const scenarioRows: ScenarioRow[] = useMemo(
    () =>
      SCENARIOS_BY_COST.map((s) => {
        const live = scenarios.find((x) => x.scenarioId === s.id);
        return {
          scenarioId: s.id,
          run: live?.run ?? exactLocal.find((r) => r.prompt_id === s.id),
          pending: live != null && live.run == null,
        };
      }),
    [exactLocal, scenarios],
  );

  // Shared by the History card's "Share" (this machine's last headline result)
  // and each leaderboard row's own Share button (that row's result — a
  // different machine's numbers when the row isn't `mine`). Only substitutes
  // the live `profile` in for a row measured on this machine; another
  // machine's row uses its own recorded hw fields, never the viewer's.
  // `groupRuns` (the row's own match-tier group) is what the card's "#N on
  // this Mac" rank is computed from — filtered to `source === "local"` since
  // there's no community sync yet, every row IS this Mac, but the filter is
  // what keeps that true once sync exists.
  const cardDataForRun = (r: BenchRun, groupRuns?: BenchRun[]): BenchmarkCardData => {
    const useProfile = r.source === "local" && profile;
    const ranked = groupRuns
      ?.filter((x) => x.source === "local")
      .sort((a, b) => (b.decode_tps_median ?? 0) - (a.decode_tps_median ?? 0));
    const rank = ranked ? ranked.findIndex((x) => x.id === r.id) + 1 : 0;
    const installedModel = useProfile ? installed.find((m) => m.id === r.model_name) : undefined;
    return {
      modelName: r.model_name,
      quant: r.quant,
      paramSize: installedModel?.parameter_size ?? null,
      chip: useProfile ? (profile.chip ?? r.hw.chip) : r.hw.chip,
      cpuCores: useProfile ? profile.total_cores : r.hw.cpu_cores,
      memoryGb: useProfile && profile.memory_bytes != null ? profile.memory_bytes / 1024 ** 3 : (r.hw.memory_gb ?? null),
      osVersion: useProfile ? (profile.os_version ?? r.hw.os_version) : r.hw.os_version,
      ollamaVersion: r.ollama_version,
      decodeTps: r.decode_tps_median ?? 0,
      ttftMs: r.ttft_ms_median,
      suiteLabel: `${r.suite_id} v${r.suite_version} · median of ${r.repeats} run${r.repeats === 1 ? "" : "s"}`,
      dateLabel: new Date(r.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      rank: rank > 0 ? rank : null,
      totalOnMachine: ranked ? ranked.length : null,
    };
  };
  const handleShareRun = async (r: BenchRun, groupRuns?: BenchRun[]) => {
    const data = cardDataForRun(r, groupRuns);
    const url = await renderBenchmarkCard(data);
    setShareCard({ data, url });
  };
  const handleShare = () => mine && void handleShareRun(mine, yours?.runs);

  return (
    <>
      <PageHeader
        title="Benchmarks"
        meta={<>
          <Meta k="Machine">{profile?.chip ?? profile?.model_name ?? "This Mac"}</Meta>
          {profile?.memory_bytes != null && <Meta k="Memory">{formatBytes(profile.memory_bytes)}</Meta>}
          {profile?.os_version && <Meta k="macOS">{profile.os_version}</Meta>}
        </>}
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex flex-col gap-4">
        <RunSetupCard
          modelId={modelId}
          setSelected={setSelected}
          installed={installed}
          profile={profile}
          running={running}
          repeatsMode={repeatsMode}
          setRepeatsMode={setRepeatsMode}
          onRun={() => modelId && run(modelId, repeatsMode)}
          onStop={stop}
        />
        <LiveRunCard
          running={running}
          progress={progress}
          waveform={waveform}
          runProgress={runProgress}
          elapsedMs={elapsedMs}
          mine={mine}
        />

      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Tabs
          ariaLabel="Benchmarks view"
          value={tab}
          onChange={setTab}
          items={[
            { key: "suite", label: "Suite" },
            { key: "leaderboard", label: "Leaderboard" },
          ]}
        />
      </div>

      {tab === "suite" && (
        <section className="flex flex-col gap-3">
          {!modelId ? (
            <p className="rounded-card border border-dashed border-hair2 px-4 py-10 text-center text-sm text-fg-muted">Install a model to benchmark it.</p>
          ) : (
            <ScenarioTable
              rows={scenarioRows}
              onSelect={(scenarioId) => {
                setScenarioFilter(scenarioId);
                setTab("leaderboard");
              }}
            />
          )}

        </section>
      )}

      {tab === "leaderboard" && (
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-[13px] text-fg-muted">Scenario
              <select aria-label="Leaderboard scenario" title={activeScenario?.label} value={scenarioFilter} onChange={e=>setScenarioFilter(e.target.value)} className="select-native data">
                {SCENARIOS_BY_COST.map(sc=><option key={sc.id} value={sc.id}>{sc.id}</option>)}
              </select>
            </label>
            {activeScenario && <span aria-label="Scenario token counts" className="data text-[11px] text-fg-muted">{activeScenario.promptTokens} in / {activeScenario.genTokens} out · {numCtxFor(activeScenario)/1024}K context</span>}
          </div>
          {groups.length === 0 ? (
            <p className="rounded-card border border-dashed border-hair2 px-4 py-10 text-center text-sm text-fg-muted">
              No results for this scenario.
            </p>
          ) : (
            groups.map((g) => (
              <Group key={g.quality} group={g} onShareRun={handleShareRun} />
            ))
          )}

        </div>
      )}


      <details className="group border-t border-hair pt-4">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden"><ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />Method</summary>
        <p className="mt-3 max-w-[65ch] text-xs leading-relaxed text-fg-muted">Nine workloads with target input lengths and output caps. Results are descriptive medians after warm-up. Prefill requires a reported cached-token count; TTFT measures request to first received output. Thorough runs three repeats; Fast runs long generations once. Rankings use the current method and matching scenario/context. Raw warmups and every attempted request remain in session evidence. Runtime rates are uncalibrated engine diagnostics. The live waveform shows response chunks, not tokens. Thermal status comes from boundary snapshots. Server KV cache and Flash Attention settings are not reported.</p>
      </details>
      <details className="group border-t border-hair pt-4">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden"><ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />Run history <span className="data ml-1 text-[11px] text-fg-subtle">{history.length}</span></summary>
        <div className="mt-4"><HistoryCard history={history} historyScope={historyScope} setHistoryScope={setHistoryScope} onShare={handleShare} canShare={!!mine} /></div>
        <SessionEvidence sessions={sessions} />
      </details>
      {shareCard && (
        <ShareCardModal data={shareCard.data} url={shareCard.url} onClose={() => setShareCard(null)} />
      )}
    </>
  );
}

function SessionEvidence({ sessions }: { sessions: BenchSessionSummary[] }) {
  const [includeContent, setIncludeContent] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exportSession = async (id: string) => {
    setExporting(id);
    setError(null);
    try {
      const path = await save({ defaultPath: `anchor-${id}.json`, filters: [{ name: "Benchmark evidence", extensions: ["json"] }] });
      if (!path) return;
      const json = await invoke<string>("export_bench_evidence", { id, includeContent });
      await writeFile(path, new TextEncoder().encode(json));
    } catch (e) { setError(String(e)); }
    finally { setExporting(null); }
  };
  return <section aria-label="Execution evidence" className="mt-4 flex flex-col gap-3">
    <h3 className="text-sm font-medium">Execution evidence</h3>
    <label className="flex items-center gap-2 text-xs text-fg-muted">
      <input type="checkbox" checked={includeContent} onChange={e => setIncludeContent(e.target.checked)} />
      Include prompts and output in exports
    </label>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {sessions.length === 0 ? <p className="text-xs text-fg-muted">No recorded sessions. Earlier results have no raw event trace.</p> : sessions.map(s =>
      <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-hair py-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs"><span className="data break-all">{s.model_name}</span> · {s.outcome === "running" ? "unfinished" : s.outcome.replaceAll("_", " ")} · <span className="data">{s.recorded_attempts}/{s.planned_attempts}</span> attempts</p>
          <p className="data mt-1 break-all text-[11px] text-fg-muted">{s.id} · {formatRelativeTime(s.created_at)} · formula {s.formula_version}</p>
          {s.error && <p className="mt-1 break-words text-xs text-danger">{s.error}</p>}
        </div>
        <GhostButton className="h-7 text-xs" disabled={!includeContent || exporting != null} title={`Export evidence ${s.id}`} onClick={() => void exportSession(s.id)}>
          {exporting === s.id ? "Exporting…" : "Export JSON"}
          <span className="sr-only"> {s.id}</span>
        </GhostButton>
      </div>)}
  </section>;
}

/** Segmented pill toggle, buttons evenly split (unlike `ui/Tabs.tsx`'s
 *  content-sized pills) — matches the run-setup card's rigor toggle and
 *  Fast/Thorough switches. Kept local: nothing else in the app wants a
 *  full-width even split. */
function SegToggle<T extends string>({
  value,
  onChange,
  options,
  disabled,
  small,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string }[];
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <div className={"button-group" + (small ? "" : " h-8 items-center")}>
      {options.map((o) => (
        <button key={o.key} type="button" disabled={disabled} aria-pressed={o.key === value} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Model + suite + rigor + the run button — everything needed to start a
 *  benchmark, in one place near the top instead of split across the header
 *  and a tab. */
function RunSetupCard({
  modelId,
  setSelected,
  installed,
  profile,
  running,
  repeatsMode,
  setRepeatsMode,
  onRun,
  onStop,
}: {
  modelId: string | null;
  setSelected: (id: string) => void;
  installed: LibraryModel[];
  profile: HardwareProfile | null;
  running: boolean;
  repeatsMode: BenchRepeatsMode;
  setRepeatsMode: (m: BenchRepeatsMode) => void;
  onRun: () => void;
  onStop: () => void;
}) {
  return <section aria-label="Benchmark setup" className="flex flex-wrap items-end gap-x-4 gap-y-3">
    <div className="min-w-[220px] max-w-[460px] flex-1">
      <ModelSelect label="Model" value={modelId ?? ""} onChange={setSelected} models={installed} profile={profile}
        disabled={installed.length === 0 || running} variant="field" ariaLabel="Benchmark model"
        placeholder={installed.length === 0 ? "No models installed" : "Choose a model…"} />
    </div>
    <div title={repeatsMode === "thorough" ? "Three repeats per scenario" : "Long generations run once; other scenarios run three times"}>
      <span className="mb-1.5 block text-xs text-fg-muted">Rigor</span>
      <SegToggle value={repeatsMode} onChange={setRepeatsMode} disabled={running}
        options={[{key:"fast",label:"Fast"},{key:"thorough",label:"Thorough"}]} />
    </div>
    {running ? <GhostButton onClick={onStop} tone="danger" title="Stop the suite — keeps the scenarios already measured"><StopIcon className="size-3.5" />Stop</GhostButton> :
      <PrimaryButton onClick={onRun} disabled={!modelId}><PlayIcon className="size-3.5" />Run suite</PrimaryButton>}
  </section>;
}

/** Live throughput while a suite runs — a real waveform sampled from token
 *  arrival timing (backend `sample` events), not a client-side simulation.
 *  Idle, it shows the last headline-scenario result instead. */
function LiveRunCard({
  running,
  progress,
  waveform,
  runProgress,
  elapsedMs,
  mine,
}: {
  running: boolean;
  progress: string | null;
  waveform: number[];
  runProgress: { index: number; total: number } | null;
  elapsedMs: number;
  mine: BenchRun | undefined;
}) {
  if (!running && !mine) return null;
  const liveTps = waveform.length ? waveform[waveform.length - 1] : null;
  const displayTps = running ? liveTps : (mine?.decode_tps_median ?? null);
  const max = Math.max(...waveform, 1);

  const title = running ? "Benchmarking" : "Last result";
  const meta = running
    ? (progress ?? "starting")
    : mine
      ? `${mine.model_name} · ${formatRelativeTime(mine.updated_at)}`
      : "";

  // One segment per scenario in the suite, filling as each finishes.
  const totalSegments = runProgress?.total ?? SCENARIOS_BY_COST.length;
  const filledSegments = running ? (runProgress?.index ?? 0) : mine ? totalSegments : 0;

  return <section aria-label="Benchmark status" className="flex flex-col gap-3 border-b border-hair pb-4">
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <span className="flex items-center gap-2 text-[13px] font-medium">{running && <span className="size-1.5 rounded-full bg-accent" aria-hidden />}{title}</span>
      {displayTps != null && <span className="data text-[15px]">{displayTps.toFixed(1)} <span className="text-xs text-fg-muted">{running ? "chunks/s" : "tok/s"}</span></span>}
      <span className="min-w-0 flex-1 text-xs text-fg-muted">{meta}</span>
      {running ? <span className="data text-xs text-fg-muted">{formatElapsed(elapsedMs)}</span> : <ThermalReadout run={mine} />}
    </div>
    {running && waveform.length > 0 && <div className="flex h-8 items-end gap-px" aria-label="Received response chunks per second">
      {waveform.map((v,i)=><span key={i} className="min-w-px flex-1 bg-accent" style={{height:Math.max(3,Math.min(100,v/max*100))+"%"}} />)}
    </div>}
    <div role="progressbar" aria-label="Benchmark scenarios completed" aria-valuemin={0} aria-valuemax={totalSegments} aria-valuenow={filledSegments} className={running ? "flex gap-1.5" : "sr-only"}>
      {Array.from({length:totalSegments},(_,i)=><span key={i} className="h-1 flex-1 bg-hair"><span className="block h-full bg-accent" style={{width:i<filledSegments?"100%":"0%"}} /></span>)}
    </div>
  </section>;
}

/** Recent runs, chronological (`bench_history`) — distinct from the
 *  leaderboard's rank-by-speed view below. */
function HistoryCard({
  history,
  historyScope,
  setHistoryScope,
  onShare,
  canShare,
}: {
  history: BenchRun[];
  historyScope: "this" | "all";
  setHistoryScope: (s: "this" | "all") => void;
  onShare: () => void;
  canShare: boolean;
}) {
  const rows = history.slice(0, 5);
  const max = Math.max(...history.map((r) => r.decode_tps_median ?? 0), 1);
  const modelCount = new Set(history.map((r) => r.model_digest)).size;
  const footer =
    historyScope === "all"
      ? `${history.length} run${history.length === 1 ? "" : "s"} · ${modelCount} model${modelCount === 1 ? "" : "s"}`
      : `${history.length} run${history.length === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-hair">
      <div className="flex items-center justify-between gap-3 border-b border-hair bg-surface px-4 py-2">
        <span className="th">recent runs</span>
        <SegToggle
          value={historyScope}
          onChange={setHistoryScope}
          small
          options={[
            { key: "this", label: "this model" },
            { key: "all", label: "all models" },
          ]}
        />
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {rows.length === 0 ? (
          <p className="flex flex-1 items-center justify-center px-5 text-center text-[12.5px] text-fg-muted">
            No runs yet.
          </p>
        ) : (
          rows.map((r, i) => (
            <div key={r.id} className="grid grid-cols-[1fr_74px] items-center gap-3 border-b border-hair px-4 py-2.5 last:border-b-0">
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="data truncate text-[12.5px] font-medium text-fg">{r.model_name}</span>
                  <span className="data shrink-0 text-[10.5px] text-fg-subtle">{formatRelativeTime(r.updated_at)}</span>
                </div>
                <span className="mt-1.5 block h-1 overflow-hidden rounded-[2px] bg-hair">
                  <span
                    className="block h-full rounded-[2px] bg-accent"
                    style={{ width: `${((r.decode_tps_median ?? 0) / max) * 100}%`, opacity: 1 - i * 0.16 }}
                  />
                </span>
              </div>
              <span className="data text-right text-[13px] font-medium text-fg">
                {r.decode_tps_median != null ? `${r.decode_tps_median.toFixed(1)} t/s` : "—"}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-2.5 border-t border-hair px-4 py-2.5">
        <span className="data truncate text-[11px] text-fg-subtle">{footer}</span>
        <div className="flex shrink-0 gap-1.5">
          <GhostButton onClick={onShare} disabled={!canShare} className="h-7 text-[11.5px]">
            <ShareIcon className="size-3.5" />
            Share
          </GhostButton>
        </div>
      </div>
    </div>
  );
}

function Group({
  group,
  onShareRun,
}: {
  group: MatchGroup;
  onShareRun: (run: BenchRun, groupRuns: BenchRun[]) => void;
}) {
  const median = medianTps(group.runs);
  const best = Math.max(...group.runs.map((r) => r.decode_tps_median ?? 0), 1);

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13.5px] font-semibold text-fg">{MATCH_LABEL[group.quality]}</span>
        <span className="data text-[11px] text-fg-subtle">
          {group.runs.length} model{group.runs.length === 1 ? "" : "s"}
          {median != null && ` · median ${median.toFixed(1)} tok/s`}
        </span>
      </div>
      <div className="overflow-hidden rounded-card border border-hair">
        {group.runs.map((r, i) => {
          const mine = r.source === "local";
          return (
            <div
              key={r.id}
              className={[
                "grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1.6fr)_78px_34px] items-center gap-3 border-b border-hair px-4 py-2.5 last:border-b-0",
                mine ? "bg-accent-soft" : "",
              ].join(" ")}
            >
              <span className="data text-[11px] text-fg-subtle">{i + 1}</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={`flex items-center gap-1.5 truncate text-[12.5px] font-medium ${mine ? "text-accent-text" : "text-fg"}`}
                >
                  {r.model_name}
                  {r.quant && <span className="data ml-1.5 text-[10.5px] font-normal text-fg-subtle">{r.quant}</span>}
                  <ThermalBadge label={r.thermal_label} />
                </span>
                <span className="data truncate text-[10.5px] text-fg-subtle">
                  {r.hw.chip}
                  {mine && " · this Mac"}
                </span>
              </span>
              <Meter
                fraction={(r.decode_tps_median ?? 0) / best}
                color={mine ? "var(--accent)" : "var(--hair2)"}
                height={6}
              />
              <span className={`data text-right text-[12.5px] ${mine ? "text-accent-text" : "text-fg"}`}>
                {r.decode_tps_median != null ? `${r.decode_tps_median.toFixed(1)} t/s` : "—"}
              </span>
              <button
                type="button"
                onClick={() => onShareRun(r, group.runs)}
                disabled={r.decode_tps_median == null}
                title="Share a card of this result"
                aria-label={`Share ${r.model_name} result`}
                className="flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:text-fg disabled:pointer-events-none disabled:opacity-30"
              >
                <ShareIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** In-app preview of a rendered benchmark card, shown before anything leaves
 *  the app — download (native save dialog) or share to X are explicit
 *  choices from here, rather than Share silently writing a file. X's web
 *  intent has no way to attach a local image by URL, so that path opens a
 *  pre-filled tweet and leaves attaching the (downloaded) image to the user. */
function ShareCardModal({
  data,
  url,
  onClose,
}: {
  data: BenchmarkCardData;
  url: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // One predictable name the save dialog pre-fills, rather than a timestamped
  // one nobody can guess at; the dialog is where a different name is chosen.
  const filename = "anchor_benchmark.png";
  const tweetText = `${data.modelName} runs at ${data.decodeTps.toFixed(1)} tok/s on ${data.chip} — benchmarked locally with Anchor.`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Share benchmark card"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div className="relative flex w-full max-w-md flex-col gap-4 rounded-[var(--radius-card)] border border-hair2 bg-surface p-5 shadow-overlay">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">Share result</h2>
          <button type="button" aria-label="Close share preview" onClick={onClose} className="text-fg-subtle transition-colors hover:text-fg">
            <CloseIcon className="size-4" />
          </button>
        </div>
        <img src={url} alt="Benchmark card" className="w-full rounded-[10px] border border-hair" />
        <div className="flex gap-2">
          <PrimaryButton className="flex-1 justify-center" onClick={() => void savePng(url, filename)}>
            <DownloadIcon className="size-3.5" />
            Download
          </PrimaryButton>
          <GhostButton className="flex-1 justify-center" onClick={() => openUrl(tweetUrl).catch(() => {})}>
            Share to X
          </GhostButton>
        </div>
        <p className="text-[11px] leading-[1.5] text-fg-subtle">
          X doesn't accept an attached image via link — download the card first, then drag it into the post.
        </p>
      </div>
    </div>
  );
}
