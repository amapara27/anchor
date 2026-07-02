// Quantisation reference data for the fit engine. Pure and dependency-free.
// `bpw` (bits per weight) is what turns a parameter count into a weights size;
// the rest is UI metadata for the quant selector in the fit breakdown panel.
import type { QuantId, QuantMeta } from "../types";

/** The supported quants, ordered smallest → largest. bpw values are the common
 *  effective rates for llama.cpp k-quants. */
export const QUANTS: QuantMeta[] = [
  {
    id: "Q3_K_S",
    bpw: 3.5,
    qualityLabel: "smallest",
    qualityNote: "Smallest footprint; noticeable quality loss.",
  },
  {
    id: "Q4_K_M",
    bpw: 4.8,
    qualityLabel: "balanced",
    qualityNote: "The default — best size-to-quality tradeoff.",
  },
  {
    id: "Q5_K_M",
    bpw: 5.6,
    qualityLabel: "high",
    qualityNote: "Higher quality; ~15% larger than Q4.",
  },
  {
    id: "Q8_0",
    bpw: 8.5,
    qualityLabel: "max",
    qualityNote: "Near-lossless; largest and slowest.",
  },
];

const BY_ID = new Map(QUANTS.map((q) => [q.id, q]));

/** Look up a quant's metadata; falls back to Q4_K_M for unknown ids. */
export function quantMeta(id: QuantId): QuantMeta {
  return BY_ID.get(id) ?? BY_ID.get("Q4_K_M")!;
}
