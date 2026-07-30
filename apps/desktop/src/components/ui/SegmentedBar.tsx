/** One proportional slice. `fraction` is 0–1 of the whole bar. */
export interface Segment {
  label: string;
  fraction: number;
  /** Any CSS colour — pass a token, e.g. `var(--accent)`. */
  color: string;
  /** Optional human-readable size shown in the legend ("6.8 GB"). */
  detail?: string;
}

/**
 * Multi-segment proportional bar with an optional legend. One component behind
 * the sidebar memory meter, the Models headroom bar, the Storage disk map, and
 * the per-model memory-fit breakdown.
 *
 * Segments need not sum to 1 — the remainder renders as unfilled track, which is
 * exactly what "free memory" should look like.
 */
export function SegmentedBar({
  segments,
  height = 8,
  legend = false,
  className = "",
}: {
  segments: Segment[];
  height?: number;
  legend?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      <span
        className="flex gap-px overflow-hidden rounded-full bg-hair"
        style={{ height }}
        role="img"
        aria-label={segments.map((s) => `${s.label} ${Math.round(s.fraction * 100)}%`).join(", ")}
      >
        {segments.map((s) => (
          <span
            key={s.label}
            title={s.detail ? `${s.label} · ${s.detail}` : s.label}
            style={{ width: `${Math.max(0, Math.min(1, s.fraction)) * 100}%`, background: s.color }}
          />
        ))}
      </span>
      {legend && (
        <div className="flex flex-wrap gap-4">
          {segments.map((s) => (
            <span key={s.label} className="data flex items-center gap-1.5 text-[10.5px] text-fg-subtle">
              <span className="size-[7px] rounded-[2px]" style={{ background: s.color }} />
              {s.label}
              {s.detail && ` ${s.detail}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Single-fill progress track — the fit meters and inline percentage bars. */
export function Meter({
  fraction,
  color = "var(--accent)",
  height = 3,
  className = "",
}: {
  fraction: number;
  color?: string;
  height?: number;
  className?: string;
}) {
  return (
    <span className={`block overflow-hidden rounded-full bg-hair ${className}`} style={{ height }}>
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, background: color }}
      />
    </span>
  );
}
