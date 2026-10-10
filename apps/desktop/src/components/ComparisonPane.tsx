import type { LibraryModel } from "../types";
import type { SlotState } from "../lib/useComparison";
import { formatBytes, formatDuration, formatTokSec, tokensPerSecond } from "../lib/format";
import { WarningIcon } from "./icons";
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
    <div className="flex min-h-[18rem] min-w-0 flex-col border-t border-hair pt-4">
      {/* Header: name + phase chip */}
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <span className="data shrink-0 rounded border border-hair px-1.5 text-[11px] text-fg-muted">{slotLabel}</span>
          <h3 className="truncate text-[14px] font-semibold tracking-tight text-fg">{model?.name ?? "—"}</h3>
          {model && <span className="data truncate text-[11px] text-fg-subtle">{model.id}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {fastest && revealed && fraction >= 1 && (
            <span className="text-[12px] font-medium text-accent-text">Fastest</span>
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

  // Stream real output; a completed pane need not wait for the other model.
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

  if (state.buffer) return <p className="whitespace-pre-wrap text-sm leading-relaxed">{state.buffer}</p>;
  if (state.phase === "queued") return <p className="text-sm text-fg-muted">Waiting for the other model…</p>;
  return <GeneratingState />;
}

function GeneratingState() {
  return (
    <div className="flex h-full flex-col justify-center gap-3 py-6">
      <div className="flex items-center gap-2 text-[13px] text-fg-muted">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" aria-hidden />
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
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="stat-strip">
        <div><span className="stat-k">Throughput</span><span className="stat-v text-[16px]">{formatTokSec(tokSec)}</span></div>
        <div><span className="stat-k">TTFT</span><span className="stat-v text-[16px]">{stats.ttft_ms == null ? "—" : `${Math.round(stats.ttft_ms)} ms`}</span><span className="stat-sub">first received output</span></div>
        <div><span className="stat-k">Total</span><span className="stat-v text-[16px]">{formatDuration(stats.total_duration_ns)}</span></div>
        <div><span className="stat-k">Tokens</span><span className="stat-v text-[16px]">{`${stats.prompt_eval_count ?? "—"}→${stats.eval_count ?? "—"}`}</span><span className="stat-sub">prompt→response</span></div>
      </div>
      {sizeBytes != null && (
        <div className="meta text-[12px]"><span><span className="meta-k">Model size on disk</span><span className="meta-v">{formatBytes(sizeBytes)}</span></span></div>
      )}
    </div>
  );
}

const PHASE_META: Record<SlotState["phase"], { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "text-fg-subtle" },
  queued: { label: "Queued", cls: "text-fg-muted" },
  downloading: { label: "Downloading", cls: "text-accent-text" },
  loading: { label: "Loading", cls: "text-accent-text" },
  generating: { label: "Generating", cls: "text-accent-text" },
  done: { label: "Done", cls: "text-ok" },
  failed: { label: "Failed", cls: "text-danger" },
};

function PhaseChip({ phase }: { phase: SlotState["phase"] }) {
  const meta = PHASE_META[phase];
  return (
    <span className={"flex items-center gap-1.5 text-[12px] " + meta.cls}>
      <span className={"size-1.5 rounded-full bg-current" + (["downloading", "loading", "generating"].includes(phase) ? " animate-pulse-dot" : "")} aria-hidden />
      <span className="text-fg-muted">{meta.label}</span>
    </span>
  );
}
