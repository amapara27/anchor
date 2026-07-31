import { useMemo, useState } from "react";
import type { BenchRun } from "../types";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { useBenchmarks, MATCH_LABEL, type MatchGroup } from "../lib/useBenchmarks";
import { formatBytes } from "../lib/format";
import { COMMUNITY_FEED, CONTRIBUTION, WANTED_RUNS } from "../lib/fixtures";
import { PageHeader, GhostButton, PrimaryButton } from "./PageHeader";
import { ModelSelect } from "./ui/ModelSelect";
import { Tabs } from "./ui/Tabs";
import { Toggle } from "./ui/Toggle";
import { Meter } from "./ui/SegmentedBar";
import { LockIcon, ZapIcon } from "./icons";

type BenchTab = "suite" | "leaderboard" | "community";

const TAB_HINT: Record<BenchTab, string> = {
  suite: "median of three runs, after a warm-up",
  leaderboard: "grouped by how closely each machine matches yours",
  community: "shared runs for this configuration",
};

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

/**
 * Benchmarks: run the standard suite on an installed model, then see how the
 * result compares to other machines like this one.
 *
 * The suite and leaderboard are real (`run_benchmark`, `bench_runs_for_model`);
 * results are grouped by match tier and each group is labelled, so a number from
 * a looser match is never presented as though it came from an identical Mac.
 * The Community tab is `lib/fixtures` — there is no results server yet.
 */
export function BenchmarksPage() {
  const { models } = useModels();
  const { profile } = useHardwareProfile();
  const installed = useMemo(() => models.filter((m) => m.status === "installed"), [models]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<BenchTab>("suite");
  const [share, setShare] = useState(false);

  const modelId = selected ?? installed[0]?.id ?? null;
  const { groups, progress, running, error, allowance, unlocked, run, unlockReview } = useBenchmarks(modelId);

  const total = groups.reduce((n, g) => n + g.runs.length, 0);
  const yours = groups.find((g) => g.quality === "exact");
  const yourTps = yours ? medianTps(yours.runs) : null;

  return (
    <>
      <PageHeader
        eyebrow="Manage"
        title="Benchmarks"
        subtitle="A fixed suite, run locally. Compare against machines like yours and publish the run if you want to."
        actions={
          <PrimaryButton onClick={() => modelId && run(modelId)} disabled={!modelId || running}>
            <ZapIcon className="size-3.5" />
            {running ? (progress ?? "Running…") : "Run suite"}
          </PrimaryButton>
        }
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <section className="card flex flex-col gap-3 border-accent-line p-4">
        <div className="flex items-center gap-2.5">
          <span className="label-caps text-accent-text">Your machine</span>
          <span className="data ml-auto text-[10.5px] text-fg-subtle">
            {total} result{total === 1 ? "" : "s"} for this model
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-xl font-semibold tracking-tight text-fg">
            {profile?.chip ?? profile?.model_name ?? "This Mac"}
          </span>
          <span className="data text-[11.5px] text-fg-muted">
            {[
              profile?.gpu_cores != null && `${profile.gpu_cores}-core GPU`,
              profile?.memory_bytes != null && formatBytes(profile.memory_bytes),
              profile?.os_version && `macOS ${profile.os_version}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <Metric label="Decode" value={yourTps != null ? yourTps.toFixed(1) : "—"} unit=" t/s" />
          <Metric
            label="Results"
            value={String(yours?.runs.length ?? 0)}
            unit={yours?.runs.length === 1 ? " run" : " runs"}
          />
          <Metric
            label="Reviews left"
            value={allowance ? String(allowance.allowance - allowance.used) : "—"}
            unit={allowance ? ` / ${allowance.allowance}` : ""}
            accent
          />
        </div>
      </section>

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
        <ModelSelect
          value={modelId ?? ""}
          onChange={setSelected}
          models={installed}
          profile={profile}
          disabled={installed.length === 0 || running}
          variant="pill"
          ariaLabel="Benchmark model"
          placeholder={installed.length === 0 ? "No models installed" : "Choose a model…"}
        />
        <span className="data ml-auto text-[11px] text-fg-subtle">{TAB_HINT[tab]}</span>
      </div>

      {tab === "suite" && (
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
              {groups
                .flatMap((g) => g.runs)
                .map((r) => {
                  const best = Math.max(
                    ...groups.flatMap((g) => g.runs).map((x) => x.decode_tps_median ?? 0),
                    1,
                  );
                  const mine = r.source === "local";
                  return (
                    <div
                      key={r.id}
                      className={[
                        "grid grid-cols-[minmax(0,1.5fr)_96px_96px_minmax(0,1fr)_86px] items-center gap-3.5 border-b border-hair px-4 py-3",
                        mine ? "bg-accent-soft" : "",
                      ].join(" ")}
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className={`text-[13px] font-medium ${mine ? "text-accent-text" : "text-fg"}`}>
                          {r.hw.chip}
                          {mine && " — this Mac"}
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
                        color={mine ? "var(--accent)" : "var(--hair2)"}
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

      {tab === "leaderboard" && (
        <div className="flex flex-col gap-3.5">
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
              />
            ))
          )}
          <p className="max-w-[640px] text-[11.5px] leading-[1.55] text-fg-subtle">
            Results are grouped by how closely the machine matches yours — a number from a looser match is
            never shown as if it came from an identical Mac.
          </p>
        </div>
      )}

      {tab === "community" && (
        <div className="grid grid-cols-[minmax(0,1fr)_322px] items-start gap-3.5">
          <div className="flex flex-col gap-2.5">
            <span className="data self-start rounded-full border border-hair px-2.5 py-1 text-[10px] uppercase tracking-[0.06em] text-fg-subtle">
              sample data · awaiting a results server
            </span>
            {COMMUNITY_FEED.map((f) => (
              <div key={f.id} className="card card-interactive flex flex-col gap-2.5 p-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="data flex size-[26px] items-center justify-center rounded-lg border border-hair bg-inset text-[11px] text-fg-muted">
                    {f.initials}
                  </span>
                  <span className="data text-xs font-medium text-fg">{f.handle}</span>
                  {f.verified && (
                    <span className="data rounded-full border border-accent-line px-2 py-0.5 text-[9.5px] uppercase tracking-[0.06em] text-accent-text">
                      verified run
                    </span>
                  )}
                  <span className="data text-[10.5px] text-fg-subtle">{f.match}</span>
                  <span className="data ml-auto text-[10.5px] text-fg-subtle">{f.when}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3.5 rounded-[9px] border border-hair bg-inset px-3 py-2.5">
                  <Field label="Chip" value={f.chip} />
                  <Field label="Model" value={f.model} />
                  <Field label="Decode" value={f.tps} />
                  <Field label="Peak mem" value={f.mem} />
                </div>
                <p className="text-[13px] leading-[1.6] text-fg-muted">{f.note}</p>
              </div>
            ))}
          </div>

          <div className="sticky top-0 flex flex-col gap-3">
            <div className="card flex flex-col gap-3 p-4">
              <span className="label-caps">Your contribution</span>
              <div className="grid grid-cols-2 gap-2.5">
                <Stat value={String(CONTRIBUTION.published)} label="runs published" />
                <Stat value={String(CONTRIBUTION.upvotes)} label="upvotes received" />
                <Stat value={CONTRIBUTION.rank} label="contributor rank" accent />
                <Stat value={String(CONTRIBUTION.firsts)} label="first-for-chip runs" />
              </div>
              <div className="flex items-center gap-3 border-t border-hair pt-3">
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-[12.5px] text-fg">Publish runs automatically</span>
                  <span className="text-[11px] leading-[1.45] text-fg-subtle">
                    Would send chip, memory, model, quant and timings. Never prompts or output.
                  </span>
                </span>
                <Toggle checked={share} onChange={setShare} label="Publish runs automatically" />
              </div>
            </div>

            <div className="card flex flex-col gap-2.5 p-4">
              <span className="label-caps">Wanted runs</span>
              <p className="text-xs leading-[1.5] text-fg-muted">
                Configurations with fewer than five results. Yours would be the reference.
              </p>
              {WANTED_RUNS.map((w) => (
                <div
                  key={w.name}
                  className="flex items-center gap-2.5 rounded-[9px] border border-hair bg-inset px-2.5 py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="data truncate text-[11.5px] text-fg">{w.name}</span>
                    <span className="data text-[10px] text-fg-subtle">{w.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Metric({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: boolean }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="label-caps text-[9.5px]">{label}</span>
      <span className={`data text-[21px] ${accent ? "text-accent-text" : "text-fg"}`}>
        {value}
        {unit && <span className="text-xs text-fg-muted">{unit}</span>}
      </span>
    </span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="label-caps text-[9.5px]">{label}</span>
      <span className="data text-xs text-fg">{value}</span>
    </span>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className={`data text-xl ${accent ? "text-accent-text" : "text-fg"}`}>{value}</span>
      <span className="text-[11px] text-fg-subtle">{label}</span>
    </span>
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
  const best = Math.max(...group.runs.map((r) => r.decode_tps_median ?? 0), 1);

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13.5px] font-semibold text-fg">{MATCH_LABEL[group.quality]}</span>
        <span className="data text-[11px] text-fg-subtle">
          {group.runs.length} result{group.runs.length === 1 ? "" : "s"}
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
                "grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1.3fr)_78px_minmax(0,1fr)] items-center gap-3 border-b border-hair px-4 py-2.5 last:border-b-0",
                mine ? "bg-accent-soft" : "",
              ].join(" ")}
            >
              <span className="data text-[11px] text-fg-subtle">{i + 1}</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={`truncate text-[12.5px] font-medium ${mine ? "text-accent-text" : "text-fg"}`}>
                  {r.hw.chip}
                  {mine && " — this Mac"}
                </span>
                <span className="data truncate text-[10.5px] text-fg-subtle">
                  {[r.hw.gpu_cores && `${r.hw.gpu_cores}-core GPU`, r.hw.memory_gb && `${r.hw.memory_gb} GB`]
                    .filter(Boolean)
                    .join(" · ")}
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
