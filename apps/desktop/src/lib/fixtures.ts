/**
 * Sample data for UI that has no backend yet.
 *
 * Every export here stands in for a Tauri command that does not exist. Each is
 * commented with the command that will replace it, so the Rust work is a
 * one-file swap: implement the command, delete the export, change the import.
 *
 * Nothing in this file is real. Do not derive user-facing claims from it.
 */

// ---------------------------------------------------------------------------
// Storage — awaits a dedupe/integrity scanner in `anchor-hub`. Nothing today
// computes blob digests, symlink state, or reclaimable space.
// ---------------------------------------------------------------------------

/** Awaits `storage_summary`. */
export const STORAGE_SUMMARY = {
  savedByDedupe: "18.8 GB",
  savedDetail: "4 blobs shared between Ollama and the HF cache",
  reclaimable: "6.7 GB",
  reclaimableDetail: "3 models unused for 30+ days",
  integrity: "1 dead link",
  integrityDetail: "phi4:14b · last scan 6 min ago",
};

/** Awaits `storage_locations`. Paths are the conventional macOS defaults. */
export const STORAGE_LOCATIONS = [
  { label: "Anchor canonical store", path: "~/Library/Application Support/anchor/store", size: "21.4 GB" },
  { label: "Ollama blobs", path: "~/.ollama/models/blobs", size: "0.4 GB of manifests" },
  { label: "Hugging Face cache", path: "~/.cache/huggingface/hub", size: "0.2 GB of refs" },
];

/** Awaits `get_housekeeping_rules` / `set_housekeeping_rule`. */
export const HOUSEKEEPING_RULES = [
  {
    id: "k1",
    label: "Auto-dedupe on scan",
    detail: "Replace duplicate blobs with symlinks after every pull.",
    on: true,
  },
  {
    id: "k2",
    label: "Flag stale after 30 days",
    detail: "Mark unused models and surface them for reclaim.",
    on: true,
  },
  {
    id: "k3",
    label: "Warn before loading over 80% memory",
    detail: "Refuse the load instead of letting macOS swap.",
    on: false,
  },
];

// ---------------------------------------------------------------------------
// Benchmarks — the local suite is real (`run_benchmark`). The community layer
// is not: there is no server to publish to or read from.
// ---------------------------------------------------------------------------

/** Awaits a community results endpoint. */
export const COMMUNITY_FEED = [
  {
    id: "f1",
    handle: "kestrel.dev",
    initials: "KD",
    verified: true,
    match: "identical machine",
    when: "2h ago",
    chip: "M3 Max · 36 GB",
    model: "llama3.1:8b-q4_K_M",
    tps: "49.9 t/s",
    mem: "8.0 GB",
    votes: 42,
    comments: 6,
    note: "Closing every Electron app first bought me ~6 t/s. Also worth setting GPU layers to 33 explicitly — the auto value left two layers on CPU for me.",
  },
  {
    id: "f2",
    handle: "mira.hpc",
    initials: "MH",
    verified: true,
    match: "same chip, 48 GB",
    when: "yesterday",
    chip: "M3 Max · 48 GB",
    model: "llama3.1:8b-q4_K_M",
    tps: "58.4 t/s",
    mem: "8.2 GB",
    votes: 128,
    comments: 19,
    note: "Ran the suite ten times across a day. Sustained decode drops about 9% once the chassis warms up — the single-shot number is optimistic if you plan long sessions.",
  },
  {
    id: "f3",
    handle: "toshiko",
    initials: "TS",
    verified: false,
    match: "same chip family",
    when: "3 days ago",
    chip: "M3 Pro · 18 GB",
    model: "llama3.1:8b-q4_K_M",
    tps: "34.1 t/s",
    mem: "7.9 GB",
    votes: 17,
    comments: 4,
    note: "18 GB is the real ceiling here, not the GPU. Q4 fits fine but anything past a 16k context starts swapping and the numbers fall apart.",
  },
];

/** Awaits the same endpoint as the feed. */
export const CONTRIBUTION = {
  published: 12,
  upvotes: 340,
  rank: "#24",
  firsts: 3,
};

/** Configurations with too few community results. Awaits the same endpoint. */
export const WANTED_RUNS = [
  { name: "M4 · 16 GB · qwen2.5:14b-q4", detail: "2 results" },
  { name: "M1 Max · 32 GB · deepseek-r1:14b", detail: "1 result" },
  { name: "M3 · 24 GB · gemma2:9b-q4", detail: "4 results" },
];
