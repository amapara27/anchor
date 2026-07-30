import type { LibraryModel } from "../types";
import type { SlotState } from "../lib/useComparison";
import { formatBytes, formatDuration, formatTokSec, tokensPerSecond } from "../lib/format";
import { SparkleIcon, WarningIcon, ZapIcon } from "./icons";
import { ProgressTrack } from "./DownloadProgressBar";
import { StatCard } from "./ui/StatCard";

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
          <div className="label-caps text-[10px]">
            Model {slotLabel}
          </div>
          <h3 className="data truncate text-lg font-semibold text-fg">{model?.name ?? "—"}</h3>
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
        <StatRow stats={state.stats} sizeBytes={model?.size_bytes} />
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
        <div className="shimmer h-3 w-11/12 rounded bg-inset" />
        <div className="shimmer h-3 w-4/5 rounded bg-inset" />
        <div className="shimmer h-3 w-2/3 rounded bg-inset" />
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

function StatRow({
  stats,
  sizeBytes,
}: {
  stats: NonNullable<SlotState["stats"]>;
  sizeBytes?: number | null;
}) {
  const tokSec = tokensPerSecond(stats);
  // Time to first token ≈ model load + prompt evaluation.
  const ttftNs =
    stats.load_duration_ns != null || stats.prompt_eval_duration_ns != null
      ? (stats.load_duration_ns ?? 0) + (stats.prompt_eval_duration_ns ?? 0)
      : null;
  return (
    <div className="mt-4 border-t border-hair pt-4">
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          recessed
          compact
          label="Throughput"
          value={
            <span className="flex items-center gap-1.5 text-accent-text">
              <ZapIcon className="size-4" />
              {formatTokSec(tokSec)}
            </span>
          }
        />
        <StatCard recessed compact label="TTFT" value={formatDuration(ttftNs)} sub="load + prompt eval" />
        <StatCard recessed compact label="Total" value={formatDuration(stats.total_duration_ns)} />
        <StatCard
          recessed
          compact
          label="Tokens"
          value={`${stats.prompt_eval_count ?? "—"}→${stats.eval_count ?? "—"}`}
          sub="prompt→response"
        />
      </div>
      {sizeBytes != null && (
        <div className="mt-2 flex items-baseline justify-between px-1">
          <span className="label-caps text-[10px]">Memory footprint</span>
          <span className="mono-metric text-xs text-fg">{formatBytes(sizeBytes)}</span>
        </div>
      )}
    </div>
  );
}

const PHASE_META: Record<SlotState["phase"], { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "text-fg-subtle ring-hair" },
  queued: { label: "Queued", cls: "text-fg-muted ring-hair" },
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
        "rounded-md bg-inset px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        meta.cls,
      ].join(" ")}
    >
      {meta.label}
    </span>
  );
}
