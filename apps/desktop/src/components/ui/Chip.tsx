// Small flat pill for tags, use-cases, and capability badges. Replaces the
// inline pill markup that was duplicated across the model cards and drawer.
export function Chip({
  children,
  title,
  className = "",
}: {
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={[
        "inline-flex items-center rounded-full bg-white/5 px-2 py-0.5",
        "text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-white/10",
        className,
      ].join(" ")}
    >
      {children}
    </span>
  );
}
