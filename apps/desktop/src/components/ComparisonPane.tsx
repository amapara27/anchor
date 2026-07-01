import type { LibraryModel } from "../types";
import type { SlotState } from "../lib/useComparison";
import { formatBytes, formatDuration, formatTokSec, tokensPerSecond } from "../lib/format";
import { SparkleIcon, WarningIcon, ZapIcon } from "./icons";
import { ProgressTrack } from "./DownloadProgressBar";

interface ComparisonPaneProps {
  /** "A" / "B" — shown as an eyebrow so the panes are distinguishable. */
  slotLabel: string;
  model?: LibraryModel;
  state: SlotState;
  /** True once both models have finished and the simultaneous reveal began. */
  revealed: boolean;
  /** Shared 0→1 reveal clock so both panes type out and finish together. */
  fraction: number;
  /** Highlight this pane as the faster of the two. */
  fastest?: boolean;
}

export function ComparisonPane({
  slotLabel,
  model,
  state,
  revealed,
  fraction,
  fastest,
}: ComparisonPaneProps) {
  return (
    <div className="card flex min-h-[18rem] flex-col p-5">
      {/* Header: name + phase chip */}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">
            Model {slotLabel}
          </div>
          <h3 className="truncate font-semibold text-fg">{model?.name ?? "—"}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {fastest && revealed && fraction >= 1 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-accent/12 px-2 py-0.5 text-[11px] font-semibold text-accent-text ring-1 ring-inset ring-accent/25">
              <ZapIcon className="size-3" /> Fastest
            </span>
          )}
          <PhaseChip phase={state.phase} />
        </div>
      </div>

      {/* Body */}
      <div
        className="scrollbar-slim mt-4 min-h-0 flex-1 overflow-y-auto"
        aria-live="polite"
      >
        <PaneBody state={state} revealed={revealed} fraction={fraction} />
      </div>

      {/* Stats appear once this pane's text has fully revealed. */}
      {revealed && fraction >= 1 && state.phase === "done" && state.stats && (
        <StatRow stats={state.stats} />
      )}
    </div>
  );
}

function PaneBody({
  state,
  revealed,
  fraction,
}: {
  state: SlotState;
  revealed: boolean;
  fraction: number;
}) {
  if (state.phase === "failed") {
    return (
      <div className="flex items-start gap-2 text-sm text-danger">
        <WarningIcon className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-medium">Couldn’t complete</p>
          <p className="mt-0.5 text-danger/80">{state.error}</p>
          <p className="mt-1 text-xs text-fg-subtle">Adjust your selection and run again.</p>
        </div>
      </div>
    );
  }

  if (state.phase === "downloading") {
    return <DownloadProgress pull={state.pull} />;
  }

  // Revealed: type the buffered response out on the shared clock.
  if (revealed && state.phase === "done") {
    const text = state.response ?? "";
    const shown = text.slice(0, Math.floor(fraction * text.length));
    return (
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">
        {text.length === 0 ? <span className="text-fg-subtle">(empty response)</span> : shown}
        {fraction < 1 && <span className="ml-0.5 inline-block animate-pulse text-accent-text">▍</span>}
      </p>
    );
  }

  // Pre-reveal: every active/finished-but-waiting slot shows the same
  // "Generating…" state — this is the side-by-side illusion.
  return <GeneratingState />;
}

function GeneratingState() {
  return (
    <div className="flex h-full flex-col justify-center gap-3 py-6">
      <div className="flex items-center gap-2 text-sm font-medium text-accent-text">
        <SparkleIcon className="size-4 animate-pulse" />
        Generating…
      </div>
      <div className="space-y-2">
        <div className="shimmer h-3 w-11/12 rounded bg-white/6" />
        <div className="shimmer h-3 w-4/5 rounded bg-white/6" />
        <div className="shimmer h-3 w-2/3 rounded bg-white/6" />
      </div>
    </div>
  );
}

function DownloadProgress({ pull }: { pull?: SlotState["pull"] }) {
  const total = pull?.total ?? 0;
  const completed = pull?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const label = pull?.status ?? "Downloading…";
  return (
    <div className="flex h-full flex-col justify-center gap-2 py-6">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium capitalize text-fg-muted">{label}</span>
        {total > 0 && (
          <span className="data text-fg-subtle">
            {formatBytes(completed)} / {formatBytes(total)}
          </span>
        )}
      </div>
      <ProgressTrack pct={pct} />
    </div>
  );
}

function StatRow({ stats }: { stats: NonNullable<SlotState["stats"]> }) {
  const tokSec = tokensPerSecond(stats);
  return (
    <div className="mt-4 border-t border-white/8 pt-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">
            Throughput
          </div>
          <div className="data flex items-center gap-1.5 text-xl font-semibold text-accent-text">
            <ZapIcon className="size-4" />
            {formatTokSec(tokSec)}
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-right text-xs">
          <Stat label="Total" value={formatDuration(stats.total_duration_ns)} />
          <Stat label="Load" value={formatDuration(stats.load_duration_ns)} />
          <Stat
            label="Tokens"
            value={`${stats.prompt_eval_count ?? "—"}→${stats.eval_count ?? "—"}`}
          />
        </dl>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="data text-fg">{value}</dd>
    </div>
  );
}

const PHASE_META: Record<SlotState["phase"], { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "text-fg-subtle ring-white/10" },
  queued: { label: "Queued", cls: "text-fg-muted ring-white/10" },
  downloading: { label: "Downloading", cls: "text-accent-text ring-accent/25" },
  loading: { label: "Loading", cls: "text-accent-text ring-accent/25" },
  generating: { label: "Generating", cls: "text-accent-text ring-accent/25" },
  done: { label: "Done", cls: "text-ok ring-ok/30" },
  failed: { label: "Failed", cls: "text-danger ring-danger/30" },
};

function PhaseChip({ phase }: { phase: SlotState["phase"] }) {
  const meta = PHASE_META[phase];
  return (
    <span
      className={[
        "rounded-md bg-white/5 px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        meta.cls,
      ].join(" ")}
    >
      {meta.label}
    </span>
  );
}
