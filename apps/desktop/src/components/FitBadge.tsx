import type { QuantId } from "../types";
import { estimateFit, fitContext } from "../lib/fit";
import { WarningIcon } from "./icons";

/**
 * Pill flagging a model that's a poor fit for the host's memory, judged by the
 * same `estimateFit` engine as the fit breakdown so the two never disagree.
 * Renders nothing for comfortable (`ok`) or unknown fits, so it only ever adds
 * signal. Colour AND icon AND text carry the meaning (a11y: never colour alone).
 */
export function FitBadge({
  params_b,
  quant,
  contextTokens,
  totalMemoryBytes,
  className = "",
}: {
  params_b: number;
  /** Coerced to a known QuantId by the fit engine (falls back to Q4_K_M). */
  quant: QuantId | string;
  contextTokens: number;
  totalMemoryBytes: number | null | undefined;
  className?: string;
}) {
  const fit = estimateFit(params_b, quant as QuantId, fitContext(contextTokens), {
    memory_bytes: totalMemoryBytes,
  });
  if (fit.tier !== "tight" && fit.tier !== "wont_fit") return null;
  const wontFit = fit.tier === "wont_fit";
  return (
    <span
      className={[
        "inline-flex items-center gap-1 text-xs font-medium",
        wontFit ? "text-danger" : "text-warn",
        className,
      ].join(" ")}
      title={wontFit ? "Needs more memory than your Mac has" : "Needs most of your Mac's memory"}
    >
      <WarningIcon className="size-3" />
      {wontFit ? "Won't fit" : "Tight"}
    </span>
  );
}
