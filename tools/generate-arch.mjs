// Fills the `arch` field on every entry in the bundled model catalog by reading
// each model's real GGUF header straight from the Ollama registry.
//
//   node tools/generate-arch.mjs [--dry]
//
// Why this exists: `/api/show` only answers for *installed* models, so a catalog
// entry has no architecture metadata and its KV cache falls back to a
// parameter-count bucket — which is wrong by up to 8x on MHA models, in the
// optimistic direction. The numbers here are read from the same blob the user
// would download, not transcribed from a datasheet.
//
// Build-time only: this writes profiles/models.json and is never shipped or run
// by the app. Re-run it when catalog entries are added or retagged.
//
// The GGUF metadata section sits at the very front of the file, so a ranged GET
// of the first megabyte is enough — 1 MB out of, say, 637 MB.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "crates/anchor-core/profiles/models.json");
const REGISTRY = "https://registry.ollama.ai/v2/library";
const MODEL_LAYER = "application/vnd.ollama.image.model";

/** First fetch size. Every model tried so far carries its arch keys well inside this. */
const FIRST_CHUNK = 1024 * 1024;
/** Cap on paging when a model buries its arch keys behind a big tokenizer array. */
const MAX_CHUNK = 16 * 1024 * 1024;
/** Longest array kept: past any layer count, far short of a vocabulary. */
const MAX_LAYER_ARRAY = 4096;

// --- GGUF ------------------------------------------------------------------

/** Fixed-width GGUF value types → byte size. Types 8 (string) and 9 (array) vary. */
const WIDTH = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const READER = {
  0: (v, o) => v.getUint8(o),
  1: (v, o) => v.getInt8(o),
  2: (v, o) => v.getUint16(o, true),
  3: (v, o) => v.getInt16(o, true),
  4: (v, o) => v.getUint32(o, true),
  5: (v, o) => v.getInt32(o, true),
  6: (v, o) => v.getFloat32(o, true),
  7: (v, o) => v.getUint8(o) !== 0,
  10: (v, o) => Number(v.getBigUint64(o, true)),
  11: (v, o) => Number(v.getBigInt64(o, true)),
  12: (v, o) => v.getFloat64(o, true),
};

/** Thrown when the ranged read stopped mid-value; the caller refetches more. */
class Underrun extends Error {}

/**
 * Parses the metadata key/value section of a GGUF v2/v3 header.
 *
 * Returns a plain `key → value` map. Arrays are skipped rather than
 * materialised: the only array-valued keys here are tokenizer vocabularies,
 * which are megabytes long and irrelevant to KV sizing.
 */
function parseGguf(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;

  const need = (n) => {
    if (off + n > buf.byteLength) throw new Underrun();
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(off, true);
    off += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = Number(view.getBigUint64(off, true));
    off += 8;
    return v;
  };
  const str = () => {
    const n = u64();
    need(n);
    const s = buf.toString("utf8", off, off + n);
    off += n;
    return s;
  };

  const skipValue = (type) => {
    if (type === 8) return str();
    if (type === 9) {
      const elem = u32();
      const count = u64();
      if (elem === 9) throw new Error("nested GGUF array");
      // Short numeric/bool arrays are per-layer patterns (sliding_window_pattern,
      // array-valued head_count_kv); keep them. Long ones are vocabularies.
      if (WIDTH[elem] && count <= MAX_LAYER_ARRAY) {
        return Array.from({ length: count }, () => skipValue(elem));
      }
      if (WIDTH[elem]) {
        need(WIDTH[elem] * count);
        off += WIDTH[elem] * count;
      } else if (elem === 8) {
        for (let i = 0; i < count; i++) str();
      } else {
        throw new Error(`unknown GGUF array element type ${elem}`);
      }
      return null; // string arrays and vocabularies are never a KV-sizing input
    }
    const width = WIDTH[type];
    if (!width) throw new Error(`unknown GGUF value type ${type}`);
    need(width);
    const v = READER[type](view, off);
    off += width;
    return v;
  };

  if (buf.toString("latin1", 0, 4) !== "GGUF") throw new Error("not a GGUF file");
  off = 4;
  const version = u32();
  if (version < 2 || version > 3) throw new Error(`unsupported GGUF version ${version}`);
  u64(); // tensor_count
  const kvCount = u64();

  const meta = {};
  for (let i = 0; i < kvCount; i++) {
    const key = str();
    meta[key] = skipValue(u32());
  }
  return meta;
}

// --- registry --------------------------------------------------------------

/** The model, speculative draft and params layer digests of a tag. */
async function layerDigests(name, tag) {
  const res = await fetch(`${REGISTRY}/${name}/manifests/${tag}`, {
    headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
  });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const layers = (await res.json()).layers ?? [];
  const digest = (type) => layers.find((l) => l.mediaType === type)?.digest;
  if (!digest(MODEL_LAYER)) throw new Error("no model layer in manifest");
  return {
    model: digest(MODEL_LAYER),
    draft: digest("application/vnd.ollama.image.draft"),
    params: digest("application/vnd.ollama.image.params"),
  };
}

/** `draft_num_predict` from a tag's params layer, or null. */
async function draftNumPredict(name, digest) {
  if (!digest) return null;
  const res = await fetch(`${REGISTRY}/${name}/blobs/${digest}`);
  if (!res.ok) return null;
  const v = (await res.json().catch(() => ({}))).draft_num_predict;
  return typeof v === "number" ? v : null;
}

/**
 * Reads the GGUF header, growing the ranged read until the metadata section
 * parses. `Underrun` means the header is genuinely longer than what we asked
 * for — anything else is a real parse failure and propagates.
 */
async function ggufHeader(name, digest) {
  for (let size = FIRST_CHUNK; size <= MAX_CHUNK; size *= 4) {
    const res = await fetch(`${REGISTRY}/${name}/blobs/${digest}`, {
      headers: { Range: `bytes=0-${size - 1}` },
    });
    if (!res.ok && res.status !== 206) throw new Error(`blob ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      return parseGguf(buf);
    } catch (e) {
      if (!(e instanceof Underrun)) throw e;
      // Short read: the whole file is smaller than the window, so paging won't help.
      if (buf.byteLength < size) throw new Error("truncated GGUF header");
    }
  }
  throw new Error(`header exceeds ${MAX_CHUNK} bytes`);
}

// --- extraction ------------------------------------------------------------

/**
 * Pulls the KV-sizing fields out of the metadata map.
 *
 * Mirrors `details_from_info` in crates/anchor-hub/src/ollama.rs — the runtime
 * reader for installed models. **These two must agree**; a Rust test asserts it
 * for any model present in both the catalog and the local install.
 *
 * Prefers the exact `{arch}.{suffix}` key, because multimodal GGUFs carry vision
 * and audio towers whose keys share these suffixes.
 */
function archFrom(meta) {
  const a = meta["general.architecture"];
  const num = (suffix) => {
    const hit = a !== undefined ? meta[`${a}.${suffix}`] : undefined;
    const v = hit ?? Object.entries(meta).find(([k]) => k.endsWith(`.${suffix}`))?.[1];
    return typeof v === "number" ? v : null;
  };
  // Per-layer arrays: exact key only, so a vision tower's array never leaks in.
  const arr = (suffix, elem) => {
    const v = a !== undefined ? meta[`${a}.${suffix}`] : undefined;
    if (!Array.isArray(v) || v.length === 0) return null;
    const out = v.map(elem);
    return out.every((x) => x !== null) ? out : null;
  };
  const flag = (v) => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : null);
  const int = (v) => (typeof v === "number" ? v : null);
  return {
    architecture: typeof a === "string" ? a : null,
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

/** `"mixtral:8x7b"` → `["mixtral", "8x7b"]`; a bare name defaults to `latest`. */
function splitId(id) {
  const [name, tag = "latest"] = id.split(":");
  return [name, tag];
}

// --- main ------------------------------------------------------------------

const dry = process.argv.includes("--dry");
const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
const failed = [];

for (const entry of catalog) {
  const [name, tag] = splitId(entry.id);
  try {
    const digests = await layerDigests(name, tag);
    const arch = archFrom(await ggufHeader(name, digests.model));
    // Ollama loads a speculative drafter beside models whose manifest has one.
    arch.draft = digests.draft ? archFrom(await ggufHeader(name, digests.draft)) : null;
    arch.draft_num_predict = digests.draft ? await draftNumPredict(name, digests.params) : null;
    if (!arch.block_count) throw new Error("no block_count in header");
    entry.arch = arch;
    const swa = arch.sliding_window ? ` swa ${arch.sliding_window}` : "";
    console.log(
      `  ok   ${entry.id.padEnd(24)} ${String(arch.architecture).padEnd(10)} ` +
        `${arch.block_count}L ${arch.head_count_kv}kv ${arch.key_length}/${arch.value_length}${swa}`,
    );
  } catch (e) {
    // A missing entry degrades to the existing parameter-count estimate, which
    // the UI labels. A *wrong* entry would not be labelled — so never guess.
    entry.arch = null;
    failed.push(`${entry.id}: ${e.message}`);
    console.log(`  FAIL ${entry.id.padEnd(24)} ${e.message}`);
  }
}

const ok = catalog.length - failed.length;
console.log(`\n${ok}/${catalog.length} resolved`);
if (failed.length) console.log("failed:\n  " + failed.join("\n  "));

if (dry) {
  console.log("\n--dry: catalog not written");
} else {
  await writeFile(CATALOG, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`\nwrote ${CATALOG}`);
}
