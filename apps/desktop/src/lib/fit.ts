// Hardware-fit logic: compares a model's memory needs against the host's RAM.
// Pure and dependency-free (like format.ts) so it's trivially testable and
// reusable by both the model cards and the detail drawer.

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
