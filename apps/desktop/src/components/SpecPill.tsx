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
      className="inline-flex items-center gap-1.5 rounded-md bg-slate-800/50 px-2 py-1 text-xs text-slate-400 ring-1 ring-inset ring-slate-700/40"
      title={label}
    >
      <span className="text-slate-500">{icon}</span>
      <span className="tabular text-slate-200">{value}</span>
    </span>
  );
}
