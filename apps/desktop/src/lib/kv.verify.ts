// Live check of the KV-cache math against a running Ollama server.
//
//   node --experimental-strip-types apps/desktop/src/lib/kv.verify.ts [model...]
//
// Unlike engine.selfcheck.ts this needs a server and real models, so it is not
// part of the normal build gate — run it when the KV formula changes, or when a
// new architecture shows up that the formula hasn't been proven against.
//
// Method: differential measurement. A model's resident size is weights + KV +
// compute buffers, and only the middle term is under test. Loading the *same*
// model at two context lengths and subtracting cancels the other two, leaving
// pure KV — so this measures the thing we're actually predicting instead of a
// total that could be right for the wrong reasons.
import type { ArchMeta } from "../types";
import { computeBufferBytes, kvCacheBytes, metadataKvBytesPerToken } from "./kv.ts";

// This is the one Node-only file under `src/`, which is otherwise typed for the
// DOM. Declaring the handful of globals it needs keeps it inside `tsc --noEmit`
// without pulling @types/node in for four usages.
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code: number): never;
};

const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
/** Predicted-vs-measured tolerance. Beyond this the formula is missing a term. */
const TOLERANCE = 0.1;
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
    kv_lora_rank: num("attention.kv_lora_rank"),
  };
}

/** Loads `model` at `num_ctx` and reports what Ollama actually did. */
async function residentAt(model: string, num_ctx: number) {
  await api("/api/generate", {
    model,
    prompt: "hi",
    stream: false,
    options: { num_ctx, num_predict: 1 },
    keep_alive: "60s",
  });
  const ps = await api("/api/ps");
  const entry = ps.models?.find((m: any) => m.name === model || m.model === model);
  // Unload so the next context gets a fresh load rather than a cache hit.
  await api("/api/generate", { model, prompt: "", keep_alive: 0, stream: false });
  if (!entry) throw new Error(`${model} not resident after load`);
  return { size: entry.size as number, contextLength: entry.context_length as number | undefined };
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

  const samples: { ctx: number; size: number }[] = [];
  for (const ctx of contexts) {
    const { size, contextLength } = await residentAt(model, ctx);
    // Ollama silently clamps num_ctx it can't honour. A clamped load measures a
    // different context than the one we're predicting, so it isn't a data point.
    if (contextLength !== undefined && contextLength !== ctx) {
      console.log(`    ctx ${ctx}: clamped to ${contextLength}, discarded`);
      continue;
    }
    samples.push({ ctx, size });
  }

  if (samples.length < 2) {
    console.log("    SKIP — need two usable context samples");
    return true;
  }

  let ok = true;
  for (let i = 1; i < samples.length; i++) {
    const lo = samples[i - 1];
    const hi = samples[i];
    const measured = hi.size - lo.size;
    // Both context-scaling terms are under test: the KV cache and the compute
    // buffer. Weights and any fixed overhead cancel in the subtraction.
    const at = (ctx: number) => kvCacheBytes(arch, ctx, 0).bytes + computeBufferBytes(arch, ctx);
    const predicted = at(hi.ctx) - at(lo.ctx);
    const error = predicted === 0 ? (measured === 0 ? 0 : 1) : (measured - predicted) / predicted;
    const pass = Math.abs(error) <= TOLERANCE;
    ok &&= pass;
    console.log(
      `    ${lo.ctx} → ${hi.ctx}: predicted ${(predicted / MIB).toFixed(1)} MiB, ` +
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
    allOk &&= await verify(m);
  } catch (e) {
    console.log(`\n=== ${m}\n    ERROR ${(e as Error).message}`);
    allOk = false;
  }
}

console.log(allOk ? "\nAll models within tolerance." : "\nSome models out of tolerance.");
process.exit(allOk ? 0 : 1);
