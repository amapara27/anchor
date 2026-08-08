import type { BenchRun } from "../../types";
import { Meter } from "./SegmentedBar";

/** One (prompt, context size) cell of the Full-suite matrix. */
export interface MatrixCell {
  promptId: string;
  numCtx: number;
  run?: BenchRun;
  /** True for a combination the suite never runs — e.g. `long_context` at
   *  4096, which doesn't fit the prompt plus its capped output. */
  infeasible?: boolean;
}

const PROMPT_LABELS: Record<string, string> = {
  short: "Short",
  long_context: "Long context",
  generation_heavy: "Generation-heavy",
};

/**
 * Compact prompt x context-size grid for the Full suite — rows are prompts,
 * columns are context sizes, each landed cell shows decode tok/s with a
 * `Meter` bar. No chart library: same hand-rolled bar the leaderboard uses.
 */
export function BenchMatrix({
  promptIds,
  ctxSizes,
  cells,
  onSelect,
}: {
  promptIds: string[];
  ctxSizes: number[];
  cells: MatrixCell[];
  onSelect?: (promptId: string, numCtx: number) => void;
}) {
  const best = Math.max(...cells.map((c) => c.run?.decode_tps_median ?? 0), 1);
  const find = (promptId: string, numCtx: number) => cells.find((c) => c.promptId === promptId && c.numCtx === numCtx);
  const cols = `minmax(0,1.3fr) repeat(${ctxSizes.length}, minmax(0,1fr))`;

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-hair">
      <div className="label-caps grid gap-px bg-hair" style={{ gridTemplateColumns: cols }}>
        <span className="bg-inset px-3 py-2">Prompt</span>
        {ctxSizes.map((ctx) => (
          <span key={ctx} className="data bg-inset px-3 py-2 text-right">
            {(ctx / 1024).toFixed(0)}k ctx
          </span>
        ))}
      </div>
      {promptIds.map((promptId) => (
        <div key={promptId} className="grid gap-px bg-hair" style={{ gridTemplateColumns: cols }}>
          <span className="bg-surface px-3 py-2.5 text-[12.5px] text-fg">
            {PROMPT_LABELS[promptId] ?? promptId}
          </span>
          {ctxSizes.map((ctx) => {
            const cell = find(promptId, ctx);
            const tps = cell?.run?.decode_tps_median;
            return (
              <button
                key={ctx}
                type="button"
                disabled={!cell?.run}
                onClick={() => cell?.run && onSelect?.(promptId, ctx)}
                className="flex flex-col gap-1.5 bg-surface px-3 py-2.5 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-default"
              >
                {cell?.infeasible ? (
                  <span className="data text-[11px] text-fg-subtle">n/a</span>
                ) : tps != null ? (
                  <>
                    <span className="data text-[12.5px] text-fg">{tps.toFixed(1)}</span>
                    <Meter fraction={tps / best} height={4} />
                  </>
                ) : (
                  <span className="data text-[11px] text-fg-subtle">—</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
