import type { ReactNode } from "react";

/** Shared page header: mono eyebrow, title, optional blurb, right-aligned actions. */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end gap-5">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="label-caps tracking-[0.08em]">{eyebrow}</span>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {subtitle && <p className="max-w-[560px] text-[13.5px] leading-[1.55] text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="ml-auto flex gap-2">{actions}</div>}
    </header>
  );
}

/** The design's two button weights, shared across every page header. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-accent px-3.5 text-[13px] font-semibold text-accent-fg transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  title,
  tone,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  tone?: "danger";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-hair px-3 text-[13px]",
        "transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        "disabled:pointer-events-none disabled:opacity-40",
        tone === "danger" ? "text-danger hover:border-danger" : "text-fg-muted hover:border-hair2 hover:text-fg",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}
