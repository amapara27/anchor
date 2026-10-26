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
  state?: "Queued" | "Running" | "Stopped" | "Failed";
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
  const grid = "grid grid-cols-[minmax(120px,1.4fr)_64px_60px_40px_60px_60px_64px] lg:grid-cols-[minmax(120px,1.4fr)_84px_76px_56px_76px_76px_76px_minmax(80px,1fr)]";
  const cell = "px-2 py-2.5 lg:px-3";

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-hair">
      <div className="min-w-[528px] lg:min-w-[756px]">
        <div className={`th ${grid} items-center whitespace-nowrap border-b border-hair bg-surface`}>
          <span className={cell}>Scenario</span>
          <span className={cell + " text-right"}>In target</span>
          <span className={cell + " text-right"}>Out cap</span>
          <span className={cell + " text-right"}>Ctx</span>
          <span title="Request dispatch to first nonempty output, in milliseconds" className={cell + " text-right"}>TTFT ms</span>
          <span title="Runtime-reported prompt-processing rate; its window may include first-token work" className={cell + " text-right"}>Prefill</span>
          <span title="Post-first-token decode rate; at least two generated tokens and a supported clock are required" className={cell + " text-right"}>Decode</span>
          <span className={cell + " hidden truncate lg:block"}>relative reported rate</span>
        </div>
        {SCENARIOS_BY_COST.map((s) => {
          const row = find(s);
          const tps = row?.run?.decode_tps_median;
          const ctx = row?.run?.num_ctx ?? numCtxFor(s);
          return (
            <button
              key={s.id}
              title={s.label}
              type="button"
              disabled={!row?.run}
              onClick={() => row?.run && onSelect?.(s.id)}
              className={`${grid} w-full items-center border-b border-hair text-left transition-colors last:border-b-0 enabled:hover:bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-line disabled:cursor-default`}
            >
              <span className={cell + " flex min-w-0 items-center gap-1.5 text-[13px] text-fg"}>
                {row?.pending && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-accent" aria-hidden />}
                <span className="min-w-0">{s.id}{row?.state && <span className={`mt-0.5 block text-[11px] ${row.state === "Failed" || row.state === "Stopped" ? "text-warn" : "text-fg-muted"}`}>{row.state}</span>}</span>
                {/* Per-scenario, not per-suite: a long run can heat up partway,
                    so only some rows were measured under pressure. */}
                {["throttled", "pressure"].includes(row?.run?.thermal_label ?? "") && (
                  <WarningIcon className="size-3 shrink-0 text-warn" title="Measured under thermal pressure" />
                )}
              </span>
              <span className={cell + " data text-right text-[12px] text-fg-muted"}>{s.promptTokens}</span>
              <span className={cell + " data text-right text-[12px] text-fg-muted"}>{s.genTokens}</span>
              <span className={cell + " data text-right text-[12px] text-fg-subtle"}>{ctx / 1024}k</span>
              <span title={row?.run && row.run.ttft_ms_median == null ? "First-output timing is unavailable for one or more repeats" : undefined} className={cell + " data text-right text-[12px] text-fg-muted"}>{row?.run?.ttft_ms_median?.toFixed(0) ?? (row?.run ? "N/A" : "—")}</span>
              <span title={row?.run && row.run.prefill_tps_median == null ? "Usable input, cache or timing counters are unavailable for one or more repeats" : undefined} className={cell + " data text-right text-[12px] text-fg-muted"}>
                {row?.run?.prefill_tps_median != null ? row.run.prefill_tps_median.toFixed(0) : row?.run ? "N/A" : "—"}
              </span>
              <span title={row?.run && tps == null ? "Decode needs at least two generated tokens and a supported timer in every planned repeat" : undefined} className={cell + " data text-right text-[12px] text-fg"}>
                {tps != null ? tps.toFixed(1) : row?.pending ? "…" : row?.run ? "N/A" : "—"}
              </span>
              <span className={cell + " hidden lg:block"}>{tps != null && <Meter fraction={tps / best} height={4} />}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
