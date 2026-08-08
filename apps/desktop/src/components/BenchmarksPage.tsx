import { useEffect, useMemo, useState } from "react";
import type { BenchRepeatsMode, BenchRun, BenchSuiteKind, HardwareProfile, LibraryModel, ReviewAllowance } from "../types";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { useBenchmarks, MATCH_LABEL, type MatchGroup } from "../lib/useBenchmarks";
import { formatBytes, formatRelativeTime } from "../lib/format";
import { renderBenchmarkCard, type BenchmarkCardData } from "../lib/exportImage";
import { savePng } from "../lib/savePng";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PageHeader, GhostButton, PrimaryButton } from "./PageHeader";
import { ModelSelect } from "./ui/ModelSelect";
import { Tabs } from "./ui/Tabs";
import { NotBuiltYet } from "./ui/NotBuiltYet";
import { Meter } from "./ui/SegmentedBar";
import { BenchMatrix, type MatrixCell } from "./ui/BenchMatrix";
import { LockIcon, ZapIcon, DownloadIcon, CloseIcon } from "./icons";

type BenchTab = "suite" | "leaderboard" | "community";

const TAB_HINT: Record<BenchTab, string> = {
  suite: "median of three runs, after a warm-up",
  leaderboard: "every model you've tested, ranked by decode tok/s",
  community: "no results server yet",
};

/** Prompt catalog and context sizes the Full suite runs, mirroring
 *  `anchor_hub::bench::prompts` — kept here only for building the matrix UI
 *  and the leaderboard's cell selector, not sent anywhere. */
const PROMPT_IDS = ["short", "long_context", "generation_heavy"];
const CTX_SIZES = [4096, 8192, 16384];

/** The fixed 8 feasible (prompt, context) cells the Full suite runs — mirrors
 *  the backend's feasibility filter (`long_context` doesn't fit at 4096). A
 *  cross-model leaderboard needs one fixed cell picked (comparing tok/s across
 *  different context sizes isn't apples-to-apples), so this is always the
 *  full, static list rather than derived from whichever models happen to have
 *  data yet. */
const FEASIBLE_CELLS: { promptId: string; numCtx: number }[] = CTX_SIZES.flatMap((numCtx) =>
  PROMPT_IDS.filter((promptId) => !(promptId === "long_context" && numCtx === 4096)).map((promptId) => ({
    promptId,
    numCtx,
  })),
);

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

/**
 * Benchmarks: pick a model, run it, and watch it happen — then see how it
 * ranks against every other model you've tested, and share a card of the
 * result.
 *
 * Top section (run setup / live run / history) is always visible, above the
 * suite/leaderboard/community tabs. Two suites: Quick (`run_benchmark`,
 * unchanged since before Full mode existed) and Full (a versioned prompt x
 * context-size matrix). The Leaderboard ranks **models** against each other
 * (not a separate leaderboard per model) — Quick scope compares every
 * model's Quick result directly; Full scope needs one fixed prompt+context
 * cell picked first, since tok/s only compares fairly at the same
 * configuration. Rows are still grouped by hardware match tier so a number
 * from a looser match is never presented as though it came from an identical
 * Mac. The Community tab has no backend — there is no results server to
 * publish to or read from — so it says so rather than showing invented runs.
 */
export function BenchmarksPage() {
  const { models } = useModels();
  const { profile } = useHardwareProfile();
  const installed = useMemo(() => models.filter((m) => m.status === "installed"), [models]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<BenchTab>("suite");
  const [mode, setMode] = useState<BenchSuiteKind>("quick");
  const [repeatsMode, setRepeatsMode] = useState<BenchRepeatsMode>("fast");
  const [leaderboardScope, setLeaderboardScope] = useState<BenchSuiteKind>("quick");
  const [cellFilter, setCellFilter] = useState(FEASIBLE_CELLS[0]);
  const [shareCard, setShareCard] = useState<{ data: BenchmarkCardData; url: string } | null>(null);

  const modelId = selected ?? installed[0]?.id ?? null;
  const {
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
  } = useBenchmarks(modelId);

  // `groups` is driven entirely by which view is on screen: the Suite tab's
  // Full matrix is about one model (needs `modelId`), while the Leaderboard
  // ranks every model against every other one (`model: null`), fixed to one
  // cell for the Full scope so tok/s compares fairly.
  useEffect(() => {
    if (tab === "suite" && mode === "full") {
      if (modelId) void load(modelId, "anchor-full");
    } else if (tab === "leaderboard") {
      if (leaderboardScope === "quick") {
        void load(null, "anchor-std");
      } else {
        void load(null, "anchor-full", cellFilter.promptId, cellFilter.numCtx);
      }
    }
  }, [modelId, tab, mode, leaderboardScope, cellFilter, version, load]);

  // Elapsed-time clock for the live-run card. Ticks locally rather than
  // threading a timestamp through every backend event.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const elapsedMs = runStartedAt != null ? nowTick - runStartedAt : 0;

  const total = quickGroups.reduce((n, g) => n + g.runs.length, 0);
  const yours = quickGroups.find((g) => g.quality === "exact");
  const yourTps = yours ? medianTps(yours.runs) : null;
  const mine = yours?.runs.find((r) => r.source === "local");

  const fullExactLocal = useMemo(
    () => (groups.find((g) => g.quality === "exact")?.runs ?? []).filter((r) => r.source === "local"),
    [groups],
  );

  const matrixCells: MatrixCell[] = useMemo(
    () =>
      PROMPT_IDS.flatMap((promptId) =>
        CTX_SIZES.map((numCtx) => {
          const infeasible = promptId === "long_context" && numCtx === 4096;
          const historical = fullExactLocal.find((r) => r.prompt_id === promptId && r.num_ctx === numCtx);
          const live = cells.find((c) => c.promptId === promptId && c.numCtx === numCtx);
          return { promptId, numCtx, infeasible, run: live?.run ?? historical };
        }),
      ),
    [fullExactLocal, cells],
  );

  // Shared by the History card's "Share" (this machine's last Quick result)
  // and each leaderboard row's own Share button (that row's result — a
  // different machine's numbers when the row isn't `mine`). Only substitutes
  // the live `profile` in for a row measured on this machine; another
  // machine's row uses its own recorded hw fields, never the viewer's.
  const cardDataForRun = (r: BenchRun): BenchmarkCardData => {
    const useProfile = r.source === "local" && profile;
    return {
      modelName: r.model_name,
      quant: r.quant,
      chip: useProfile ? (profile.chip ?? r.hw.chip) : r.hw.chip,
      memoryGb: useProfile && profile.memory_bytes != null ? profile.memory_bytes / 1024 ** 3 : (r.hw.memory_gb ?? null),
      osVersion: useProfile ? (profile.os_version ?? r.hw.os_version) : r.hw.os_version,
      decodeTps: r.decode_tps_median ?? 0,
      prefillTps: r.prefill_tps_median,
      ttftMs: r.ttft_ms_median,
      suiteLabel: `${r.suite_id} v${r.suite_version} · median of ${r.repeats} run${r.repeats === 1 ? "" : "s"}`,
    };
  };
  const handleShareRun = async (r: BenchRun) => {
    const data = cardDataForRun(r);
    const url = await renderBenchmarkCard(data);
    setShareCard({ data, url });
  };
  const handleShare = () => mine && void handleShareRun(mine);

  return (
    <>
      <PageHeader
        eyebrow="Manage"
        title="Benchmarks"
        subtitle="A fixed suite, run locally. Same prompts, same seed, same token counts every time."
        actions={
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2.5 rounded-full border border-hair bg-inset px-3.5 py-1.5">
              <span className={`size-1.5 rounded-full ${profile ? "bg-ok" : "bg-hair2"}`} aria-hidden />
              <span className="text-[12.5px] font-semibold text-fg">
                {profile?.chip ?? profile?.model_name ?? "This Mac"}
              </span>
              <span className="data text-[11px] text-fg-subtle">
                {[
                  profile?.memory_bytes != null && formatBytes(profile.memory_bytes),
                  profile?.os_version && `macOS ${profile.os_version}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <div className="data flex items-center gap-1.5 text-[11px] text-fg-subtle">
              <span>
                median <span className="text-fg-muted">{yourTps != null ? `${yourTps.toFixed(1)} t/s` : "—"}</span>
              </span>
              <span>·</span>
              <span>
                {yours?.runs.length ?? 0} run{(yours?.runs.length ?? 0) === 1 ? "" : "s"}
              </span>
              <span>·</span>
              <span>{allowance ? allowance.allowance - allowance.used : "—"} reviews left</span>
            </div>
          </div>
        }
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <RunSetupCard
          modelId={modelId}
          setSelected={setSelected}
          installed={installed}
          profile={profile}
          running={running}
          mode={mode}
          setMode={setMode}
          repeatsMode={repeatsMode}
          setRepeatsMode={setRepeatsMode}
          onRun={() => modelId && run(modelId, mode, repeatsMode)}
        />
        <LiveRunCard
          running={running}
          progress={progress}
          waveform={waveform}
          runProgress={runProgress}
          elapsedMs={elapsedMs}
          mine={mine}
        />
        <HistoryCard
          history={history}
          historyScope={historyScope}
          setHistoryScope={setHistoryScope}
          allowance={allowance}
          onShare={handleShare}
          canShare={!!mine}
        />
      </div>

      <div className="h-px bg-hair" />

      <div className="flex flex-wrap items-center gap-2.5">
        <Tabs
          ariaLabel="Benchmarks view"
          value={tab}
          onChange={setTab}
          items={[
            { key: "suite", label: "Suite" },
            { key: "leaderboard", label: "Leaderboard" },
            { key: "community", label: "Community" },
          ]}
        />
        <span className="data ml-auto text-[11px] text-fg-subtle">{TAB_HINT[tab]}</span>
      </div>

      {tab === "suite" && mode === "quick" && (
        <section className="card overflow-hidden">
          {total === 0 && !running ? (
            <p className="px-4 py-10 text-center text-sm text-fg-muted">
              {modelId
                ? "No results yet for this model. Run the suite to record the first one."
                : "Install a model to benchmark it."}
            </p>
          ) : (
            <>
              <div className="label-caps grid grid-cols-[minmax(0,1.5fr)_96px_96px_minmax(0,1fr)_86px] gap-3.5 border-b border-hair bg-inset px-4 py-2.5">
                <span>Machine</span>
                <span className="text-right">Decode</span>
                <span className="text-right">Prefill</span>
                <span>vs the fastest here</span>
                <span className="text-right">Peak mem</span>
              </div>
              {quickGroups
                .flatMap((g) => g.runs)
                .map((r) => {
                  const best = Math.max(
                    ...quickGroups.flatMap((g) => g.runs).map((x) => x.decode_tps_median ?? 0),
                    1,
                  );
                  const isMine = r.source === "local";
                  return (
                    <div
                      key={r.id}
                      className={[
                        "grid grid-cols-[minmax(0,1.5fr)_96px_96px_minmax(0,1fr)_86px] items-center gap-3.5 border-b border-hair px-4 py-3",
                        isMine ? "bg-accent-soft" : "",
                      ].join(" ")}
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className={`text-[13px] font-medium ${isMine ? "text-accent-text" : "text-fg"}`}>
                          {r.hw.chip}
                          {isMine && " — this Mac"}
                        </span>
                        <span className="data truncate text-[10.5px] text-fg-subtle">
                          {[r.hw.gpu_cores && `${r.hw.gpu_cores}-core GPU`, r.hw.memory_gb && `${r.hw.memory_gb} GB`]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="data text-right text-[13px] text-fg">
                        {r.decode_tps_median != null ? `${r.decode_tps_median.toFixed(1)}` : "—"}
                      </span>
                      <span className="data text-right text-[12px] text-fg-muted">
                        {r.prefill_tps_median != null ? r.prefill_tps_median.toFixed(0) : "—"}
                      </span>
                      <Meter
                        fraction={(r.decode_tps_median ?? 0) / best}
                        color={isMine ? "var(--accent)" : "var(--hair2)"}
                        height={6}
                      />
                      <span className="data text-right text-[12px] text-fg-muted">
                        {r.peak_rss_bytes != null ? formatBytes(r.peak_rss_bytes) : "—"}
                      </span>
                    </div>
                  );
                })}
              <p className="px-4 py-3 text-[11.5px] leading-[1.5] text-fg-subtle">
                Every task runs three times after a warm-up; the median is recorded. Same prompts, same seed,
                same token counts on every machine.
              </p>
            </>
          )}
        </section>
      )}

      {tab === "suite" && mode === "full" && (
        <section className="flex flex-col gap-3">
          <BenchMatrix
            promptIds={PROMPT_IDS}
            ctxSizes={CTX_SIZES}
            cells={matrixCells}
            onSelect={(promptId, numCtx) => {
              setLeaderboardScope("full");
              setCellFilter({ promptId, numCtx });
              setTab("leaderboard");
            }}
          />
          <p className="max-w-[640px] text-[11.5px] leading-[1.55] text-fg-subtle">
            Short, long-context, and generation-heavy prompts across three context sizes — a cell is skipped
            (n/a) where the prompt and its capped output can't fit. Fast mode runs the generation-heavy cells
            once instead of three times to keep a Full run shorter; every other cell always runs three.
          </p>
        </section>
      )}

      {tab === "leaderboard" && (
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <Tabs
              ariaLabel="Leaderboard suite"
              value={leaderboardScope}
              onChange={setLeaderboardScope}
              items={[
                { key: "quick", label: "Quick" },
                { key: "full", label: "Full" },
              ]}
            />
            {leaderboardScope === "full" && (
              <div className="flex flex-wrap gap-1.5">
                {FEASIBLE_CELLS.map((c) => {
                  const active = cellFilter.promptId === c.promptId && cellFilter.numCtx === c.numCtx;
                  return (
                    <button
                      key={`${c.promptId}@${c.numCtx}`}
                      type="button"
                      onClick={() => setCellFilter(c)}
                      className={[
                        "data rounded-full border px-2.5 py-1 text-[10.5px]",
                        active ? "border-accent bg-accent-soft text-accent-text" : "border-hair text-fg-muted hover:text-fg",
                      ].join(" ")}
                    >
                      {c.promptId} · {(c.numCtx / 1024).toFixed(0)}k
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {groups.length === 0 ? (
            <p className="card px-4 py-10 text-center text-sm text-fg-muted">
              No results to rank yet — run the suite first.
            </p>
          ) : (
            groups.map((g) => (
              <Group
                key={g.quality}
                group={g}
                unlocked={unlocked}
                canUnlock={!!allowance && allowance.used < allowance.allowance}
                onUnlock={unlockReview}
                onShareRun={handleShareRun}
              />
            ))
          )}
          <p className="max-w-[640px] text-[11.5px] leading-[1.55] text-fg-subtle">
            Models are ranked by decode tok/s within each hardware-match tier — a number from a looser
            match is never shown as if it came from an identical Mac.
          </p>
        </div>
      )}

      {tab === "community" && (
        <section className="card flex flex-col gap-3 p-5">
          <span className="label-caps">Community results</span>
          <NotBuiltYet>
            Shared runs from machines like yours, so you can tell a slow model from a slow Mac. There is no
            results server to publish to or read from yet, so nothing here is populated — the Leaderboard tab
            ranks the runs measured on this machine, which are real.
          </NotBuiltYet>
          <p className="max-w-[640px] text-[11.5px] leading-[1.55] text-fg-subtle">
            When it lands, a published run carries chip, memory, model, quant and timings — never a prompt or a
            response — and only after you opt in.
          </p>
        </section>
      )}

      {shareCard && (
        <ShareCardModal data={shareCard.data} url={shareCard.url} onClose={() => setShareCard(null)} />
      )}
    </>
  );
}

/** Segmented pill toggle, buttons evenly split (unlike `ui/Tabs.tsx`'s
 *  content-sized pills) — matches the run-setup card's Quick/Full and
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
    <div className="flex gap-1 rounded-[10px] border border-hair bg-inset p-[3px]">
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.key)}
            className={[
              "flex-1 rounded-[7px] font-medium transition-colors duration-150 ease-out",
              small ? "py-1.5 text-[10.5px]" : "py-2 text-[13px]",
              active
                ? "bg-accent-soft font-semibold text-accent-text shadow-[inset_0_0_0_1px_var(--accent-line)]"
                : "text-fg-muted hover:text-fg",
              "disabled:pointer-events-none disabled:opacity-50",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
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
  mode,
  setMode,
  repeatsMode,
  setRepeatsMode,
  onRun,
}: {
  modelId: string | null;
  setSelected: (id: string) => void;
  installed: LibraryModel[];
  profile: HardwareProfile | null;
  running: boolean;
  mode: BenchSuiteKind;
  setMode: (m: BenchSuiteKind) => void;
  repeatsMode: BenchRepeatsMode;
  setRepeatsMode: (m: BenchRepeatsMode) => void;
  onRun: () => void;
}) {
  return (
    <div className="card flex flex-col overflow-hidden md:aspect-square">
      <div className="flex items-center justify-between border-b border-hair bg-inset px-5 py-3">
        <span className="label-caps text-[10px]">Run setup</span>
        <span className="data text-[10.5px] text-fg-subtle">
          {mode === "full" ? "prompt × context matrix" : "one fixed prompt"}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-5 px-5 py-5">
        <div className="flex flex-col gap-2">
          <span className="label-caps text-[10px]">Model</span>
          <ModelSelect
            value={modelId ?? ""}
            onChange={setSelected}
            models={installed}
            profile={profile}
            disabled={installed.length === 0 || running}
            variant="field"
            ariaLabel="Benchmark model"
            placeholder={installed.length === 0 ? "No models installed" : "Choose a model…"}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="label-caps text-[10px]">Suite</span>
          <SegToggle
            value={mode}
            onChange={setMode}
            disabled={running}
            options={[
              { key: "quick", label: "Quick" },
              { key: "full", label: "Full" },
            ]}
          />
        </div>

        {mode === "full" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="label-caps text-[10px]">Rigor</span>
              <span className="data text-[10px] text-fg-subtle">
                {repeatsMode === "thorough" ? "3 runs everywhere" : "generation-heavy runs once"}
              </span>
            </div>
            <SegToggle
              value={repeatsMode}
              onChange={setRepeatsMode}
              disabled={running}
              options={[
                { key: "fast", label: "Fast" },
                { key: "thorough", label: "Thorough" },
              ]}
            />
          </div>
        )}
      </div>
      <div className="px-5 pb-5">
        <PrimaryButton className="w-full justify-center" onClick={onRun} disabled={!modelId || running}>
          {running ? <Spinner small /> : <ZapIcon className="size-3.5" />}
          {running ? "Running…" : mode === "full" ? "Run full suite" : "Run benchmark"}
        </PrimaryButton>
      </div>
    </div>
  );
}

/** Live throughput while a suite runs — a real waveform sampled from token
 *  arrival timing (backend `sample` events), not a client-side simulation.
 *  Idle, it shows the last Quick result instead. */
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
  const liveTps = waveform.length ? waveform[waveform.length - 1] : null;
  const displayTps = running ? liveTps : (mine?.decode_tps_median ?? null);
  const max = Math.max(...waveform, 1);

  const title = running ? "Benchmarking" : mine ? "Last result" : "No runs yet";
  const meta = running
    ? (progress ?? "starting")
    : mine
      ? `${mine.model_name} · ${formatRelativeTime(mine.updated_at)}`
      : "";
  const footer = running
    ? "live decode rate"
    : mine
      ? `median of ${mine.repeats} run${mine.repeats === 1 ? "" : "s"}`
      : "run a benchmark to see it here";

  const totalSegments = runProgress?.total ?? mine?.repeats ?? 3;
  const filledSegments = running ? (runProgress?.index ?? 0) : totalSegments;

  return (
    <div className={`card flex flex-col overflow-hidden md:aspect-square ${running ? "border-accent-line" : ""}`}>
      <div className="flex items-center justify-between border-b border-hair bg-inset px-5 py-3">
        <div className="flex items-center gap-2.5">
          {running && <span className="size-2 rounded-full bg-accent animate-pulse-dot" aria-hidden />}
          <span className="label-caps text-[10px] text-fg-muted">{title}</span>
        </div>
        <span className="data truncate text-[10.5px] text-fg-subtle">{meta}</span>
      </div>

      <div className="flex flex-1 flex-col justify-center gap-6 px-5 py-5">
        <div className="flex items-baseline justify-center gap-2">
          <span
            className={`data text-[48px] leading-none font-bold tracking-tight ${running ? "text-fg" : "text-fg-muted"}`}
          >
            {displayTps != null ? displayTps.toFixed(1) : "—"}
          </span>
          <span className="data text-sm text-fg-subtle">tok/s</span>
        </div>

        <div className={`flex h-[100px] items-end gap-[2px] transition-opacity ${running ? "opacity-100" : "opacity-25"}`}>
          {waveform.map((v, i) => (
            <span
              key={i}
              className="min-w-[2px] flex-1 rounded-[2px]"
              style={{
                height: `${Math.max(3, Math.min(100, (v / max) * 100))}%`,
                background: "linear-gradient(180deg, var(--accent-text), var(--accent-soft))",
              }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5 px-5 pb-5">
        <div className="flex gap-1.5">
          {Array.from({ length: totalSegments }).map((_, i) => (
            <span key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-hair">
              <span
                className="block h-full rounded-full bg-accent transition-[width]"
                style={{ width: i < filledSegments ? "100%" : "0%" }}
              />
            </span>
          ))}
        </div>
        <div className="data flex items-center justify-between text-[11px] text-fg-subtle">
          <span className="truncate">{footer}</span>
          {running && <span>{formatElapsed(elapsedMs)}</span>}
        </div>
      </div>
    </div>
  );
}

/** Recent runs, chronological (`bench_history`) — distinct from the
 *  leaderboard's rank-by-speed view below. */
function HistoryCard({
  history,
  historyScope,
  setHistoryScope,
  allowance,
  onShare,
  canShare,
}: {
  history: BenchRun[];
  historyScope: "this" | "all";
  setHistoryScope: (s: "this" | "all") => void;
  allowance: ReviewAllowance | null;
  onShare: () => void;
  canShare: boolean;
}) {
  const rows = history.slice(0, 5);
  const max = Math.max(...history.map((r) => r.decode_tps_median ?? 0), 1);
  const modelCount = new Set(history.map((r) => r.model_digest)).size;
  const footer =
    historyScope === "all"
      ? `${history.length} run${history.length === 1 ? "" : "s"} · ${modelCount} model${modelCount === 1 ? "" : "s"}`
      : allowance
        ? `${history.length} run${history.length === 1 ? "" : "s"} · ${allowance.allowance - allowance.used}/${allowance.allowance} reviews left`
        : `${history.length} run${history.length === 1 ? "" : "s"}`;

  return (
    <div className="card flex flex-col overflow-hidden md:aspect-square">
      <div className="flex items-center justify-between gap-3 border-b border-hair bg-inset px-5 py-3">
        <span className="label-caps text-[10px]">History</span>
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

      <div className="flex flex-1 flex-col overflow-y-auto py-1">
        {rows.length === 0 ? (
          <p className="flex flex-1 items-center justify-center px-5 text-center text-[12.5px] text-fg-muted">
            No runs yet.
          </p>
        ) : (
          rows.map((r, i) => (
            <div key={r.id} className="grid grid-cols-[1fr_74px] items-center gap-3 px-5 py-2.5">
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="data truncate text-[12.5px] font-medium text-fg">{r.model_name}</span>
                  <span className="data shrink-0 text-[10.5px] text-fg-subtle">{formatRelativeTime(r.updated_at)}</span>
                </div>
                <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-hair">
                  <span
                    className="block h-full rounded-full bg-accent"
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

      <div className="flex items-center justify-between gap-2.5 border-t border-hair px-5 py-4">
        <span className="data truncate text-[11px] text-fg-subtle">{footer}</span>
        <div className="flex shrink-0 gap-1.5">
          <GhostButton onClick={onShare} disabled={!canShare} className="h-7 text-[11.5px]">
            Share
          </GhostButton>
        </div>
      </div>
    </div>
  );
}

function Group({
  group,
  unlocked,
  canUnlock,
  onUnlock,
  onShareRun,
}: {
  group: MatchGroup;
  unlocked: Set<string>;
  canUnlock: boolean;
  onUnlock: (id: string) => Promise<boolean>;
  onShareRun: (run: BenchRun) => void;
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
      <div className="card overflow-hidden">
        {group.runs.map((r, i) => {
          const mine = r.source === "local";
          return (
            <div
              key={r.id}
              className={[
                "grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1.3fr)_78px_minmax(0,1fr)_34px] items-center gap-3 border-b border-hair px-4 py-2.5 last:border-b-0",
                mine ? "bg-accent-soft" : "",
              ].join(" ")}
            >
              <span className="data text-[11px] text-fg-subtle">{i + 1}</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={`truncate text-[12.5px] font-medium ${mine ? "text-accent-text" : "text-fg"}`}>
                  {r.model_name}
                  {r.quant && <span className="data ml-1.5 text-[10.5px] font-normal text-fg-subtle">{r.quant}</span>}
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
              <ReviewCell
                run={r}
                isUnlocked={mine || unlocked.has(r.id)}
                canUnlock={canUnlock}
                onUnlock={onUnlock}
              />
              <button
                type="button"
                onClick={() => onShareRun(r)}
                disabled={r.decode_tps_median == null}
                title="Share a card of this result"
                className="flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:text-fg disabled:pointer-events-none disabled:opacity-30"
              >
                <DownloadIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * A written review, gated behind the weekly allowance.
 *
 * Ratings and every measured number stay visible — only the prose is gated, and
 * your own results are never gated at all.
 */
function ReviewCell({
  run,
  isUnlocked,
  canUnlock,
  onUnlock,
}: {
  run: BenchRun;
  isUnlocked: boolean;
  canUnlock: boolean;
  onUnlock: (id: string) => Promise<boolean>;
}) {
  const stars = run.rating != null ? "★".repeat(run.rating) + "☆".repeat(5 - run.rating) : null;
  if (!run.review) {
    return <span className="text-[11px] text-warn">{stars ?? ""}</span>;
  }
  if (isUnlocked) {
    return (
      <span className="min-w-0 truncate text-[11px] text-fg-muted" title={run.review}>
        {stars && <span className="mr-1.5 text-warn">{stars}</span>}
        {run.review}
      </span>
    );
  }
  return (
    <GhostButton
      disabled={!canUnlock}
      onClick={() => void onUnlock(run.id)}
      title={canUnlock ? "Open this review" : "You've opened every review in this week's allowance"}
      className="h-7 text-[11px]"
    >
      <LockIcon className="size-3" />
      {stars && <span className="text-warn">{stars}</span>}
      {canUnlock ? "Read review" : "Limit reached"}
    </GhostButton>
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

  const filename = `anchor-benchmark-${data.modelName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Date.now()}.png`;
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
          <button type="button" onClick={onClose} className="text-fg-subtle transition-colors hover:text-fg">
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

/** Local copy of the app's small spinner (mirrors `ModelComparison.tsx`'s). */
function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      className={`${small ? "size-3 border" : "size-4 border-2"} animate-spin rounded-full border-hair2 border-t-current`}
      aria-hidden
    />
  );
}
