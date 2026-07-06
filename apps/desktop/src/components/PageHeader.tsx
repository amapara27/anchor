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
      <span className="label-caps">{eyebrow}</span>
      <h1 className="text-5xl font-bold tracking-[-0.02em] text-fg">{title}</h1>
      <p className="text-base text-fg-muted">{subtitle}</p>
    </header>
  );
}
