// Section label that separates content by type scale + spacing, not borders.
// Optional trailing `action` slot (e.g. a view toggle or "see all").
export function SectionHeading({
  children,
  action,
  className = "",
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={["flex items-baseline justify-between", className].join(" ")}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">{children}</h2>
      {action}
    </div>
  );
}
