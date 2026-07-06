// Boxless statistic: a small label over a large mono/tabular value. Replaces the
// per-page <HeroStat>/<Stat> variants so numbers read consistently everywhere.
export function Figure({
  label,
  value,
  sub,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={["flex flex-col gap-1", className].join(" ")}>
      <span className="label-caps">{label}</span>
      <span className="data text-2xl font-medium leading-none text-fg">{value}</span>
      {sub ? <span className="text-xs text-fg-muted">{sub}</span> : null}
    </div>
  );
}
