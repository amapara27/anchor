/** Compact label/value chip used along the bottom of a model card. */
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
    <span
      className="inline-flex items-center gap-1.5 rounded-md bg-white/4 px-2 py-1 text-xs text-fg-muted ring-1 ring-inset ring-white/8"
      title={label}
    >
      <span className="text-fg-subtle">{icon}</span>
      <span className="data text-[12px] text-fg">{value}</span>
    </span>
  );
}
