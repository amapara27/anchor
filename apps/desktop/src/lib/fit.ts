// Hardware-fit logic: compares a model's memory needs against the host's RAM.
// Pure and dependency-free (like format.ts) so it's trivially testable and
// reusable by both the model cards and the detail drawer.
import type { ArchMeta, FitResult, QuantId } from "../types";
// Explicit .ts extension so the Node-run selfcheck can resolve it too.
import { quantMeta } from "./quant.ts";
import { computeBufferBytes, kvCacheBytes } from "./kv.ts";

/**
 * How well a model fits the host's memory:
 * - `wont_fit`: needs more memory than the machine has.
 * - `tight`: fits, but leaves little headroom for the OS and other apps.
 * - `ok`: fits comfortably.
 * - `unknown`: host memory (or the model's parameter count) isn't known.
 */
export type FitTier = "ok" | "tight" | "wont_fit" | "unknown";

// --- Hardware-truth engine -------------------------------------------------

const GIB = 1024 ** 3;
/** Headroom below this fraction of total memory counts as a "tight" fit. */
const TIGHT_HEADROOM_RATIO = 0.15;

/**
 * Context length to judge at-a-glance fit at. Ollama loads a model with a small
 * default `num_ctx` (~4K), NOT its advertised maximum — a 128K-context model's
 * KV cache at full length can exceed total RAM and falsely read "won't fit".
 * The breakdown slider still explores up to the model's real maximum.
 * ponytail: mirrors Ollama's num_ctx default; bump if that default changes.
 */
export const DEFAULT_CONTEXT = 4096;

/** Realistic context for the default fit check: the default, capped by the
 *  model's own maximum (some models advertise less than the default). */
export function fitContext(maxContext: number): number {
  return Math.min(maxContext || DEFAULT_CONTEXT, DEFAULT_CONTEXT);
}

/**
 * Weights size in GiB.
 *
 * Prefers the model's real on-disk size: `size_bytes` from `/api/tags` is the
 * actual GGUF byte count, whereas `params_b × bpw / 8` is a guess that goes
 * badly wrong for anything outside the four quants in `quant.ts` — an unknown
 * quant silently falls back to Q4_K_M, sizing an F16 model at ~40% of its true
 * weight. Only catalog models that aren't installed yet need the estimate.
 */
function weightsGiB(params_b: number, quant: QuantId, size_bytes?: number | null): number {
  if (size_bytes) return size_bytes / GIB;
  return (params_b * 1e9 * (quantMeta(quant).bpw / 8)) / GIB;
}

/**
 * Estimate whether a model fits, and expose the math behind it. Recompute live
 * as the context slider / quant selector change (this is pure and cheap).
 *
 * Pass `model` whenever it's known: with the architecture metadata the KV and
 * compute-buffer terms are exact (verified byte-for-byte by `kv.verify.ts`),
 * and without it they fall back to a parameter-count bucket. `FitResult.kvSource`
 * says which happened, and the UI must label an estimate as one.
 */
export function estimateFit(
  params_b: number,
  quant: QuantId,
  contextLength: number,
  hardware: { memory_bytes: number | null | undefined },
  model?: { arch?: ArchMeta | null; size_bytes?: number | null },
): FitResult {
  const availableGB = (hardware.memory_bytes ?? 0) / GIB;
  const weightsGB = weightsGiB(params_b, quant, model?.size_bytes);
  const kv = kvCacheBytes(model?.arch, contextLength, params_b);
  const kvCacheGB = kv.bytes / GIB;
  // Grows with context just like the KV cache, and on small models it is the
  // larger of the two — it can't be folded into a fixed reserve.
  const computeBufferGB = computeBufferBytes(model?.arch, contextLength) / GIB;
  const osReserveGB = Math.max(2, 0.15 * availableGB);
  const totalNeededGB = weightsGB + kvCacheGB + computeBufferGB + osReserveGB;
  const headroomGB = availableGB - totalNeededGB;

  const breakdown = {
    weightsGB,
    kvCacheGB,
    computeBufferGB,
    osReserveGB,
    totalNeededGB,
    availableGB,
  };

  if (!hardware.memory_bytes || !params_b) {
    return { tier: "unknown", fits: false, headroomGB, breakdown, kvSource: kv.source };
  }
  const tier: FitTier =
    headroomGB < 0 ? "wont_fit" : headroomGB < availableGB * TIGHT_HEADROOM_RATIO ? "tight" : "ok";
  return { tier, fits: headroomGB >= 0, headroomGB, breakdown, kvSource: kv.source };
}
