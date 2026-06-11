import { memoryFit } from "../lib/fit";
import { WarningIcon } from "./icons";

/**
 * Pill flagging a model that's a poor fit for the host's memory. Renders nothing
 * for comfortable (`ok`) or unknown fits, so it only ever adds signal. Colour AND
 * icon AND text carry the meaning (a11y: never colour alone).
 */
export function FitBadge({
  minMemoryBytes,
  totalMemoryBytes,
  className = "",
}: {
  minMemoryBytes: number;
  totalMemoryBytes: number | null | undefined;
  className?: string;
}) {
  const tier = memoryFit(minMemoryBytes, totalMemoryBytes);
  if (tier !== "tight" && tier !== "wont_fit") return null;
  const wontFit = tier === "wont_fit";
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        wontFit
          ? "bg-red-950/40 text-red-300 ring-red-900/50"
          : "bg-amber-950/30 text-amber-300 ring-amber-800/40",
        className,
      ].join(" ")}
      title={wontFit ? "Needs more memory than your Mac has" : "Needs most of your Mac's memory"}
    >
      <WarningIcon className="size-3" />
      {wontFit ? "Won't fit" : "Tight"}
    </span>
  );
}
