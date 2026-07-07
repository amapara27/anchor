// Hardware-fit logic: compares a model's memory needs against the host's RAM.
// Pure and dependency-free (like format.ts) so it's trivially testable and
// reusable by both the model cards and the detail drawer.
import type { FitResult, QuantId } from "../types";
// Explicit .ts extension so the Node-run selfcheck can resolve it too.
import { quantMeta } from "./quant.ts";

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
 * Estimated fp16 KV-cache bytes per token, bucketed by model size. Real KV cost
 * depends on layers/kv-heads/head-dim/GQA, which the catalog doesn't carry, so
 * these are seeded from typical GQA architectures (e.g. Llama-3 8B ≈ 128 KB/tok,
 * 70B ≈ 320 KB/tok).
 * ponytail: estimated, calibrate against measured once we track memory.
 */
function kvBytesPerToken(params_b: number): number {
  if (params_b <= 2) return 48 * 1024;
  if (params_b <= 4) return 80 * 1024;
  if (params_b <= 9) return 128 * 1024;
  if (params_b <= 16) return 192 * 1024;
  if (params_b <= 34) return 256 * 1024;
  return 320 * 1024;
}

/**
 * Estimate whether a model fits, and expose the math behind it. Everything is an
 * ESTIMATE — the caller must label it as such in the UI. Recompute live as the
 * context slider / quant selector change (this is pure and cheap).
 */
export function estimateFit(
  params_b: number,
  quant: QuantId,
  contextLength: number,
  hardware: { memory_bytes: number | null | undefined },
): FitResult {
  const availableGB = (hardware.memory_bytes ?? 0) / GIB;
  const weightsGB = (params_b * 1e9 * (quantMeta(quant).bpw / 8)) / GIB;
  const kvCacheGB = (contextLength * kvBytesPerToken(params_b)) / GIB;
  const osReserveGB = Math.max(2, 0.15 * availableGB);
  const totalNeededGB = weightsGB + kvCacheGB + osReserveGB;
  const headroomGB = availableGB - weightsGB - kvCacheGB - osReserveGB;

  const breakdown = { weightsGB, kvCacheGB, osReserveGB, totalNeededGB, availableGB };

  if (!hardware.memory_bytes || !params_b) {
    return { tier: "unknown", fits: false, headroomGB, breakdown };
  }
  const tier: FitTier =
    headroomGB < 0 ? "wont_fit" : headroomGB < availableGB * TIGHT_HEADROOM_RATIO ? "tight" : "ok";
  return { tier, fits: headroomGB >= 0, headroomGB, breakdown };
}
