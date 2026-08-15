import type { BenchRun } from "../../types";
import { numCtxFor, SCENARIOS_BY_COST, type Scenario } from "../../lib/scenarios";
import { Meter } from "./SegmentedBar";
import { WarningIcon } from "../icons";

/** One scenario's result, or its absence. */
export interface ScenarioRow {
  scenarioId: string;
  run?: BenchRun;
  /** Started but not finished — the row currently being measured. */
  pending?: boolean;
}

/**
 * The suite, one row per scenario: the shape it measures (prompt tokens in,
 * generation tokens out, derived context) next to what the model managed on
 * it. Rows are in the order the suite runs them, so a live run fills the table
 * top to bottom. No chart library — the same hand-rolled `Meter` the
 * leaderboard uses.
 */
export function ScenarioTable({ rows, onSelect }: { rows: ScenarioRow[]; onSelect?: (scenarioId: string) => void }) {
  const best = Math.max(...rows.map((r) => r.run?.decode_tps_median ?? 0), 1);
  const find = (s: Scenario) => rows.find((r) => r.scenarioId === s.id);
  const cols = "minmax(0,1.6fr) 64px 64px 64px 84px 84px minmax(0,1fr)";

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-hair">
      <div className="min-w-[720px]">
        <div className="label-caps grid gap-px bg-hair" style={{ gridTemplateColumns: cols }}>
          <span className="bg-inset px-3 py-2">Scenario</span>
          <span className="data bg-inset px-3 py-2 text-right">Prompt</span>
          <span className="data bg-inset px-3 py-2 text-right">Gen</span>
          <span className="data bg-inset px-3 py-2 text-right">Ctx</span>
          <span className="data bg-inset px-3 py-2 text-right">Prefill</span>
          <span className="data bg-inset px-3 py-2 text-right">Decode</span>
          <span className="bg-inset px-3 py-2">vs the fastest here</span>
        </div>
        {SCENARIOS_BY_COST.map((s) => {
          const row = find(s);
          const tps = row?.run?.decode_tps_median;
          const ctx = numCtxFor(s);
          return (
            <button
              key={s.id}
              type="button"
              disabled={!row?.run}
              onClick={() => row?.run && onSelect?.(s.id)}
              className="grid w-full items-center gap-px bg-hair text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-default"
              style={{ gridTemplateColumns: cols }}
            >
              <span className="flex min-w-0 flex-col gap-0.5 self-stretch bg-surface px-3 py-2.5">
                <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
                  {s.id}
                  {/* Per-scenario, not per-suite: a long run can heat up partway,
                      so only some rows were measured under pressure. */}
                  {row?.run?.thermal_label === "throttled" && (
                    <WarningIcon
                      className="size-3 shrink-0 text-warn"
                      title="Measured under thermal pressure"
                    />
                  )}
                </span>
                <span className="truncate text-[10.5px] text-fg-subtle">{s.label}</span>
              </span>
              <span className="data self-stretch bg-surface px-3 py-2.5 text-right text-[12px] text-fg-muted">
                {s.promptTokens}
              </span>
              <span className="data self-stretch bg-surface px-3 py-2.5 text-right text-[12px] text-fg-muted">
                {s.genTokens}
              </span>
              <span className="data self-stretch bg-surface px-3 py-2.5 text-right text-[12px] text-fg-subtle">
                {ctx / 1024}k
              </span>
              <span className="data self-stretch bg-surface px-3 py-2.5 text-right text-[12px] text-fg-muted">
                {row?.run?.prefill_tps_median != null ? row.run.prefill_tps_median.toFixed(0) : "—"}
              </span>
              <span className="data self-stretch bg-surface px-3 py-2.5 text-right text-[12.5px] text-fg">
                {tps != null ? tps.toFixed(1) : row?.pending ? "…" : "—"}
              </span>
              <span className="self-stretch bg-surface px-3 py-2.5">
                {tps != null && <Meter fraction={tps / best} height={4} />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
