/** Compact label/value spec used along the bottom of a model card — flat, no chip. */
export function SpecPill({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted" title={label}>
      <span className="text-fg-subtle">{icon}</span>
      <span className="data text-[12px] text-fg">{value}</span>
    </span>
  );
}
