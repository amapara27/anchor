// Runnable self-check for the hardware-truth engine (fit / quant / tokps).
// No test runner is configured, so run it directly:
//   node --experimental-strip-types apps/desktop/src/lib/engine.selfcheck.ts
// Not imported anywhere, so it never ships in the bundle.
// Explicit .ts extensions: Node's type-stripping does no extension guessing.
import type { ArchMeta } from "../types.ts";
import { estimateFit, fitContext } from "./fit.ts";
import { computeBufferBytes, kvCacheBytes, metadataKvBytesPerToken } from "./kv.ts";
import { QUANTS, quantMeta } from "./quant.ts";
import { parseContext, parseSize, parseTagParams } from "./format.ts";
import { estimateTokPerSec, resolveTokPerSec } from "./tokps.ts";
import { hardwareHint } from "./hint.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("selfcheck failed: " + msg);
}

const GB16 = { memory_bytes: 16 * 1e9 };

/** Builds an ArchMeta with everything null but the named fields. */
function arch(fields: Partial<ArchMeta>): ArchMeta {
  return {
    architecture: null,
    block_count: null,
    head_count: null,
    head_count_kv: null,
    embedding_length: null,
    key_length: null,
    value_length: null,
    sliding_window: null,
    key_length_swa: null,
    value_length_swa: null,
    shared_kv_layers: null,
    ...fields,
  };
}

const KIB = 1024;

// --- KV math ---------------------------------------------------------------
// The reference cases behind the rewrite. Each per-token figure is
// n_layers × n_kv_heads × (key_len + value_len) × 2 bytes, and each differs from
// what a parameter-count bucket would have said — that mismatch is the bug this
// replaced. llama3.2:1b is additionally verified byte-exact against a live
// server by kv.verify.ts.
const LLAMA31_8B = arch({ block_count: 32, head_count_kv: 8, key_length: 128, value_length: 128 });
assert(metadataKvBytesPerToken(LLAMA31_8B) === 128 * KIB, "Llama-3.1 8B = 128 KiB/token");

// MHA: head_count_kv equals the full head count. A params bucket says 80 KiB.
// phi3:mini carries no explicit key/value lengths, so the head dim comes from
// embedding_length / head_count = 96, and it declares a 262144 sliding window
// against a 131072 maximum context — a window that can never bind. Verified:
// `size = 3072.00 MiB (8192 cells, 32 layers)`, one cache, no SWA split.
const PHI3_MINI = arch({
  architecture: "phi3",
  block_count: 32,
  head_count: 32,
  head_count_kv: 32,
  embedding_length: 3072,
  sliding_window: 262144,
});
assert(metadataKvBytesPerToken(PHI3_MINI) === 384 * KIB, "Phi-3 mini (MHA) = 384 KiB/token");
assert(
  kvCacheBytes(PHI3_MINI, 8192, 3.8).bytes === 8192 * 384 * KIB,
  "a window wider than the context is dense, not windowed",
);
// The regression this guards: phi3 is not in GLOBAL_LAYER_FRACTION, so before
// the dense shortcut its unreachable window sent it to the parameter bucket —
// 48 KiB/token against 384 measured, 8x under on a model that wants 12 GiB of
// KV at 32k.
assert(kvCacheBytes(PHI3_MINI, 8192, 3.8).source === "metadata", "phi3 uses metadata, not a bucket");

// Small GQA model: KV barely shrinks with parameter count. A bucket says 48 KiB.
const QWEN3_1_7B = arch({ block_count: 28, head_count_kv: 8, key_length: 128, value_length: 128 });
assert(metadataKvBytesPerToken(QWEN3_1_7B) === 112 * KIB, "Qwen3 1.7B = 112 KiB/token");

// Measured against Ollama: 16 layers × 8 kv heads × 128 × 2 = 32 KiB/token.
const LLAMA32_1B = arch({
  architecture: "llama",
  block_count: 16,
  head_count: 32,
  head_count_kv: 8,
  key_length: 64,
  value_length: 64,
});
assert(metadataKvBytesPerToken(LLAMA32_1B) === 32 * KIB, "llama3.2:1b = 32 KiB/token");
// Compute buffer: the attention mask, n_batch(1024) × 4 bytes per context token,
// and nothing else. These two assertions previously encoded a 33x over-estimate
// (an attention-scores term that flash attention makes nonexistent), which is
// exactly why the build gate stayed green while kv.verify.ts failed. The slope
// is measured: llama3.2:1b's compute buffers total 160.04 MiB at 8k and 256.04
// at 32k, i.e. exactly 4096 bytes per extra token.
assert(computeBufferBytes(1) === 4096, "compute buffer = 4 KiB/token");
assert(computeBufferBytes(32768) === 128 * 1024 * 1024, "compute buffer = 128 MiB at 32k");
assert(
  computeBufferBytes(32768) < kvCacheBytes(LLAMA32_1B, 32768, 1).bytes,
  "compute buffer is small beside KV even on a 1B model",
);

// Windowed layers stop growing past the window, so KV is sublinear in context —
// but the global layers keep scaling, and only the *cached* layers count.
// Ground truth is llama.cpp's own allocation at n_ctx=32768:
//   llama_kv_cache: size = 512.00 MiB (32768 cells,  4 layers)  ← global
//   llama_kv_cache: size =  40.00 MiB ( 1024 cells, 20 layers)  ← windowed
// 42 blocks − 18 shared = 24 cached, split 4:20. An earlier pass read gemma4 as
// having *zero* global layers (from differenced /api/ps, which is ~6 GiB noisy
// on this model) and under-predicted 32k by 12.5×.
const GEMMA4 = arch({
  architecture: "gemma4",
  block_count: 42,
  head_count: 8,
  head_count_kv: 2,
  key_length: 512,
  value_length: 512,
  key_length_swa: 256,
  value_length_swa: 256,
  sliding_window: 512,
  shared_kv_layers: 18,
});
const MIB = 1024 * 1024;
// Predicted 572/188 against 552/168 measured: the windowed term assumes the
// larger n_batch (1024) and this load got 512, so the 20 local layers are each
// billed 512 spare cells. That gap is the whole of the difference and is the
// deliberate over-predict documented on DEFAULT_BATCH.
assert(kvCacheBytes(GEMMA4, 32768, 4).bytes === 572 * MIB, "gemma4 @32k = 512 MiB global + 60 MiB local");
assert(kvCacheBytes(GEMMA4, 8192, 4).bytes === 188 * MIB, "gemma4 @8k = 128 MiB global + 60 MiB local");
assert(kvCacheBytes(GEMMA4, 8192, 4).source === "metadata", "gemma4 uses metadata");
// The windowed term is capped, so growth past the window is global-only: the
// 24576 extra tokens cost 4 layers × 2 heads × 1024 × 2 = 16 KiB/token.
assert(
  kvCacheBytes(GEMMA4, 32768, 4).bytes - kvCacheBytes(GEMMA4, 8192, 4).bytes === 24576 * 16 * KIB,
  "gemma4 growth past the window is the 4 global layers only",
);
// Shared layers are not optional bookkeeping: ignoring them inflates KV by 75%.
assert(
  kvCacheBytes({ ...GEMMA4, shared_kv_layers: null }, 32768, 4).bytes > kvCacheBytes(GEMMA4, 32768, 4).bytes,
  "counting shared layers over-reports",
);

// The other two windowed ratios, both byte-exact against llama.cpp. gemma2
// alternates 1:1 (13 of 26 global) and gemma3 runs 5:1 (5 of 34) — note 34/6 is
// 5.67, so this is the case that proves the split floors rather than rounds.
const GEMMA2_2B = arch({
  architecture: "gemma2",
  block_count: 26,
  head_count: 8,
  head_count_kv: 4,
  key_length: 256,
  value_length: 256,
  sliding_window: 4096,
});
assert(kvCacheBytes(GEMMA2_2B, 8192, 2.6).bytes === 676 * MIB, "gemma2:2b @8k = 416 global + 260 local");

const GEMMA3_4B = arch({
  architecture: "gemma3",
  block_count: 34,
  head_count: 8,
  head_count_kv: 4,
  key_length: 256,
  value_length: 256,
  sliding_window: 1024,
});
assert(kvCacheBytes(GEMMA3_4B, 8192, 4.3).bytes === 392 * MIB, "gemma3:4b @8k = 160 global + 232 local");
assert(kvCacheBytes(GEMMA3_4B, 32768, 4.3).bytes === 872 * MIB, "gemma3:4b @32k = 640 global + 232 local");
// Rounding instead of flooring would bill 6 global layers here, which is
// 32768 × 4 KiB = 128 MiB of context that llama.cpp never allocates.
assert(
  kvCacheBytes(GEMMA3_4B, 32768, 4.3).bytes < kvCacheBytes({ ...GEMMA3_4B, block_count: 36 }, 32768, 4.3).bytes,
  "a 36-layer gemma3 gets a 6th global layer, a 34-layer one does not",
);

// Degradation: no metadata, an unknown windowed arch, and MLA all fall back to
// the bucket and say so, rather than returning a confident wrong number.
assert(kvCacheBytes(null, 4096, 8).source === "estimated", "no metadata ⇒ estimated");
assert(metadataKvBytesPerToken(arch({ block_count: 32 })) === null, "missing kv heads ⇒ null");
assert(
  kvCacheBytes(arch({ architecture: "mystery", block_count: 32, head_count_kv: 8, key_length: 64, value_length: 64, sliding_window: 4096 }), 8192, 8).source ===
    "estimated",
  "unknown windowed arch ⇒ estimated",
);
// MLA (deepseek2) takes the ordinary dense path, because llama.cpp caches the
// decompressed per-head K/V rather than the compressed latent. Measured on
// deepseek-v2:16b: `size = 8640.00 MiB (32768 cells, 27 layers)`, exactly
// 27 × 16 × (192 + 128) × 2 per token. An earlier pass computed the latent form
// (`block_count × (kv_lora_rank + rope_dim) × 2`) and came out 8.9x LOW on a
// model that wants 8.6 GiB of KV at 32k. Asymmetric key and value dims are the
// only thing MLA needs from this code.
const DEEPSEEK_V2 = arch({
  architecture: "deepseek2",
  block_count: 27,
  head_count: 16,
  head_count_kv: 16,
  key_length: 192,
  value_length: 128,
});
assert(metadataKvBytesPerToken(DEEPSEEK_V2) === 270 * KIB, "DeepSeek-V2 = 270 KiB/token");
assert(kvCacheBytes(DEEPSEEK_V2, 32768, 15.7).bytes === 8640 * MIB, "deepseek-v2 @32k = 8640 MiB");
// Ollama serialises array-valued metadata as JSON null, so a present-but-null
// head_count_kv (qwen3.5) must degrade, not throw.
assert(
  metadataKvBytesPerToken(arch({ block_count: 32, head_count_kv: null, key_length: 256, value_length: 256 })) === null,
  "null head_count_kv ⇒ estimated",
);

// --- Library-listing parsers -----------------------------------------------
// The ollama.com listing publishes display strings only, so browse-all's fit
// verdict is built entirely out of what these recover. A silent null here means
// a tag renders no verdict; a wrong number means it renders a false one.

assert(parseSize("4.9GB") === 4.9 * 1024 ** 3, "GB size parses");
assert(parseSize("637MB") === 637 * 1024 ** 2, "MB size parses");
assert(parseSize("1.2 TB") === 1.2 * 1024 ** 4, "spaced TB size parses");
assert(parseSize("unknown") === null, "unfamiliar size ⇒ null, not NaN");

assert(parseTagParams("llama3.1:8b") === 8, "tag params: 8b");
assert(parseTagParams("phi3.5:3.8b") === 3.8, "tag params: fractional");
assert(parseTagParams("smollm2:135m") === 0.135, "tag params: millions → billions");
// MoE: every expert is resident, so memory follows experts × size, not the
// marketing total. 8x7b is 56 here, not the 47 the model card advertises.
assert(parseTagParams("mixtral:8x7b") === 56, "tag params: MoE counts all experts");
assert(parseTagParams("nomic-embed-text") === null, "untagged id ⇒ null");
assert(parseTagParams("llama3.2-vision:11b") === 11, "hyphenated name doesn't break the split");

assert(parseContext("128K") === 131072, "context 128K");
assert(parseContext("4K") === 4096, "context 4K");
assert(parseContext("1M") === 1048576, "context 1M");
assert(parseContext("") === null, "empty context ⇒ null");

// --- Fit -------------------------------------------------------------------

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

// A 128K-context model must not read "won't fit" at the default context on a
// normal Mac — fitContext caps the advertised max to Ollama's real default.
assert(fitContext(131072) === 4096, "fitContext caps 128K max to the 4K default");
const qwen = estimateFit(7, "Q4_K_M", fitContext(131072), { memory_bytes: 16 * 1e9 });
assert(qwen.fits && qwen.tier !== "wont_fit", "7B Q4 @128k-max should fit on 16GB at default ctx");

// Missing hardware → unknown.
assert(estimateFit(8, "Q4_K_M", 4096, { memory_bytes: null }).tier === "unknown", "no memory ⇒ unknown");

// Real on-disk size wins over params × bpw. This matters most for a quant the
// table doesn't know: `quantMeta` silently coerces those to Q4_K_M, which would
// size an F16 model at ~40% of its true weight.
const realSize = estimateFit(8, "Q4_K_M", 4096, GB16, { size_bytes: 16 * 1024 ** 3 });
assert(realSize.breakdown.weightsGB === 16, "size_bytes overrides the bpw estimate");

// The fit verdict reports which way its numbers were derived.
assert(estimateFit(1.2, "Q4_K_M", 8192, GB16, { arch: LLAMA32_1B }).kvSource === "metadata", "arch ⇒ metadata");
assert(estimateFit(8, "Q4_K_M", 8192, GB16).kvSource === "estimated", "no arch ⇒ estimated");

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

// --- Hardware hint ---------------------------------------------------------
// The single verdict every picker renders. It adds no math, so these check the
// wiring: which half is shown, and that nothing bogus leaks out when the host
// or the chip is unknown.
const M4 = { memory_bytes: 16 * 1e9, chip: "Apple M4" };
const smallModel = { id: "llama3.2:1b", params_b: 1.2, quant: "Q4_K_M", contextTokens: 131072 };

const fits = hardwareHint(smallModel, M4);
assert(fits.tier === "ok", "1.2B Q4 on 16 GB fits");
assert(fits.deficitGB === null, "a fitting model has no shortfall");
assert(fits.text.startsWith("Fits · ~") && fits.text.endsWith("tok/s"), "fits ⇒ speed is the detail");

// Too big for the machine: the shortfall replaces the speed, because a
// throughput figure for a model that can't load is noise.
const oversized = hardwareHint({ ...smallModel, id: "llama3.1:70b", params_b: 70 }, M4);
assert(oversized.tier === "wont_fit", "70B Q4 on 16 GB won't fit");
assert((oversized.deficitGB ?? 0) > 0, "won't fit ⇒ positive shortfall");
assert(oversized.text.includes("needs ") && !oversized.text.includes("tok/s"), "won't fit ⇒ shortfall, not speed");

// Host memory unknown ⇒ "unknown", and critically NO shortfall: availableGB is
// 0 there, so a sign-based deficit would invent a bogus GB figure.
const noHost = hardwareHint(smallModel, null);
assert(noHost.tier === "unknown", "no profile ⇒ unknown tier");
assert(noHost.deficitGB === null, "unknown tier ⇒ no invented shortfall");

// Non-Apple-Silicon: fit still resolves, throughput doesn't — and the text must
// not end in a dangling separator.
const intel = hardwareHint(smallModel, { memory_bytes: 16 * 1e9, chip: "Intel Core i7" });
assert(intel.tps === null && intel.tpsLabel === null, "unknown chip ⇒ no throughput");
assert(intel.text === "Fits", "no detail ⇒ label alone, no trailing separator");

// The tilde is the only claim of precision: estimates get it, measurements don't.
assert(fits.tpsLabel?.startsWith("~") === true, "estimated throughput is marked with ~");

console.log("engine.selfcheck: all checks passed");
