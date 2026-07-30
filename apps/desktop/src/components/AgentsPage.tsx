import { useState } from "react";
import type { RunStatus, StepKind } from "../lib/fixtures";
import { AGENT_RUNS, AGENT_STATS, SCHEDULES } from "../lib/fixtures";
import { WORKFLOW_CATEGORY, WORKFLOW_TEMPLATES, TOOL_META } from "../lib/workflows";
import { PageHeader, GhostButton, PrimaryButton } from "./PageHeader";
import { StatCard } from "./ui/StatCard";
import { Tabs } from "./ui/Tabs";
import { Toggle } from "./ui/Toggle";
import { FileIcon, PlayIcon, PlusIcon, TargetIcon } from "./icons";

type AgentTab = "runs" | "agents" | "schedules";

const TAB_HINT: Record<AgentTab, string> = {
  runs: "Newest first · click a run to inspect its trace",
  agents: "Pinned model and tool set per agent",
  schedules: "Runs fire only while Anchor is open",
};

/** Status → the dot colour used consistently across runs and schedules. */
const STATUS_COLOR: Record<RunStatus, string> = {
  completed: "var(--ok)",
  stopped: "var(--warn)",
  failed: "var(--danger)",
};

/** Trace step kind → badge tone and timeline bar colour. */
const STEP_STYLE: Record<StepKind, { fg: string; bar: string }> = {
  plan: { fg: "text-accent-text", bar: "var(--accent-text)" },
  tool: { fg: "text-fg-muted", bar: "var(--hair2)" },
  gen: { fg: "text-fg", bar: "var(--accent)" },
  mem: { fg: "text-fg-muted", bar: "var(--hair2)" },
  stop: { fg: "text-danger", bar: "var(--danger)" },
};

const RUN_COLUMNS = "grid-cols-[minmax(0,1fr)_116px_74px_84px_108px]";
const SCHEDULE_COLUMNS = "grid-cols-[minmax(0,1fr)_150px_140px_130px_90px]";

/**
 * Agents: run history with per-run traces, the agent templates, and schedules.
 *
 * The agent templates are real (`lib/workflows`); the run history, traces and
 * schedules come from `lib/fixtures` until `anchor-workflows` grows an executor.
 */
export function AgentsPage() {
  const [tab, setTab] = useState<AgentTab>("runs");
  const [activeRun, setActiveRun] = useState(AGENT_RUNS[0].id);
  const [scheduleOn, setScheduleOn] = useState<Record<string, boolean>>(
    () => Object.fromEntries(SCHEDULES.map((s) => [s.id, s.on])),
  );

  const run = AGENT_RUNS.find((r) => r.id === activeRun) ?? AGENT_RUNS[0];

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Agents"
        subtitle="Tool-enabled runs on local models. Every step, token count and artifact is logged on this Mac — replay or fork any run."
        actions={
          <>
            <GhostButton disabled title="Not wired up yet">
              Export log
            </GhostButton>
            <PrimaryButton disabled>
              <PlusIcon className="size-3.5" />
              New agent
            </PrimaryButton>
          </>
        }
      />

      <div className="grid grid-cols-4 gap-2.5">
        <StatCard
          label="Runs · 7 days"
          value={AGENT_STATS.runsThisWeek}
          spark={AGENT_STATS.runsSpark}
        />
        <StatCard label="Completed" value={AGENT_STATS.completedPct} unit="%" sub={AGENT_STATS.completedSub} />
        <StatCard
          label="Tokens processed"
          value={AGENT_STATS.tokens}
          unit={AGENT_STATS.tokensUnit}
          sub="$0.00 — all local inference"
        />
        <StatCard
          label="Median duration"
          value={AGENT_STATS.medianDuration}
          unit="s"
          sub={AGENT_STATS.slowest}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Tabs
          ariaLabel="Agents view"
          value={tab}
          onChange={setTab}
          items={[
            { key: "runs", label: "Run history" },
            { key: "agents", label: "Agents", count: WORKFLOW_TEMPLATES.length },
            { key: "schedules", label: "Schedules" },
          ]}
        />
        <span className="data text-[11px] text-fg-subtle">{TAB_HINT[tab]}</span>
        <span className="data ml-auto rounded-full border border-hair px-2.5 py-1 text-[10px] uppercase tracking-[0.06em] text-fg-subtle">
          sample data
        </span>
      </div>

      {tab === "runs" && (
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
            {AGENT_RUNS.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setActiveRun(r.id)}
                className={[
                  `grid w-full ${RUN_COLUMNS} cursor-pointer items-center gap-2.5 border-b border-hair px-3.5 py-2.5 text-left`,
                  "transition-colors duration-150 ease-out hover:bg-inset",
                  r.id === activeRun ? "bg-inset shadow-[inset_2px_0_0_var(--accent)]" : "",
                ].join(" ")}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: STATUS_COLOR[r.status] }}
                    aria-label={r.status}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium text-fg">{r.name}</span>
                    <span className="data truncate text-[10.5px] text-fg-subtle">{r.task}</span>
                  </span>
                </span>
                <span className="data truncate text-[11.5px] text-fg-muted">{r.model}</span>
                <span className="data text-right text-[11.5px] text-fg-muted">{r.duration}</span>
                <span className="data text-right text-[11.5px] text-fg-muted">{r.tokens}</span>
                <span className="data text-right text-[11px] text-fg-subtle">{r.when}</span>
              </button>
            ))}
          </div>

          <div className="card sticky top-0 overflow-hidden">
            <div className="flex flex-col gap-2.5 border-b border-hair px-4 py-3.5">
              <div className="flex items-center gap-2">
                <span className="size-[7px] rounded-full" style={{ background: STATUS_COLOR[run.status] }} />
                <span className="text-[14.5px] font-semibold text-fg">{run.name}</span>
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
                <Field label="Duration" value={run.duration} />
                <Field label="Tokens" value={run.tokens} />
              </div>
            </div>

            <div className="flex flex-col gap-2.5 border-b border-hair px-4 py-3.5">
              <span className="label-caps">Trace</span>
              {run.steps.map((st, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`data rounded-[5px] border border-hair bg-inset px-1.5 py-px text-[9.5px] ${STEP_STYLE[st.kind].fg}`}
                    >
                      {st.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{st.label}</span>
                    <span className="data text-[10.5px] text-fg-subtle">{st.duration}</span>
                  </div>
                  <span className="block h-[3px] overflow-hidden rounded-full bg-hair">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        marginLeft: `${st.offset * 100}%`,
                        width: `${st.width * 100}%`,
                        background: STEP_STYLE[st.kind].bar,
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 border-b border-hair px-4 py-3.5">
              <span className="label-caps">Artifacts</span>
              {run.artifacts.map((a) => (
                <div
                  key={a.name}
                  className="flex items-center gap-2.5 rounded-lg border border-hair bg-inset px-2.5 py-2"
                >
                  <FileIcon className="size-3.5 shrink-0 text-fg-muted" />
                  <span className="data min-w-0 flex-1 truncate text-[11.5px] text-fg">{a.name}</span>
                  <span className="data shrink-0 text-[10.5px] text-fg-subtle">{a.size}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 px-4 py-3.5">
              <PrimaryButton disabled className="h-[30px]">
                <PlayIcon className="size-3" />
                Replay run
              </PrimaryButton>
              <GhostButton disabled className="h-[30px]">
                Re-run on another model
              </GhostButton>
            </div>
          </div>
        </div>
      )}

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
                <GhostButton disabled title="Awaiting the workflow executor" className="h-7 text-xs">
                  Spin up
                </GhostButton>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "schedules" && (
        <div className="card overflow-hidden">
          <div
            className={`label-caps grid ${SCHEDULE_COLUMNS} gap-2.5 border-b border-hair bg-inset px-3.5 py-2.5`}
          >
            <span>Agent</span>
            <span>Cadence</span>
            <span>Next run</span>
            <span>Last result</span>
            <span className="text-right">Enabled</span>
          </div>
          {SCHEDULES.map((s) => (
            <div
              key={s.id}
              className={`grid ${SCHEDULE_COLUMNS} items-center gap-2.5 border-b border-hair px-3.5 py-3 transition-colors duration-150 ease-out hover:bg-inset`}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-fg">{s.name}</span>
                <span className="data truncate text-[10.5px] text-fg-subtle">{s.task}</span>
              </span>
              <span className="data text-[11.5px] text-fg-muted">{s.cadence}</span>
              <span className="data text-[11.5px] text-fg-muted">{s.next}</span>
              <span className="data flex items-center gap-2 text-[11.5px] text-fg-muted">
                <span className="size-[5px] rounded-full" style={{ background: STATUS_COLOR[s.status] }} />
                {s.last}
              </span>
              <span className="flex justify-end">
                <Toggle
                  checked={scheduleOn[s.id]}
                  onChange={(next) => setScheduleOn((prev) => ({ ...prev, [s.id]: next }))}
                  label={`Enable ${s.name} schedule`}
                />
              </span>
            </div>
          ))}
          <p className="px-3.5 py-3 text-[11.5px] text-fg-subtle">
            Schedules only fire while Anchor is running. Missed runs are queued, not skipped.
          </p>
        </div>
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="label-caps text-[9.5px]">{label}</span>
      <span className="data truncate text-[11.5px] text-fg">{value}</span>
    </span>
  );
}
