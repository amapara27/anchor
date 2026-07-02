// Runnable self-check for the hardware-truth engine (fit / quant / tokps).
// No test runner is configured, so run it directly:
//   node --experimental-strip-types apps/desktop/src/lib/engine.selfcheck.ts
// Not imported anywhere, so it never ships in the bundle.
import { estimateFit } from "./fit";
import { QUANTS, quantMeta } from "./quant";
import { estimateTokPerSec, resolveTokPerSec } from "./tokps";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("selfcheck failed: " + msg);
}

const GB16 = { memory_bytes: 16 * 1e9 };

// A 8B Q4 model fits comfortably at a short context...
const small = estimateFit(8, "Q4_K_M", 4096, GB16);
assert(small.tier === "ok" && small.fits, "8B Q4 @4k should fit on 16GB");
assert(small.breakdown.weightsGB > 4 && small.breakdown.weightsGB < 5, "8B Q4 weights ≈ 4.5GB");

// ...but the same model at full 128K context should blow past memory.
const huge = estimateFit(8, "Q4_K_M", 131072, GB16);
assert(huge.tier === "wont_fit" && !huge.fits, "8B Q4 @128k should not fit on 16GB");
assert(huge.breakdown.kvCacheGB > small.breakdown.kvCacheGB, "KV cache grows with context");

// Bigger quant needs more memory than smaller quant.
assert(
  estimateFit(8, "Q8_0", 4096, GB16).breakdown.weightsGB >
    estimateFit(8, "Q3_K_S", 4096, GB16).breakdown.weightsGB,
  "Q8 weights > Q3 weights",
);

// Missing hardware → unknown.
assert(estimateFit(8, "Q4_K_M", 4096, { memory_bytes: null }).tier === "unknown", "no memory ⇒ unknown");

// Quant table is ordered smallest → largest and looks up correctly.
assert(QUANTS[0].bpw < QUANTS[QUANTS.length - 1].bpw, "quants ordered by bpw");
assert(quantMeta("Q4_K_M").id === "Q4_K_M", "quantMeta returns the asked quant");

// Throughput: M1 7B Q4 lands in a sane range; unknown chip → null.
const m1 = estimateTokPerSec("Apple M1", 7, "Q4_K_M");
assert(!!m1 && m1.value > 8 && m1.value < 22, "M1 7B Q4 tok/s in range");
const ultra = estimateTokPerSec("Apple M4 Max", 7, "Q4_K_M");
assert(!!ultra && ultra.value > (m1?.value ?? 0), "M4 Max faster than M1");
assert(estimateTokPerSec("Intel Core i7", 7, "Q4_K_M") === null, "non-Apple-Silicon ⇒ null");

// With no measured runs, resolve falls back to the estimate.
const resolved = resolveTokPerSec("Apple M1", "llama3.1:8b", 7, "Q4_K_M");
assert(!!resolved && resolved.source === "estimated", "resolve falls back to estimate");

console.log("engine.selfcheck: all checks passed");
