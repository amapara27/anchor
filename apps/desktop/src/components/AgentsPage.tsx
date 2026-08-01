import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AgentRun } from "../types";
import { runDetail, useAgentRuns } from "../lib/useAgentRuns";
import { WORKFLOW_CATEGORY, WORKFLOW_TEMPLATES, TOOL_META } from "../lib/workflows";
import { PageHeader, GhostButton, PrimaryButton } from "./PageHeader";
import { StatCard } from "./ui/StatCard";
import { Tabs } from "./ui/Tabs";
import { ResearchAssistant } from "./ResearchAssistant";
import { PlusIcon, TargetIcon } from "./icons";

type AgentTab = "runs" | "agents";

const TAB_HINT: Record<AgentTab, string> = {
  runs: "Newest first · click a run to inspect its trace",
  agents: "Pinned model and tool set per agent",
};

/** Run status → the dot colour used across the list and the inspector. */
const STATUS_COLOR: Record<string, string> = {
  completed: "var(--ok)",
  failed: "var(--danger)",
};

/** Research phase → the trace bar's tone. Unknown phases fall back to muted. */
const PHASE_COLOR: Record<string, string> = {
  planning: "var(--accent-text)",
  searching: "var(--hair2)",
  synthesizing: "var(--accent)",
};

/** The only agent with an executor behind it; the rest are templates. */
const RUNNABLE = "research-assistant";

const DAY_MS = 86_400_000;
const RUN_COLUMNS = "grid-cols-[minmax(0,1fr)_116px_74px_84px_108px]";

/** Milliseconds → run duration, e.g. "4m 12s" / "48s". */
function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Token count → compact label, e.g. 18200 → "18.2k". */
function formatTokens(n: number | null): string {
  if (n == null) return "—";
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

/** Timestamp → "14:41 today" / "14:41 Mar 3". */
function formatWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return `${time} ${today ? "today" : d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/** Headline figures over the trailing week, derived from the runs themselves. */
function summarise(runs: AgentRun[]) {
  const now = Date.now();
  const week = runs.filter((r) => now - r.started_ms < 7 * DAY_MS);
  const ok = week.filter((r) => r.status === "completed").length;
  const tokens = week.reduce((sum, r) => sum + (r.tokens ?? 0), 0);
  const durations = week.map((r) => r.duration_ms).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;

  // Runs per day for the last 7 days, oldest first, scaled to the busiest day.
  const buckets = Array.from({ length: 7 }, (_, i) => {
    const start = now - (6 - i) * DAY_MS;
    return week.filter((r) => r.started_ms > start - DAY_MS && r.started_ms <= start).length;
  });
  const peak = Math.max(...buckets, 1);

  return {
    count: week.length,
    spark: buckets.map((b) => b / peak),
    okPct: week.length ? Math.round((ok / week.length) * 100) : 0,
    okSub: `${ok} ok · ${week.length - ok} failed`,
    tokens: tokens >= 1000 ? (tokens / 1000).toFixed(1) : `${tokens}`,
    tokensUnit: tokens >= 1000 ? "k" : "",
    median: median ? Math.round(median / 1000) : 0,
  };
}

/**
 * Agents: real run history with per-run traces, plus the agent templates.
 *
 * History is read from SQLite (`agent_runs`) and written by whichever agent ran
 * — today only the Research Assistant, which this page launches in place.
 */
export function AgentsPage() {
  const { runs, loading, reload } = useAgentRuns();
  const [tab, setTab] = useState<AgentTab>("runs");
  const [launched, setLaunched] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<string | null>(null);

  const stats = useMemo(() => summarise(runs), [runs]);
  const run = runs.find((r) => r.id === activeRun) ?? runs[0] ?? null;

  if (launched === RUNNABLE) {
    return (
      <ResearchAssistant
        onBack={() => {
          setLaunched(null);
          reload(); // the run just finished — pick it up in the history
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Agents"
        subtitle="Tool-enabled runs on local models. Every phase, source and token count is logged on this Mac — nothing leaves it but the web searches you ask for."
        actions={
          <>
            <PrimaryButton onClick={() => setLaunched(RUNNABLE)}>
              <PlusIcon className="size-3.5" />
              New run
            </PrimaryButton>
          </>
        }
      />

      <div className="grid grid-cols-4 gap-2.5">
        <StatCard label="Runs · 7 days" value={stats.count} spark={stats.spark} />
        <StatCard label="Completed" value={stats.okPct} unit="%" sub={stats.okSub} />
        <StatCard
          label="Tokens generated"
          value={stats.tokens}
          unit={stats.tokensUnit}
          sub="$0.00 — all local inference"
        />
        <StatCard label="Median duration" value={stats.median} unit="s" sub="over the last 7 days" />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Tabs
          ariaLabel="Agents view"
          value={tab}
          onChange={setTab}
          items={[
            { key: "runs", label: "Run history", count: runs.length },
            { key: "agents", label: "Agents", count: WORKFLOW_TEMPLATES.length },
          ]}
        />
        <span className="data text-[11px] text-fg-subtle">{TAB_HINT[tab]}</span>
      </div>

      {tab === "runs" &&
        (loading ? (
          <div className="card shimmer h-64" aria-hidden />
        ) : runs.length === 0 ? (
          <p className="card px-4 py-10 text-center text-sm text-fg-subtle">
            No runs yet — start one from the Agents tab.
          </p>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-3.5">
            <div className="card overflow-hidden">
              <div
                className={`label-caps grid ${RUN_COLUMNS} gap-2.5 border-b border-hair bg-inset px-3.5 py-2.5`}
              >
                <span>Run</span>
                <span>Model</span>
                <span className="text-right">Time</span>
                <span className="text-right">Tokens</span>
                <span className="text-right">Started</span>
              </div>
              {runs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setActiveRun(r.id)}
                  className={[
                    `grid w-full ${RUN_COLUMNS} cursor-pointer items-center gap-2.5 border-b border-hair px-3.5 py-2.5 text-left`,
                    "transition-colors duration-150 ease-out hover:bg-inset",
                    r.id === run?.id ? "bg-inset shadow-[inset_2px_0_0_var(--accent)]" : "",
                  ].join(" ")}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: STATUS_COLOR[r.status] }}
                      aria-label={r.status}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium text-fg">
                        {AGENT_NAME[r.agent_id] ?? r.agent_id}
                      </span>
                      <span className="data truncate text-[10.5px] text-fg-subtle">{r.task}</span>
                    </span>
                  </span>
                  <span className="data truncate text-[11.5px] text-fg-muted">{r.model}</span>
                  <span className="data text-right text-[11.5px] text-fg-muted">
                    {formatElapsed(r.duration_ms)}
                  </span>
                  <span className="data text-right text-[11.5px] text-fg-muted">
                    {formatTokens(r.tokens)}
                  </span>
                  <span className="data text-right text-[11px] text-fg-subtle">
                    {formatWhen(r.started_ms)}
                  </span>
                </button>
              ))}
            </div>

            {run && <RunInspector run={run} />}
          </div>
        ))}

      {tab === "agents" && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {WORKFLOW_TEMPLATES.map((w) => (
            <div key={w.id} className="card card-interactive flex flex-col gap-3 p-4">
              <div className="flex items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-hair bg-inset">
                  <TargetIcon className="size-4 text-accent-text" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14.5px] font-semibold text-fg">{w.name}</span>
                  <span className="data text-[10.5px] text-fg-subtle">{WORKFLOW_CATEGORY[w.id] ?? "Agent"}</span>
                </span>
              </div>
              <p className="text-[13px] leading-[1.55] text-fg-muted">{w.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {w.tools.map((t) => (
                  <span
                    key={t}
                    className="data rounded-full border border-hair px-2 py-0.5 text-[10.5px] text-fg-muted"
                  >
                    {TOOL_META[t].label}
                  </span>
                ))}
              </div>
              <div className="mt-auto flex items-center gap-2 border-t border-hair pt-2.5">
                <span className="data min-w-0 flex-1 truncate text-[11px] text-fg-subtle">{w.model}</span>
                {w.id === RUNNABLE ? (
                  <PrimaryButton onClick={() => setLaunched(w.id)} className="h-7 text-xs">
                    Spin up
                  </PrimaryButton>
                ) : (
                  <GhostButton disabled title="Awaiting the workflow executor" className="h-7 text-xs">
                    Spin up
                  </GhostButton>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Template id → display name, for run rows (which store only the id). */
const AGENT_NAME: Record<string, string> = Object.fromEntries(
  WORKFLOW_TEMPLATES.map((w) => [w.id, w.name]),
);

/** The selected run in full: its trace, the sources it cited, and the brief. */
function RunInspector({ run }: { run: AgentRun }) {
  const detail = runDetail(run);
  const total = detail.phases.reduce((sum, p) => sum + p.ms, 0) || 1;
  let offset = 0;

  return (
    <div className="card sticky top-0 overflow-hidden">
      <div className="flex flex-col gap-2.5 border-b border-hair px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="size-[7px] rounded-full" style={{ background: STATUS_COLOR[run.status] }} />
          <span className="text-[14.5px] font-semibold text-fg">
            {AGENT_NAME[run.agent_id] ?? run.agent_id}
          </span>
          <span
            className="data ml-auto rounded-full border border-hair px-2 py-0.5 text-[10px] uppercase tracking-[0.06em]"
            style={{ color: STATUS_COLOR[run.status] }}
          >
            {run.status}
          </span>
        </div>
        <p className="text-[12.5px] leading-[1.55] text-fg-muted">{run.task}</p>
        <div className="grid grid-cols-3 gap-2 pt-1">
          <Field label="Model" value={run.model} />
          <Field label="Duration" value={formatElapsed(run.duration_ms)} />
          <Field label="Tokens" value={formatTokens(run.tokens)} />
        </div>
      </div>

      {detail.error && (
        <p className="border-b border-hair px-4 py-3 text-[12.5px] text-danger">{detail.error}</p>
      )}

      {detail.phases.length > 0 && (
        <div className="flex flex-col gap-2.5 border-b border-hair px-4 py-3.5">
          <span className="label-caps">Trace</span>
          {detail.phases.map((p, i) => {
            const width = p.ms / total;
            const left = offset;
            offset += width;
            return (
              <div key={i} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="data rounded-[5px] border border-hair bg-inset px-1.5 py-px text-[9.5px] text-fg-muted">
                    {p.phase}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
                    {PHASE_LABEL[p.phase] ?? p.phase}
                  </span>
                  <span className="data text-[10.5px] text-fg-subtle">{formatElapsed(p.ms)}</span>
                </div>
                <span className="block h-[3px] overflow-hidden rounded-full bg-hair">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      marginLeft: `${left * 100}%`,
                      width: `${width * 100}%`,
                      background: PHASE_COLOR[p.phase] ?? "var(--hair2)",
                    }}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}

      {detail.sources.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-hair px-4 py-3.5">
          <span className="label-caps">Sources · {detail.sources.length}</span>
          {detail.sources.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => openUrl(s.url).catch(() => {})}
              className="flex items-center gap-2.5 rounded-lg border border-hair bg-inset px-2.5 py-2 text-left transition-colors hover:border-hair2"
            >
              <span className="data shrink-0 text-[10.5px] text-fg-subtle">[{i + 1}]</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">{s.title || s.url}</span>
            </button>
          ))}
        </div>
      )}

      {detail.output && (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <span className="label-caps">Brief</span>
          <div className="scrollbar-slim max-h-64 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-[1.6] text-fg-muted">
            {detail.output}
          </div>
        </div>
      )}
    </div>
  );
}

/** Phase id → what actually happened during it. */
const PHASE_LABEL: Record<string, string> = {
  planning: "Decompose the focus into search queries",
  searching: "Search the web and read sources",
  synthesizing: "Draft the cited brief",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="label-caps text-[9.5px]">{label}</span>
      <span className="data truncate text-[11.5px] text-fg">{value}</span>
    </span>
  );
}
