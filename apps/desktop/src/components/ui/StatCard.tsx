import type { ReactNode } from "react";
import { Meter } from "./SegmentedBar";

/**
 * The design's KPI tile: mono caps eyebrow, large mono figure with a smaller
 * trailing unit, and one supporting line. Optionally a sparkline or a fill meter.
 */
export function StatCard({
  label,
  value,
  unit,
  sub,
  /** 0–1; renders a fill meter under the figure. */
  fraction,
  /** Relative bar heights, 0–1. The last entry is highlighted in the accent. */
  spark,
  tone,
  compact,
  recessed,
  className = "",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  fraction?: number | null;
  spark?: number[];
  tone?: "default" | "warn" | "danger" | "accent";
  /** Smaller figure — for tiles packed into a row rather than a KPI band. */
  compact?: boolean;
  /** Sits inside another card: inset fill instead of the raised surface. */
  recessed?: boolean;
  className?: string;
}) {
  const toneClass =
    tone === "warn"
      ? "text-warn"
      : tone === "danger"
        ? "text-danger"
        : tone === "accent"
          ? "text-accent-text"
          : "text-fg";

  return (
    <div
      className={[
        "flex flex-col rounded-[var(--radius-card)] border border-hair",
        recessed ? "bg-inset" : "bg-surface",
        compact ? "gap-1 p-2.5" : "gap-2 p-3.5",
        className,
      ].join(" ")}
    >
      <span className="label-caps">{label}</span>
      <span
        className={`data font-medium leading-none ${compact ? "text-[15px]" : "text-[27px]"} ${toneClass}`}
      >
        {value}
        {unit && <span className={compact ? "text-[11px] text-fg-muted" : "text-[15px] text-fg-muted"}>{unit}</span>}
      </span>
      {spark && (
        <div className="flex h-[22px] items-end gap-[3px]" aria-hidden>
          {spark.map((h, i) => (
            <span
              key={i}
              className={`flex-1 rounded-[2px] ${i >= spark.length - 2 ? "bg-accent" : "bg-hair2"}`}
              style={{ height: `${Math.max(4, Math.min(1, h) * 100)}%` }}
            />
          ))}
        </div>
      )}
      {fraction != null && <Meter fraction={fraction} />}
      {sub && <span className="text-[11.5px] text-fg-muted">{sub}</span>}
    </div>
  );
}
