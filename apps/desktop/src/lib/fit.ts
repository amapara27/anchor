// Hardware-fit logic: compares a model's memory needs against the host's RAM.
// Pure and dependency-free (like format.ts) so it's trivially testable and
// reusable by both the model cards and the detail drawer.
import type { FitResult, QuantId } from "../types";
import { quantMeta } from "./quant";

/**
 * How well a model fits the host's memory:
 * - `wont_fit`: needs more memory than the machine has.
 * - `tight`: needs >70% of memory, leaving little for the OS and other apps.
 * - `ok`: fits comfortably.
 * - `unknown`: host memory (or the model's requirement) isn't known.
 */
export type FitTier = "ok" | "tight" | "wont_fit" | "unknown";

/** Fraction of total memory above which a model is considered a "tight" fit. */
const TIGHT_RATIO = 0.7;

/** Classify a model's minimum memory against the host's total memory. */
export function memoryFit(
  minMemoryBytes: number,
  totalMemoryBytes: number | null | undefined,
): FitTier {
  if (!totalMemoryBytes || !minMemoryBytes) return "unknown";
  if (minMemoryBytes > totalMemoryBytes) return "wont_fit";
  if (minMemoryBytes > totalMemoryBytes * TIGHT_RATIO) return "tight";
  return "ok";
}

// --- Hardware-truth engine -------------------------------------------------

const GIB = 1024 ** 3;
/** Headroom below this fraction of total memory counts as a "tight" fit. */
const TIGHT_HEADROOM_RATIO = 0.15;

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
