/** Shared page header: uppercase eyebrow, large title, muted subtitle. */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">
        {eyebrow}
      </span>
      <h1 className="text-3xl font-semibold tracking-tight text-fg">{title}</h1>
      <p className="text-sm text-fg-muted">{subtitle}</p>
    </header>
  );
}
