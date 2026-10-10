import type { ReactNode } from "react";

/** Shared page title, optional label/value facts beneath it, and actions. */
export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="page-title">{title}</h1>
        {meta && <div className="meta">{meta}</div>}
      </div>
      {actions && <div className="ml-auto flex gap-2">{actions}</div>}
    </header>
  );
}

/** One label/value fact for a `meta` row. */
export function Meta({ k, children }: { k: string; children: ReactNode }) {
  return <span><span className="meta-k">{k}</span><span className="meta-v">{children}</span></span>;
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
      className={`flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-fg px-3.5 text-[13px] font-medium text-canvas transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-40 ${className}`}
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
        "transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
        "disabled:pointer-events-none disabled:opacity-40",
        tone === "danger" ? "text-danger hover:border-danger" : "text-fg hover:border-hair2 hover:bg-inset",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}
