import type { ModelStatus } from "../types";

/**
 * Minimal status marker: a small dot + text. Text carries the meaning, so it
 * never relies on colour alone (a11y: color-not-only).
 */
export function StatusBadge({ status, className = "" }: { status: ModelStatus; className?: string }) {
  const installed = status === "installed";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 text-xs font-medium",
        installed ? "text-ok" : "text-fg-subtle",
        className,
      ].join(" ")}
    >
      <span className={["size-1.5 shrink-0 rounded-full", installed ? "bg-ok" : "bg-hair2"].join(" ")} />
      {installed ? "Installed" : "Available"}
    </span>
  );
}
