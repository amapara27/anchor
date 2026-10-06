import type { ReactNode } from "react";

/** Shared page title and actions. */
export function PageHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="page-title">{title}</h1>
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
