import { useMemo, useState } from "react";
import type { BenchRun } from "../types";
import { useModels } from "../lib/useModels";
import { useBenchmarks, MATCH_LABEL, type MatchGroup } from "../lib/useBenchmarks";
import { formatBytes } from "../lib/format";
import { PageHeader } from "./PageHeader";
import { DataTable, Td, Th, Tr } from "./ui/DataTable";
import { Button } from "./ui/Button";
import { Figure } from "./ui/Figure";
import { LockIcon, ZapIcon } from "./icons";

/** Median of the group's decode throughput — what the tier is summarised by. */
function medianTps(runs: BenchRun[]): number | null {
  const xs = runs.map((r) => r.decode_tps_median).filter((x): x is number => x != null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

/**
 * Benchmarks: run the standard suite on an installed model, then see how the
 * result compares to other machines like this one.
 *
 * Results are grouped by match tier and each group is labelled, so a number from
 * a looser match is never presented as though it came from an identical Mac.
 */
export function BenchmarksPage() {
  const { models } = useModels();
  const installed = useMemo(() => models.filter((m) => m.status === "installed"), [models]);
  const [selected, setSelected] = useState<string | null>(null);
  const modelId = selected ?? installed[0]?.id ?? null;

  const { groups, progress, running, error, allowance, unlocked, run, unlockReview } =
    useBenchmarks(modelId);

  const total = groups.reduce((n, g) => n + g.runs.length, 0);
  const yours = groups.find((g) => g.quality === "exact");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Benchmarks"
        title="Real speed, real hardware"
        subtitle="Run a standard benchmark and compare it against results from machines like yours."
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap items-end gap-6">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          <span className="label-caps">Model</span>
          <select
            value={modelId ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            className="data rounded-md bg-surface-raised px-2.5 py-1.5 text-sm text-fg ring-1 ring-inset ring-white/10"
          >
            {installed.length === 0 && <option value="">No models installed</option>}
            {installed.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        <Button onClick={() => modelId && run(modelId)} disabled={!modelId || running}>
          <ZapIcon className="size-3.5" />
          {running ? (progress ?? "Running…") : "Run benchmark"}
        </Button>

        {yours && (
          <Figure
            label="Your Mac"
            value={`${medianTps(yours.runs)?.toFixed(1) ?? "—"} tok/s`}
            sub={`median of ${yours.runs.length} result${yours.runs.length === 1 ? "" : "s"}`}
          />
        )}
        {allowance && (
          <Figure
            label="Reviews this week"
            value={`${allowance.used} / ${allowance.allowance}`}
            sub="written reviews you've opened"
          />
        )}
      </div>

      {total === 0 && !running && (
        <p className="text-sm text-fg-muted">
          {modelId
            ? "No results yet for this model. Run the benchmark to add the first one."
            : "Install a model to benchmark it."}
        </p>
      )}

      {groups.map((g) => (
        <Group
          key={g.quality}
          group={g}
          unlocked={unlocked}
          canUnlock={!!allowance && allowance.used < allowance.allowance}
          onUnlock={unlockReview}
        />
      ))}
    </div>
  );
}

function Group({
  group,
  unlocked,
  canUnlock,
  onUnlock,
}: {
  group: MatchGroup;
  unlocked: Set<string>;
  canUnlock: boolean;
  onUnlock: (id: string) => Promise<boolean>;
}) {
  const median = medianTps(group.runs);
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold text-fg">{MATCH_LABEL[group.quality]}</h2>
        <span className="text-xs text-fg-muted">
          {group.runs.length} result{group.runs.length === 1 ? "" : "s"}
          {median != null && ` · median ${median.toFixed(1)} tok/s`}
        </span>
      </div>

      <DataTable>
        <thead>
          <Tr>
            <Th>Machine</Th>
            <Th className="text-right">Generation</Th>
            <Th className="text-right">Prompt</Th>
            <Th className="text-right">Load</Th>
            <Th className="text-right">Peak memory</Th>
            <Th>Review</Th>
          </Tr>
        </thead>
        <tbody>
          {group.runs.map((r) => (
            <Tr key={r.id}>
              <Td>
                <span className="data text-fg">{r.hw.chip}</span>
                <span className="ml-2 text-xs text-fg-muted">
                  {[r.hw.gpu_cores && `${r.hw.gpu_cores}-core GPU`, r.hw.memory_gb && `${r.hw.memory_gb} GB`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </Td>
              <Td className="data text-right">
                {r.decode_tps_median != null ? `${r.decode_tps_median.toFixed(1)} tok/s` : "—"}
              </Td>
              <Td className="data text-right text-fg-muted">
                {r.prefill_tps_median != null ? `${r.prefill_tps_median.toFixed(0)} tok/s` : "—"}
              </Td>
              <Td className="data text-right text-fg-muted">
                {r.load_ms != null ? `${(r.load_ms / 1000).toFixed(1)}s` : "—"}
              </Td>
              <Td className="data text-right text-fg-muted">
                {r.peak_rss_bytes != null ? formatBytes(r.peak_rss_bytes) : "—"}
              </Td>
              <Td>
                <ReviewCell
                  run={r}
                  isUnlocked={r.source === "local" || unlocked.has(r.id)}
                  canUnlock={canUnlock}
                  onUnlock={onUnlock}
                />
              </Td>
            </Tr>
          ))}
        </tbody>
      </DataTable>
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
    return <span className="text-xs text-fg-subtle">{stars ?? "—"}</span>;
  }
  if (isUnlocked) {
    return (
      <span className="text-xs text-fg-muted">
        {stars && <span className="mr-1.5 text-warn">{stars}</span>}
        {run.review}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={!canUnlock}
      onClick={() => void onUnlock(run.id)}
      title={canUnlock ? "Open this review" : "You've opened 3 reviews this week"}
      className="inline-flex items-center gap-1 text-xs text-fg-subtle transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
    >
      <LockIcon className="size-3" />
      {stars && <span className="text-warn">{stars}</span>}
      <span>{canUnlock ? "Read review" : "Limit reached"}</span>
    </button>
  );
}
