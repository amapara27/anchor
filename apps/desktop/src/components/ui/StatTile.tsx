// Boxed statistic tile: caps label over a big mono value, with an optional
// 1px capacity bar. Only pass `fraction` when it's a real ratio — no fake bars.
export function StatTile({
  label,
  value,
  sub,
  fraction,
  recessed = false,
  compact = false,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** 0–1 fill for the capacity bar; omit to hide the bar. */
  fraction?: number | null;
  /** Darker inset variant for strips inside cards. */
  recessed?: boolean;
  /** Smaller value type for dense strips (hero metric rows). */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={[
        "flex flex-col gap-1.5 rounded-lg p-3",
        recessed ? "bg-white/[0.03]" : "border border-white/8 bg-canvas",
        className,
      ].join(" ")}
    >
      <span className="label-caps">{label}</span>
      <span className={["data font-medium leading-none text-fg", compact ? "text-xl" : "text-[32px]"].join(" ")}>
        {value}
      </span>
      {sub ? <span className="text-xs text-fg-muted">{sub}</span> : null}
      {fraction != null && (
        <span className="mt-1 block h-px w-full overflow-hidden bg-white/8" aria-hidden>
          <span
            className="block h-full bg-accent"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }}
          />
        </span>
      )}
    </div>
  );
}
