// Live check of the KV-cache math against a running Ollama server.
//
//   node --experimental-strip-types apps/desktop/src/lib/kv.verify.ts [model...]
//
// This optional research verifier needs a server and real models, so it is not
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
import { computeBufferBytes, draftKvCacheBytes, kvCacheBytes, metadataKvBytesPerToken, recurrentStateBytes } from "./kv.ts";

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
  readFileSync(p: string): { subarray(from: number): { toString(enc: string): string }; toString(enc: string): string };
  openSync(p: string, flags: string): number;
  readSync(fd: number, buf: Uint8Array, off: number, len: number, pos: number): number;
  closeSync(fd: number): void;
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
const CONTEXTS = (process.env.KV_VERIFY_CONTEXTS ?? "8192,16384,32768").split(",").map(Number);

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
  // Per-layer arrays: exact key only, so a vision tower's array never leaks in.
  const arr = <T,>(suffix: string, elem: (v: unknown) => T | null): T[] | null => {
    const v = arch ? info[`${arch}.${suffix}`] : undefined;
    if (!Array.isArray(v) || v.length === 0) return null;
    const out = v.map(elem);
    return out.every((x) => x !== null) ? (out as T[]) : null;
  };
  const flag = (v: unknown) => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : null);
  const int = (v: unknown) => (typeof v === "number" ? v : null);
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
    sliding_window_pattern: arr("attention.sliding_window_pattern", flag),
    head_count_kv_layers: arr("attention.head_count_kv", int),
    recurrent_layers: arr("attention.recurrent_layers", flag),
    full_attention_interval: num("full_attention_interval"),
    nextn_predict_layers: num("nextn_predict_layers"),
    key_length_mla: num("attention.key_length_mla"),
    value_length_mla: num("attention.value_length_mla"),
    ssm_conv_kernel: num("ssm.conv_kernel"),
    ssm_inner_size: num("ssm.inner_size"),
    ssm_state_size: num("ssm.state_size"),
    ssm_group_count: num("ssm.group_count"),
    shortconv_l_cache: num("shortconv.l_cache"),
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
  return sumMiB(text, /llama_kv_cache:\s*size\s*=\s*([\d.]+) MiB \(\s*(\d+) cells,\s*(\d+) layers/g);
}

/** Sum of every `size = X MiB` match, or null when there are none. */
function sumMiB(text: string, re: RegExp): number | null {
  let total: number | null = null;
  for (const m of text.matchAll(re)) total = (total ?? 0) + parseFloat(m[1]) * MIB;
  return total;
}

/**
 * Splits a load's log at the speculative draft model. Ollama 0.40's llama-server
 * loads an MTP drafter beside some models (`--spec-type draft-mtp`), with its
 * own KV cache; the engine predicts the main model only, so the draft's lines
 * are reported separately instead of being summed into the comparison.
 */
function splitDraft(text: string): { main: string; draft: string | null } {
  const at = text.indexOf("loading draft model");
  return at < 0 ? { main: text, draft: null } : { main: text.slice(0, at), draft: text.slice(at) };
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
  // `/api/ps` always names the tag; a bare `command-r7b` is `command-r7b:latest`.
  const tag = model.includes(":") ? model : `${model}:latest`;
  return ps.models?.find((m: any) => m.name === tag || m.model === tag);
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
  const parts = text === null ? null : splitDraft(text);
  const measured = {
    size: entry.size as number,
    contextLength: entry.context_length as number | undefined,
    kvBytes: parts === null ? null : kvBytesFromLog(parts.main),
    // Real allocations only: a drafter that aliases the target's layers prints
    // `size =` totals for the views but no `KV buffer size` line.
    draftKvBytes: parts?.draft ? (sumMiB(parts.draft, /KV buffer size\s*=\s*([\d.]+) MiB/g) ?? 0) : null,
    recurrentBytes: parts === null ? null : sumMiB(parts.main, /llama_memory_recurrent:\s*size\s*=\s*([\d.]+) MiB/g),
    // Extra state rows llama-server keeps per sequence while a drafter is loaded.
    rsSeq: parts === null ? 0 : Number(/(\d+) rs_seq/.exec(parts.main)?.[1] ?? 0),
    nBatch: parts === null ? null : Number(/llama_context: n_batch\s*=\s*(\d+)/.exec(parts.main)?.[1] ?? NaN) || null,
    flashAttn: text === null ? null : flashAttnFromLog(text),
  };

  // Unload so the next context gets a fresh load rather than a cache hit.
  await api("/api/generate", { model, prompt: "", keep_alive: 0, stream: false });
  for (let i = 0; i < 20 && (await psEntry(model)); i++) await sleep(300);
  return measured;
}

/**
 * The model's speculative draft header, from Ollama's local store (`/api/show`
 * says nothing about drafters), shaped like `model_info`. Null when there is
 * none. A minimal GGUF reader: scalars plus short numeric/bool arrays.
 */
function localDraftInfo(model: string): Record<string, unknown> | null {
  const root = process.env.OLLAMA_MODELS || `${process.env.HOME}/.ollama/models`;
  const [name, tag = "latest"] = model.split(":");
  const path = name.includes("/") ? `registry.ollama.ai/${name}` : `registry.ollama.ai/library/${name}`;
  let digest: string | undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(`${root}/manifests/${path}/${tag}`).toString("utf8"));
    digest = manifest.layers?.find((l: any) => l.mediaType === "application/vnd.ollama.image.draft")?.digest;
  } catch {
    return null;
  }
  if (!digest) return null;
  const buf = new Uint8Array(16 * MIB);
  const fd = fs.openSync(`${root}/blobs/${digest.replace(":", "-")}`, "r");
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const view = new DataView(buf.buffer, 0, n);
  let off = 8; // magic + version
  const u32 = () => ((off += 4), view.getUint32(off - 4, true));
  const u64 = () => ((off += 8), Number(view.getBigUint64(off - 8, true)));
  const str = () => {
    const len = u64();
    off += len;
    return new TextDecoder().decode(buf.subarray(off - len, off));
  };
  const width: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const scalar = (t: number): unknown => {
    const w = width[t];
    off += w;
    const at = off - w;
    if (t === 7) return view.getUint8(at) !== 0;
    if (t === 6) return view.getFloat32(at, true);
    if (t === 12) return view.getFloat64(at, true);
    if (w === 8) return Number(view.getBigUint64(at, true));
    return w === 4 ? view.getUint32(at, true) : w === 2 ? view.getUint16(at, true) : view.getUint8(at);
  };
  const value = (t: number): unknown => {
    if (t === 8) return str();
    if (t !== 9) return scalar(t);
    const elem = u32();
    const count = u64();
    if (elem === 8) {
      for (let i = 0; i < count; i++) str();
      return null;
    }
    if (count > 4096) return ((off += width[elem] * count), null);
    return Array.from({ length: count }, () => scalar(elem));
  };
  u64(); // tensor count
  const kvCount = u64();
  const info: Record<string, unknown> = {};
  for (let i = 0; i < kvCount; i++) {
    const key = str();
    info[key] = value(u32());
  }
  return info;
}

async function verify(model: string): Promise<boolean> {
  const show = await api("/api/show", { name: model });
  const arch = archFrom(show.model_info ?? {});
  const draftInfo = localDraftInfo(model);
  if (draftInfo) arch.draft = archFrom(draftInfo);
  const draftN = /^draft_num_predict\s+(\d+)/m.exec(show.parameters ?? "")?.[1];
  if (draftN) arch.draft_num_predict = Number(draftN);
  const perToken = metadataKvBytesPerToken(arch);

  console.log(`\n=== ${model}  (${arch.architecture ?? "unknown arch"})`);
  console.log(
    `    layers=${arch.block_count} kv_heads=${arch.head_count_kv ?? (arch.head_count_kv_layers ? "per-layer" : null)} ` +
      `k=${arch.key_length} v=${arch.value_length}` +
      (arch.sliding_window ? ` swa_window=${arch.sliding_window}` : ""),
  );
  if (perToken === null) {
    console.log("    SKIP — metadata can't support exact math (see fields above)");
    return true;
  }

  const maxCtx = arch.block_count ? (show.model_info?.[`${arch.architecture}.context_length`] ?? 0) : 0;
  const contexts = CONTEXTS.filter((c) => !maxCtx || c <= maxCtx);

  const samples: {
    ctx: number;
    size: number;
    kvBytes: number | null;
    draftKvBytes: number | null;
    recurrentBytes: number | null;
    nBatch: number | null;
    rsSeq: number;
  }[] = [];
  let flashAttn: boolean | null = null;
  for (const ctx of contexts) {
    const { size, contextLength, kvBytes, draftKvBytes, recurrentBytes, nBatch, rsSeq, flashAttn: fa } =
      await residentAt(model, ctx);
    if (fa !== null) flashAttn = fa;
    // Ollama silently clamps num_ctx it can't honour. A clamped load measures a
    // different context than the one we're predicting, so it isn't a data point.
    if (contextLength !== undefined && contextLength !== ctx) {
      console.log(`    ctx ${ctx}: clamped to ${contextLength}, discarded`);
      continue;
    }
    samples.push({ ctx, size, kvBytes, draftKvBytes, recurrentBytes, nBatch, rsSeq });
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
          `error ${(error * 100).toFixed(1)}%  ${pass ? "PASS" : "FAIL"}   [from server log` +
          (s.nBatch ? `, n_batch ${s.nBatch}` : "") +
          "]",
      );
      // Already includes the drafter's rollback rows when a draft is known.
      const predictedState = recurrentStateBytes(arch);
      if (s.recurrentBytes !== null || predictedState > 0) {
        const got = s.recurrentBytes ?? 0;
        const statePass = Math.abs(got - predictedState) <= Math.max(TOLERANCE * got, MIB);
        ok &&= statePass;
        console.log(
          `                 recurrent state predicted ${(predictedState / MIB).toFixed(2)} MiB` +
            (s.rsSeq ? ` (log: ${s.rsSeq} rs_seq)` : "") +
            `, allocated ${(got / MIB).toFixed(2)} MiB  ${statePass ? "PASS" : "FAIL"}`,
        );
      }
      const predictedDraft = draftKvCacheBytes(arch, s.ctx);
      if (s.draftKvBytes !== null || predictedDraft > 0) {
        const got = s.draftKvBytes ?? 0;
        const draftPass = Math.abs(got - predictedDraft) <= Math.max(TOLERANCE * got, SLACK_BYTES);
        ok &&= draftPass;
        console.log(
          `                 draft model KV predicted ${(predictedDraft / MIB).toFixed(1)} MiB, ` +
            `allocated ${(got / MIB).toFixed(1)} MiB  ${draftPass ? "PASS" : "FAIL"}`,
        );
      }
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
