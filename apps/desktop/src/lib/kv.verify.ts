// Live check of the KV-cache math against a running Ollama server.
//
//   node --experimental-strip-types apps/desktop/src/lib/kv.verify.ts [model...]
//
// Unlike engine.selfcheck.ts this needs a server and real models, so it is not
// part of the normal build gate — run it when the KV formula changes, or when a
// new architecture shows up that the formula hasn't been proven against.
//
// Two methods, preferring the exact one:
//
// 1. LOG (exact). llama.cpp prints what it allocated —
//      llama_kv_cache: size = 512.00 MiB (32768 cells, 4 layers, ...)
//    one line per cache (global and windowed are separate). Summing them is the
//    real number, so this compares absolutely rather than by difference.
//
// 2. DIFFERENTIAL (fallback, when the log isn't readable). Resident size is
//    weights + KV + compute buffers; loading the same model at two contexts and
//    subtracting cancels the other two. Weaker, because it assumes the weights
//    term is stable across loads — on gemma4 it is NOT (llama.cpp re-splits
//    weights between Metal and CPU based on free VRAM, moving /api/ps `size` by
//    ~6 GiB), and that noise once hid a 512 MiB KV term completely.
import type { ArchMeta } from "../types";
import { computeBufferBytes, kvCacheBytes, metadataKvBytesPerToken } from "./kv.ts";

// This is the one Node-only file under `src/`, which is otherwise typed for the
// DOM. Declaring the handful of globals it needs keeps it inside `tsc --noEmit`
// without pulling @types/node in for a few usages.
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code: number): never;
};

// Specifier held in a variable so tsc doesn't try to resolve node:fs (no
// @types/node here, and this is the only file that wants it).
const NODE_FS = "node:fs";
const fs: {
  statSync(p: string): { size: number };
  readFileSync(p: string): { subarray(from: number): { toString(enc: string): string } };
} = await import(NODE_FS);

const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
/**
 * Ollama's server log. The macOS app writes here; `ollama serve` run by hand
 * writes to its own stdout, so point OLLAMA_LOG at wherever that was captured.
 */
const LOG = process.env.OLLAMA_LOG ?? `${process.env.HOME}/.ollama/logs/server.log`;
/** Predicted-vs-measured tolerance. Beyond this the formula is missing a term. */
const TOLERANCE = 0.1;
/**
 * Absolute slack allowed alongside TOLERANCE.
 *
 * `n_batch` is 512 or 1024 depending on how much memory the load had (see
 * `DEFAULT_BATCH`), and it pads every windowed cache. So an otherwise-exact
 * formula can still miss by `localLayers × perLayerToken × 512` — 40 MiB on
 * gemma4, 58 MiB on gemma3. At short context that windowed term is most of a
 * small total, so a percentage alone reads it as a failure.
 */
const SLACK_BYTES = 64 * 1024 ** 2;
/**
 * Contexts to sample; consecutive pairs give the deltas we compare.
 *
 * Starts at 8k deliberately. Below roughly 4k llama.cpp holds a minimum compute
 * buffer that doesn't yet scale with context, so small-context deltas measure an
 * allocation floor rather than the per-token growth under test. That regime is
 * also the one where everything fits anyway.
 */
const CONTEXTS = [8192, 16384, 32768];

const MIB = 1024 ** 2;

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${HOST}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** Pulls the architecture fields out of `/api/show`, mirroring `show_details`. */
function archFrom(info: Record<string, unknown>): ArchMeta {
  const arch = typeof info["general.architecture"] === "string" ? info["general.architecture"] : null;
  // Prefer the exact `{arch}.{suffix}` key: multimodal GGUFs carry vision and
  // audio towers whose keys share these suffixes.
  const num = (suffix: string): number | null => {
    const exact = arch ? info[`${arch}.${suffix}`] : undefined;
    const hit = exact ?? Object.entries(info).find(([k]) => k.endsWith(`.${suffix}`))?.[1];
    return typeof hit === "number" ? hit : null;
  };
  return {
    architecture: arch,
    block_count: num("block_count"),
    head_count: num("attention.head_count"),
    head_count_kv: num("attention.head_count_kv"),
    embedding_length: num("embedding_length"),
    key_length: num("attention.key_length"),
    value_length: num("attention.value_length"),
    sliding_window: num("attention.sliding_window"),
    key_length_swa: num("attention.key_length_swa"),
    value_length_swa: num("attention.value_length_swa"),
    shared_kv_layers: num("attention.shared_kv_layers"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current end of the log, or null when it isn't readable. */
function logOffset(): number | null {
  try {
    return fs.statSync(LOG).size;
  } catch {
    return null;
  }
}

/**
 * Everything the server logged since `offset`, or null if unreadable. Reading
 * from a byte offset rather than grepping the whole file is what ties the lines
 * to *this* load — the file accumulates every load ever made.
 */
function logSince(offset: number): string | null {
  try {
    return fs.readFileSync(LOG).subarray(offset).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Total KV bytes llama.cpp reported allocating, or null if the slice carries no
 * allocation lines (a reused/cached load prints none). Windowed models print one
 * line per cache — global and SWA are separate — so these are summed.
 */
function kvBytesFromLog(text: string): number | null {
  const re = /llama_kv_cache:\s*size\s*=\s*([\d.]+) MiB \(\s*(\d+) cells,\s*(\d+) layers/g;
  let total: number | null = null;
  for (const m of text.matchAll(re)) total = (total ?? 0) + parseFloat(m[1]) * MIB;
  return total;
}

/**
 * Whether llama.cpp resolved `--flash-attn auto` to on. `computeBufferBytes`
 * models the mask alone, which is only right with flash attention; without it
 * llama.cpp also materialises an `n_batch × n_head × ctx` scores buffer and that
 * term is ~33x larger. Null when the slice says nothing either way.
 */
function flashAttnFromLog(text: string): boolean | null {
  if (/Flash Attention enabled/.test(text)) return true;
  if (/flash[_ ]attn\w*\s*=\s*(0|false|disabled)/i.test(text)) return false;
  return null;
}

/** The model's `/api/ps` row, or undefined if it isn't resident. */
async function psEntry(model: string) {
  const ps = await api("/api/ps");
  return ps.models?.find((m: any) => m.name === model || m.model === model);
}

/**
 * Loads `model` at `num_ctx` and reports what Ollama actually did.
 *
 * `/api/ps` is polled until `size` repeats, because a read taken the instant
 * `/api/generate` returns catches allocation mid-flight. The unload is awaited
 * for the same reason — a fire-and-forget eviction overlaps the next load.
 *
 * `kvBytes` is llama.cpp's own allocation total for this load, when the log is
 * readable; that number is exact and needs no differencing.
 */
async function residentAt(model: string, num_ctx: number) {
  const offset = logOffset();
  await api("/api/generate", {
    model,
    prompt: "hi",
    stream: false,
    options: { num_ctx, num_predict: 1 },
    keep_alive: "60s",
  });

  let entry = await psEntry(model);
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const next = await psEntry(model);
    if (next && entry && next.size === entry.size) break;
    entry = next;
  }
  if (!entry) throw new Error(`${model} not resident after load`);
  const text = offset === null ? null : logSince(offset);
  const measured = {
    size: entry.size as number,
    contextLength: entry.context_length as number | undefined,
    kvBytes: text === null ? null : kvBytesFromLog(text),
    flashAttn: text === null ? null : flashAttnFromLog(text),
  };

  // Unload so the next context gets a fresh load rather than a cache hit.
  await api("/api/generate", { model, prompt: "", keep_alive: 0, stream: false });
  for (let i = 0; i < 20 && (await psEntry(model)); i++) await sleep(300);
  return measured;
}

async function verify(model: string): Promise<boolean> {
  const show = await api("/api/show", { name: model });
  const arch = archFrom(show.model_info ?? {});
  const perToken = metadataKvBytesPerToken(arch);

  console.log(`\n=== ${model}  (${arch.architecture ?? "unknown arch"})`);
  console.log(
    `    layers=${arch.block_count} kv_heads=${arch.head_count_kv} ` +
      `k=${arch.key_length} v=${arch.value_length}` +
      (arch.sliding_window ? ` swa_window=${arch.sliding_window}` : ""),
  );
  if (perToken === null) {
    console.log("    SKIP — metadata can't support exact math (see fields above)");
    return true;
  }

  const maxCtx = arch.block_count ? (show.model_info?.[`${arch.architecture}.context_length`] ?? 0) : 0;
  const contexts = CONTEXTS.filter((c) => !maxCtx || c <= maxCtx);

  const samples: { ctx: number; size: number; kvBytes: number | null }[] = [];
  let flashAttn: boolean | null = null;
  for (const ctx of contexts) {
    const { size, contextLength, kvBytes, flashAttn: fa } = await residentAt(model, ctx);
    if (fa !== null) flashAttn = fa;
    // Ollama silently clamps num_ctx it can't honour. A clamped load measures a
    // different context than the one we're predicting, so it isn't a data point.
    if (contextLength !== undefined && contextLength !== ctx) {
      console.log(`    ctx ${ctx}: clamped to ${contextLength}, discarded`);
      continue;
    }
    samples.push({ ctx, size, kvBytes });
  }
  // The compute-buffer term assumes flash attention. If a load ever reports it
  // off, that term is ~33x too small and the KV numbers below say nothing about
  // it either way.
  if (flashAttn === false) {
    console.log("    WARNING: flash attention OFF — computeBufferBytes under-predicts ~33x");
  }

  // Exact path: llama.cpp told us what it allocated, so compare per context and
  // skip differencing entirely.
  if (samples.length > 0 && samples.every((s) => s.kvBytes !== null)) {
    let ok = true;
    for (const s of samples) {
      const predicted = kvCacheBytes(arch, s.ctx, 0).bytes;
      const delta = s.kvBytes! - predicted;
      const error = delta / predicted;
      const pass = Math.abs(error) <= TOLERANCE || Math.abs(delta) <= SLACK_BYTES;
      ok &&= pass;
      console.log(
        `    ctx ${String(s.ctx).padStart(6)}: kv predicted ${(predicted / MIB).toFixed(1)} MiB, ` +
          `allocated ${(s.kvBytes! / MIB).toFixed(1)} MiB, ` +
          `error ${(error * 100).toFixed(1)}%  ${pass ? "PASS" : "FAIL"}   [from server log]`,
      );
    }
    return ok;
  }

  if (samples.length < 2) {
    console.log("    SKIP — need two usable context samples");
    return true;
  }
  console.log(`    (no KV lines in ${LOG} — falling back to differential /api/ps)`);

  let ok = true;
  for (let i = 1; i < samples.length; i++) {
    const lo = samples[i - 1];
    const hi = samples[i];
    const measured = hi.size - lo.size;
    // Both context-scaling terms are under test: the KV cache and the compute
    // buffer. Weights and any fixed overhead cancel in the subtraction. They're
    // reported separately so a failure says which term is wrong — reading one
    // summed number is how the compute-buffer bug survived as long as it did.
    const dKv = kvCacheBytes(arch, hi.ctx, 0).bytes - kvCacheBytes(arch, lo.ctx, 0).bytes;
    const dCompute = computeBufferBytes(hi.ctx) - computeBufferBytes(lo.ctx);
    const predicted = dKv + dCompute;
    const error = predicted === 0 ? (measured === 0 ? 0 : 1) : (measured - predicted) / predicted;
    const pass = Math.abs(error) <= TOLERANCE;
    ok &&= pass;
    console.log(
      `    ${lo.ctx} → ${hi.ctx}: predicted ${(predicted / MIB).toFixed(1)} MiB ` +
        `(kv ${(dKv / MIB).toFixed(1)} + compute ${(dCompute / MIB).toFixed(1)}), ` +
        `measured ${(measured / MIB).toFixed(1)} MiB, ` +
        `error ${(error * 100).toFixed(1)}%  ${pass ? "PASS" : "FAIL"}`,
    );
  }
  return ok;
}

const models: string[] =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : (await api("/api/tags")).models.map((m: any) => m.name);

let allOk = true;
for (const m of models) {
  try {
    // Not `allOk &&= await verify(m)`: that short-circuits once a model fails,
    // silently leaving every later model untested.
    const ok = await verify(m);
    allOk = allOk && ok;
  } catch (e) {
    console.log(`\n=== ${m}\n    ERROR ${(e as Error).message}`);
    allOk = false;
  }
}

console.log(allOk ? "\nAll models within tolerance." : "\nSome models out of tolerance.");
process.exit(allOk ? 0 : 1);
