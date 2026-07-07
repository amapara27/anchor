// Predicted generation throughput (tok/s). Decode is memory-bandwidth bound —
// each token reads the whole model — so tok/s ≈ bandwidth / weights-size. We
// seed a small per-chip bandwidth table (published Apple Silicon figures) and a
// single efficiency constant, then prefer any real measured run over the guess.
import type { QuantId, TokPerSec } from "../types";
// Explicit .ts extensions so the Node-run selfcheck can resolve them too.
import { quantMeta } from "./quant.ts";
import { getMeasuredRuns } from "./measured.ts";

/** Unified-memory bandwidth (GB/s) by Apple Silicon generation + tier.
 *  ponytail: seed table, overwrite with measured. Conservative where unsure. */
const BANDWIDTH: Record<string, Record<string, number>> = {
  m1: { base: 68, pro: 200, max: 400, ultra: 800 },
  m2: { base: 100, pro: 200, max: 400, ultra: 800 },
  m3: { base: 100, pro: 150, max: 300, ultra: 800 },
  m4: { base: 120, pro: 273, max: 500, ultra: 1000 },
};

/** Fraction of the bandwidth ceiling actually reached in practice. Calibrated so
 *  an M1 running a 7B Q4 lands ~14 tok/s. ponytail: single calibration knob. */
const EFFICIENCY = 0.85;

/** Parse a chip name into { gen, tier }, or null when it isn't Apple Silicon. */
function parseChip(chip: string | null): { gen: string; tier: string } | null {
  if (!chip) return null;
  const s = chip.toLowerCase();
  const gen = ["m1", "m2", "m3", "m4"].find((g) => s.includes(g));
  if (!gen) return null;
  const tier = s.includes("ultra") ? "ultra" : s.includes("max") ? "max" : s.includes("pro") ? "pro" : "base";
  return { gen, tier };
}

/** Estimate tok/s from chip bandwidth and weights size. Null when the chip is
 *  unknown/non-Apple-Silicon (we don't guess for those). */
export function estimateTokPerSec(
  chip: string | null,
  params_b: number,
  quant: QuantId,
): TokPerSec | null {
  const parsed = parseChip(chip);
  if (!parsed || !params_b) return null;
  const bw = BANDWIDTH[parsed.gen]?.[parsed.tier];
  if (!bw) return null;
  const weightsGB = params_b * (quantMeta(quant).bpw / 8); // decimal GB
  if (weightsGB <= 0) return null;
  return { value: (bw / weightsGB) * EFFICIENCY, source: "estimated" };
}

/** Throughput for a model, preferring a measured run on this chip+quant over the
 *  estimate. Returns which source was used so the UI can label it. */
export function resolveTokPerSec(
  chip: string | null,
  modelId: string,
  params_b: number,
  quant: QuantId,
): TokPerSec | null {
  const measured = getMeasuredRuns(modelId).find((r) => r.chip === chip && r.quant === quant);
  if (measured) return { value: measured.tokPerSec, source: "measured" };
  return estimateTokPerSec(chip, params_b, quant);
}
