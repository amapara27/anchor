// The one hardware verdict shown at point-of-use: does this model fit this Mac,
// and how fast will it run. Composes the existing engines (fit.ts + tokps.ts) and
// adds no math of its own — it exists so the dropdown, the search card, the
// comparison picker and the detail aside can never disagree about a model.
// Pure and dependency-free like fit.ts, with explicit .ts extensions so the
// Node-run selfcheck can resolve it.
import type { ArchMeta, FitResult, FitTier, QuantId, TokPerSec } from "../types";
import { estimateFit, fitContext } from "./fit.ts";
import { formatTokSec } from "./format.ts";
import { resolveTokPerSec } from "./tokps.ts";

/** Fit tier → the label and tone every surface uses. Colour never carries the
 *  meaning alone; the label always ships with it. */
const TIER: Record<FitTier, { label: string; tone: string }> = {
  ok: { label: "Fits", tone: "text-ok" },
  tight: { label: "Tight", tone: "text-warn" },
  wont_fit: { label: "Won't fit", tone: "text-danger" },
  unknown: { label: "Unknown", tone: "text-fg-subtle" },
};

export interface HardwareHint {
  tier: FitTier;
  /** The full verdict, for surfaces that draw the memory breakdown. */
  fit: FitResult;
  /** "Fits" | "Tight" | "Won't fit" — never colour alone. */
  label: string;
  /** Tailwind text colour token for `label`. */
  tone: string;
  /** GB of memory the model is short by. Non-null only when `wont_fit`. */
  deficitGB: number | null;
  /** Predicted (or measured) throughput. Null off Apple Silicon. */
  tps: TokPerSec | null;
  /** "~28.0 tok/s" estimated, "28.0 tok/s" measured — the tilde is the only
   *  claim of precision we make. Null when there's no figure. */
  tpsLabel: string | null;
  /** The actionable half: the shortfall when it won't fit, else the speed. */
  detail: string | null;
  /** "Fits · ~28.0 tok/s" | "Won't fit · needs 4.2 GB more". No dangling separator. */
  text: string;
}

/** Model fields the verdict needs. Loose rather than `LibraryModel` because the
 *  search cards hold a catalog `ModelProfile` and only sometimes a library row. */
export interface HintModel {
  id: string;
  params_b: number;
  /** Coerced to a known QuantId by the fit engine (unknown → Q4_K_M). */
  quant: QuantId | string;
  contextTokens: number;
  /** GGUF metadata, when installed — makes the memory terms exact. */
  arch?: ArchMeta | null;
  /** Real on-disk size, preferred over estimating weights from params × bpw. */
  sizeBytes?: number | null;
}

/**
 * The hardware verdict for one model on this machine. Always returns — an
 * unknown host memory yields `tier: "unknown"`, which callers gate on rather
 * than showing a guess.
 */
export function hardwareHint(
  m: HintModel,
  profile: { memory_bytes?: number | null; chip?: string | null } | null | undefined,
): HardwareHint {
  const fit = estimateFit(
    m.params_b,
    m.quant as QuantId,
    fitContext(m.contextTokens),
    { memory_bytes: profile?.memory_bytes },
    { arch: m.arch, size_bytes: m.sizeBytes },
  );
  const tps = resolveTokPerSec(profile?.chip ?? null, m.id, m.params_b, m.quant as QuantId);
  const { label, tone } = TIER[fit.tier];
  // Gate on the tier, not the sign: with host memory unknown `availableGB` is 0,
  // so headroom is wildly negative and would read as a bogus shortfall.
  const deficitGB = fit.tier === "wont_fit" ? -fit.headroomGB : null;

  // The tilde marks an estimate. A measured run has earned a bare number.
  const tpsLabel = tps ? `${tps.source === "measured" ? "" : "~"}${formatTokSec(tps.value)}` : null;
  // When it won't fit, the actionable number is the shortfall, not the speed —
  // a throughput figure for a model that can't load is noise.
  const detail = deficitGB != null ? `needs ${deficitGB.toFixed(1)} GB more` : tpsLabel;

  return {
    tier: fit.tier,
    fit,
    label,
    tone,
    deficitGB,
    tps,
    tpsLabel,
    detail,
    text: detail ? `${label} · ${detail}` : label,
  };
}
