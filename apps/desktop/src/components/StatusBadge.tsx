import type { ModelStatus } from "../types";
import { CheckIcon, DownloadIcon } from "./icons";

/**
 * Status pill. Colour AND icon AND text carry the meaning, so it never relies
 * on colour alone (a11y: color-not-only).
 */
export function StatusBadge({ status, className = "" }: { status: ModelStatus; className?: string }) {
  const installed = status === "installed";
  const Icon = installed ? CheckIcon : DownloadIcon;
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        installed
          ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30"
          : "bg-white/5 text-fg-muted ring-white/10",
        className,
      ].join(" ")}
    >
      <Icon className="size-3" />
      {installed ? "Installed" : "Available"}
    </span>
  );
}
