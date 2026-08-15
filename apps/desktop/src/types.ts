// Mirrors the Rust types exposed by `anchor-core` over Tauri commands.
// Keep the wire types (`Model`, `ModelStatus`) in sync with
// `crates/anchor-core/src/lib.rs`.

export type ModelStatus = "installed" | "available";

/** The model record as it crosses the Tauri boundary from `anchor-core`. */
export interface Model {
  id: string;
  name: string;
  family: string;
  size_bytes: number | null;
  status: ModelStatus;
  /** Ollama's parameter-size label, e.g. "8.0B". Null when unknown. */
  parameter_size: string | null;
  /** Quantisation reported by Ollama, e.g. "Q4_K_M". Null when unknown. */
  quantization: string | null;
  /** Max context window in tokens (from `/api/show`). Null when unknown. */
  context_tokens: number | null;
  /** Last-modified timestamp Ollama reports (ISO 8601). Null when unknown. */
  modified_at: string | null;
  /** Producing lab/org from GGUF metadata, e.g. "Meta". Null when unknown. */
  publisher: string | null;
  /** GGUF architecture metadata driving exact KV sizing. Null when unavailable. */
  arch: ArchMeta | null;
}

/**
 * GGUF architecture fields from Ollama's `/api/show`, mirrored from
 * `anchor_core::ArchMeta`. Drives exact KV-cache sizing — see `lib/kv.ts`.
 *
 * Every field is nullable, and not only because older GGUFs omit them: Ollama
 * serialises *array-valued* metadata as JSON `null`, so genuinely present keys
 * arrive empty on models whose value varies per layer (qwen3.5's
 * `head_count_kv`, gemma4's `sliding_window_pattern`).
 */
export interface ArchMeta {
  architecture: string | null;
  /** Transformer layer count. */
  block_count: number | null;
  /** Attention query heads. */
  head_count: number | null;
  /** Attention key/value heads. Equals head_count under MHA, smaller under GQA. */
  head_count_kv: number | null;
  /** Hidden size. */
  embedding_length: number | null;
  /** Per-head key dimension. */
  key_length: number | null;
  /** Per-head value dimension; can differ from key_length. */
  value_length: number | null;
  /** Sliding-window span, on architectures that window most layers. */
  sliding_window: number | null;
  /** Per-head key dimension on windowed layers, when it differs. */
  key_length_swa: number | null;
  /** Per-head value dimension on windowed layers, when it differs. */
  value_length_swa: number | null;
  /** Layers reusing another layer's KV cache; subtract from `block_count`. */
  shared_kv_layers: number | null;
}

/**
 * The host's static hardware specs, mirrored from `anchor_core::HardwareProfile`.
 * Best-effort: every probed field may be null when `system_profiler` doesn't
 * report it. Profiled once on first launch and cached to disk by `anchor-system`.
 */
export interface HardwareProfile {
  /** Chip/CPU name, e.g. "Apple M3 Pro" / "Intel Core i7". Null when unknown. */
  chip: string | null;
  /** CPU architecture: "aarch64" | "x86_64". */
  arch: string;
  /** Total physical/unified memory in bytes. Null when unknown. */
  memory_bytes: number | null;
  /** Total CPU cores (performance + efficiency). Null when unknown. */
  total_cores: number | null;
  /** Performance cores, when the platform reports the split. */
  performance_cores: number | null;
  /** Efficiency cores, when the platform reports the split. */
  efficiency_cores: number | null;
  /** GPU cores on Apple Silicon. Null when unknown. */
  gpu_cores: number | null;
  /** macOS product version, e.g. "15.5". Null when unknown. */
  os_version: string | null;
  /** True on Apple Silicon (unified memory). */
  apple_silicon: boolean;
  /** Human model name, e.g. "MacBook Pro". Null when unknown. */
  model_name: string | null;
}

/**
 * One progress event from a streaming `ollama pull`, mirrored from
 * `anchor_hub::PullProgress`. Sent over a Tauri `Channel` during download.
 */
export interface PullProgress {
  /** Phase, e.g. "pulling manifest", "downloading", "verifying sha256", "success". */
  status: string;
  /** Layer digest being transferred, when applicable. */
  digest?: string;
  /** Total bytes for the current layer, when known. */
  total?: number;
  /** Bytes transferred so far for the current layer, when known. */
  completed?: number;
  /** An error Ollama reported mid-stream (HTTP 200), e.g. an unknown model. */
  error?: string;
}

/**
 * Timing/throughput stats from a completed generation, mirrored from
 * `anchor_hub::GenerationStats`. Raw nanosecond durations and token counts; the
 * UI derives readable values, e.g. tok/sec = `eval_count / (eval_duration_ns / 1e9)`.
 */
export interface GenerationStats {
  /** Total wall time for the request, in nanoseconds. */
  total_duration_ns?: number;
  /** Time spent loading the model's weights into RAM, in nanoseconds. */
  load_duration_ns?: number;
  /** Tokens in the prompt that were evaluated. */
  prompt_eval_count?: number;
  /** Time spent evaluating the prompt, in nanoseconds. */
  prompt_eval_duration_ns?: number;
  /** Tokens generated in the response. */
  eval_count?: number;
  /** Time spent generating the response, in nanoseconds. */
  eval_duration_ns?: number;
}

/** Which side of a two-model comparison an event belongs to. */
export type Slot = "a" | "b";

/** Lifecycle phase of one model's run within a comparison. */
export type Phase = "queued" | "loading" | "generating" | "done";

/**
 * One streamed event from the `compare_models` command, mirrored from
 * `anchor_hub::CompareEvent` (serde-tagged on `kind`). Sent over a Tauri
 * `Channel` while the two models run sequentially; the frontend buffers tokens
 * and reveals both responses side-by-side.
 */
export type CompareEvent =
  /** Download progress while a not-yet-installed model is pulled. */
  | { kind: "pull"; slot: Slot; progress: PullProgress }
  /** A lifecycle transition for the slot. */
  | { kind: "status"; slot: Slot; phase: Phase }
  /** One streamed response delta (for liveness; may be buffered). */
  | { kind: "token"; slot: Slot; text: string }
  /** The final, complete response and its generation stats. */
  | { kind: "result"; slot: Slot; response: string; stats: GenerationStats }
  /** The slot failed (pull or generation error); the other slot still runs. */
  | { kind: "failed"; slot: Slot; message: string };

// ---------------------------------------------------------------------------
// Frontend-only enrichment.
//
// `ModelSpec` is the UI-side spec shape that `lib/catalog.ts` derives from the
// backend catalog (`ModelProfile`) and overlays with live Ollama facts once a
// model is installed.
// ---------------------------------------------------------------------------

/** Quantisation level, kept loose since registries expose many variants. */
export type Quant = string; // e.g. "Q4_K_M", "Q8_0", "F16"

/**
 * What a model can do. Drives the pre-ranking filter in semantic search (a
 * "computer vision" query must never surface a text-only model) and the
 * capability badges in the UI. Mirrors `anchor_search::Capability` (lowercase).
 */
export type Capability = "vision" | "code" | "embedding" | "reasoning" | "general";

/** Static, catalog-level facts about a model (independent of install state). */
export interface ModelSpec {
  /** Parameter count in billions, e.g. 8 for an 8B model. */
  params_b: number;
  /** Quantisation of the default/installed variant. */
  quant: Quant;
  /** Maximum context window in tokens. */
  context_tokens: number;
  /** Download size in bytes (catalog estimate when not yet installed). */
  download_bytes: number;
  /** One-line description of what the model is good at. */
  blurb: string;
  /** Suggested use cases, shown as chips on the model card. */
  use_cases: string[];
  /** Publisher / org, e.g. "Meta", "Mistral AI". */
  publisher: string;
  /** What the model can do — at least one entry. */
  capabilities: Capability[];
}

/**
 * A curated catalog entry as returned by the `list_catalog` backend command
 * (mirrors `anchor_search::ModelProfile`). Replaces the old hard-coded
 * frontend catalog; `buildLibrary` joins these against live installed models.
 */
export interface ModelProfile {
  id: string;
  name: string;
  family: string;
  publisher: string;
  params_b: number;
  context_tokens: number;
  quant: Quant;
  /** Catalog estimate of download size in gigabytes (binary, GiB). */
  download_gb: number;
  /**
   * GGUF architecture fields, shipped with the catalog by
   * `tools/generate-arch.mjs`. Present for available models too, which is what
   * lets an uninstalled model get exact KV math instead of a size bucket.
   */
  arch: ArchMeta | null;
  blurb: string;
  use_cases: string[];
  /** Authored description used for semantic search (not shown directly). */
  profile: string;
  /** What the model can do — at least one entry. Mirrors the Rust `capabilities`. */
  capabilities: Capability[];
}

/**
 * A semantic-search hit, mirroring `anchor_search::ScoredModel`. Returned by the
 * `search_models` command: a catalog profile plus its cosine similarity to the
 * query (`1.0` = identical direction, higher = more relevant).
 */
export interface ScoredModel {
  profile: ModelProfile;
  score: number;
}

/**
 * One recorded search, mirroring `anchor_search::QueryRecord`. Returned by the
 * `recent_searches` command (newest first).
 */
export interface QueryRecord {
  query: string;
  /** Unix epoch milliseconds when the query was recorded. */
  timestamp_ms: number;
  /** Model ids that were returned for this query, most relevant first. */
  results: string[];
}

/**
 * A model as the library UI consumes it: the wire `Model` joined with its
 * catalog spec plus user-local annotations (tags / notes).
 */
export interface LibraryModel extends Model {
  spec: ModelSpec;
  /** User-applied tags. Local-only until the registry persists them. */
  tags: string[];
  /** Free-form user note. */
  note: string;
}

/** Progress state for an in-flight download. */
export interface DownloadState {
  modelId: string;
  /** 0–1. */
  progress: number;
  /** Bytes received so far. */
  receivedBytes: number;
  status: "downloading" | "verifying" | "done" | "error";
  error?: string;
}

export type StatusFilter = "all" | ModelStatus;
export type SortKey = "name" | "size" | "params";

// ---------------------------------------------------------------------------
// Navigation.
// ---------------------------------------------------------------------------

/** The top-level sections selectable from the sidebar. */
export type Tab = "chat" | "models" | "storage" | "benchmarks" | "settings";

/** Sub-views inside the Models hub. */
export type ModelsTab = "installed" | "discover" | "browse" | "compare";

/** Live Ollama server status. Mirrors the `get_server_status` command. */
export interface ServerStatus {
  reachable: boolean;
  version: string | null;
  managed: boolean;
  /** Base URL in use, from `OLLAMA_HOST` or the loopback default. */
  host: string;
  /** False when `OLLAMA_HOST` points off this machine — see the Settings warning. */
  local: boolean;
}

// ---------------------------------------------------------------------------
// Chat. Mirrors `anchor_hub::{Conversation, StoredMessage}` and the Tauri
// `ChatEvent`; driven by the `run_chat` command over a Tauri Channel, with
// conversations/messages persisted in SQLite.
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant" | "system";

/** A persisted chat conversation. Mirrors `anchor_hub::Conversation`. */
export interface Conversation {
  id: string;
  title: string;
  model: string;
  /** The preset it runs under; null falls back to `DEFAULT_PRESET_ID`. */
  preset_id: string | null;
  created_ms: number;
  updated_ms: number;
}

/**
 * A named bundle of generation settings. Mirrors `anchor_hub::Preset`.
 *
 * Every tuning field is nullable, and null means "leave it to Ollama" — the
 * settings panel edits the seeded `default` row, so the app's inference defaults
 * and its presets are the same thing.
 */
export interface Preset {
  id: string;
  name: string;
  /** Prepended as a system turn at request time; never stored as a message. */
  system: string | null;
  temperature: number | null;
  num_ctx: number | null;
  top_p: number | null;
  /** The model this preset was written for, when it's model-specific. */
  model: string | null;
  created_ms: number;
}

/** Id of the preset every conversation falls back to. Mirrors `anchor_hub::DEFAULT_PRESET_ID`. */
export const DEFAULT_PRESET_ID = "default";

/**
 * One model Ollama currently has resident, from `GET /api/ps`. Mirrors
 * `anchor_hub::status::RunningModel`.
 */
export interface RunningModel {
  name: string;
  /** Bytes held in VRAM, when reported. */
  size_vram: number | null;
  /**
   * Resident bytes as `/api/ps` reports them. Documented as the total, but it
   * tracks the GPU-resident share: a model llama.cpp splits across Metal and CPU
   * reports only the Metal side, measured ~6 GiB low on gemma4:e4b. On unified
   * memory the physical RAM is the same either way, so this under-reports rather
   * than mismeasures — the UI labels it accordingly.
   */
  size: number | null;
  /** The context length it was actually loaded with (Ollama clamps requests). */
  context_length: number | null;
}

/**
 * One model in the public Ollama library. Mirrors `anchor_hub::library::LibraryEntry`.
 *
 * Not to be confused with `LibraryModel` above — that's Anchor's *installed*
 * library joined against the curated catalog; this is the whole of ollama.com,
 * i.e. everything that could be downloaded.
 */
export interface LibraryEntry {
  name: string;
  description: string;
  /** Badges from the listing: `tools`, `vision`, `thinking`, `embedding`, … */
  capabilities: string[];
  /** Parameter variants, e.g. `["8b", "70b"]`; pullable as `name:size`. */
  sizes: string[];
  pulls: number;
  tag_count: number;
  /** Relative recency as published, e.g. `"1 year ago"`. */
  updated: string;
}

/** One pullable tag of a library model. Mirrors `anchor_hub::library::LibraryTag`. */
export interface LibraryTag {
  /** Full id to pull, e.g. `"llama3.1:8b"`. */
  tag: string;
  size: string;
  context: string;
  modality: string;
  digest: string;
}

/** One stored chat turn. Mirrors `anchor_hub::StoredMessage`. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** A thinking model's reasoning for an assistant turn; null otherwise. */
  thinking: string | null;
  /** Raw JSON of `GenerationStats` for an assistant turn; null for user turns. */
  stats_json: string | null;
  created_ms: number;
}

/**
 * One streamed event from the `run_chat` command, mirrored from the Tauri
 * `ChatEvent` (serde-tagged on `kind`).
 */
export type ChatEvent =
  /** The model is being loaded into memory; the wait before the first token is
   *  a disk load, not generation. Only sent for a cold model. */
  | { kind: "loading"; model: string }
  /** One streamed response delta. */
  | { kind: "token"; text: string }
  /** One streamed reasoning delta (thinking-capable models only). */
  | { kind: "thinking"; text: string }
  /** The assistant turn finished; `response` is the full, authoritative text
   *  (a thinking model may stream nothing and only produce it here), `thinking`
   *  its reasoning (empty if none). */
  | { kind: "result"; response: string; thinking: string; stats: GenerationStats }
  /** The turn failed (the user message stays persisted for a retry). */
  | { kind: "failed"; message: string };

// ---------------------------------------------------------------------------
// Hardware-truth engine — fit, quant, and throughput. Consumed by the fit
// breakdown panel, the model table, and Compare. All numbers are ESTIMATES
// unless a run has been measured; the UI must label which is shown.
// ---------------------------------------------------------------------------

/** The quantisations the fit engine reasons about, smallest → largest. */
export type QuantId = "Q3_K_S" | "Q4_K_M" | "Q5_K_M" | "Q8_0";

/** Static facts about one quantisation, used to size weights and inform the UI. */
export interface QuantMeta {
  id: QuantId;
  /** Bits per weight, e.g. Q4_K_M ≈ 4.8. Drives the weights-size estimate. */
  bpw: number;
  /** Short quality tier: "smallest" | "balanced" | "high" | "max". */
  qualityLabel: string;
  /** One-line size/quality tradeoff, shown in the UI. */
  qualityNote: string;
}

/** The memory math behind a fit verdict, surfaced in the "why Tight?" panel. */
export interface FitBreakdown {
  /** Model weights at the chosen quant. */
  weightsGB: number;
  /** KV cache at the chosen context length. */
  kvCacheGB: number;
  /**
   * Attention scores and mask the inference graph holds for a batch. Scales
   * with context like the KV cache, and on small models exceeds it.
   */
  computeBufferGB: number;
  /** Memory left for macOS and other apps. */
  osReserveGB: number;
  /** weights + kv + compute + reserve — the baseline the machine must clear. */
  totalNeededGB: number;
  /** The host's unified/total memory. */
  availableGB: number;
}

/** A full fit verdict for a (model, quant, context, hardware) tuple. */
export interface FitResult {
  tier: FitTier;
  fits: boolean;
  /** availableGB − totalNeededGB. Negative ⇒ won't fit. */
  headroomGB: number;
  breakdown: FitBreakdown;
  /** Whether the memory terms came from real metadata or a size bucket. */
  kvSource: KvSource;
}

/** Mirrors `lib/kv.ts` — how a memory figure was derived. */
export type KvSource = "metadata" | "estimated";

// ---------------------------------------------------------------------------
// Community benchmarks. Mirrors `anchor_core::{BenchRun, HwIdentity, ...}` and
// `anchor_hub::bench`. Results are matched to the viewer's machine, so every
// row carries the hardware identity it was measured on.
// ---------------------------------------------------------------------------

/** The hardware facts a benchmark result is matched on. */
export interface HwIdentity {
  /** Exact-match key, e.g. "apple-m4-10c-10g-16gb". */
  hw_key: string;
  /** Chip-family key, e.g. "apple-m4". The loosest matching tier. */
  chip_key: string;
  chip: string;
  cpu_cores: number | null;
  gpu_cores: number | null;
  memory_gb: number | null;
  os_version: string | null;
}

/** How closely a result's machine matches the viewer's, most specific first. */
export type MatchQuality = "exact" | "same_chip_memory" | "same_family";

/** Where a benchmark row came from. */
export type BenchSource = "local" | "community";

/** Mirrors `anchor_core::EnvTelemetry` — a live snapshot taken around a run. */
export interface EnvTelemetry {
  /** `pmset -g therm`'s CPU_Speed_Limit, percent. 100 = unthrottled.
   *  Intel-era only — always null on Apple Silicon. */
  thermal_pressure_pct: number | null;
  /** macOS thermal pressure: 0 nominal, 10 moderate, 20 heavy, 30 trapping,
   *  40 sleeping. The signal Apple Silicon actually publishes. */
  thermal_level: number | null;
  on_ac_power: boolean | null;
  uptime_secs: number | null;
  free_memory_bytes: number | null;
  /** Models resident other than the one under test. */
  resident_model_count: number | null;
}

/** One content-addressed blob under Ollama's `blobs/` dir. Mirrors `anchor_core::StorageBlob`. */
export interface StorageBlob {
  digest: string;
  size_bytes: number;
}

/**
 * Result of scanning Ollama's on-disk model store. Mirrors `anchor_core::StorageScan`.
 * `scan_storage` returns `null` when the store doesn't exist yet.
 */
export interface StorageScan {
  root: string;
  blobs_bytes: number;
  manifests_bytes: number;
  dedup_savings_bytes: number;
  orphaned_blobs: StorageBlob[];
  orphaned_bytes: number;
  /** Manifests that couldn't be read or parsed. Non-zero forces `orphaned_blobs`
   *  empty — an incomplete reference graph can't tell a dead blob from a live
   *  one, so cleanup is withheld rather than risking real model data. */
  unreadable_manifests: number;
}

/** One benchmark result: a model, a configuration, a machine, and what it did. */
export interface BenchRun {
  id: string;
  hw: HwIdentity;
  model_name: string;
  /** Content digest — the real model identity, since a tag can be re-pointed. */
  model_digest: string;
  quant: string | null;
  num_ctx: number;
  kv_cache_type: string;
  flash_attn: boolean;
  ollama_version: string | null;
  suite_id: string;
  suite_version: number;
  /** Prompt-processing throughput, median over `repeats`. */
  prefill_tps_median: number | null;
  /** Generation throughput, median over `repeats`. */
  decode_tps_median: number | null;
  load_ms: number | null;
  peak_rss_bytes: number | null;
  repeats: number;
  install_id: string;
  rating: number | null;
  review: string | null;
  visible: boolean;
  /** Unix epoch milliseconds. */
  created_at: number;
  updated_at: number;
  source: BenchSource;
  synced_at: number | null;
  /** Set by a match query; absent on a row read back directly. */
  match_quality?: MatchQuality;
  /** Catalog id of the scenario this row measures, e.g. "rag". `null` only on rows from a retired suite. */
  prompt_id: string | null;
  /** Version of the prompt text, independent of `suite_version`. `null` on those same retired rows. */
  prompt_version: number | null;
  /** Time-to-first-token proxy, median over repeats, in milliseconds. */
  ttft_ms_median: number | null;
  env_start: EnvTelemetry | null;
  env_end: EnvTelemetry | null;
  /** "sustained" | "throttled" | "unknown", derived from the thermal delta across the run. */
  thermal_label: string | null;
  /** Free-text anomaly notes, auto-populated where derivable, user-editable. */
  notes: string | null;
}

/** Mirrors `anchor_core::BenchSample` — one repeat's raw measurement behind a BenchRun's medians. */
export interface BenchSample {
  id: string;
  bench_run_id: string;
  /** 0 = warmup, 1..=repeats = measured. */
  repeat_index: number;
  is_warmup: boolean;
  prefill_tps: number | null;
  decode_tps: number | null;
  ttft_ms: number | null;
  prompt_eval_count: number | null;
  prompt_eval_duration_ns: number | null;
  eval_count: number | null;
  eval_duration_ns: number | null;
  total_duration_ns: number | null;
  load_duration_ns: number | null;
  wall_start_ms: number;
  created_at: number;
}

/** Repeats tradeoff: `fast` runs the long-generation scenarios once, `thorough` runs everything three times. */
export type BenchRepeatsMode = "thorough" | "fast";

/** Streamed progress from a running benchmark (`anchor_hub::BenchProgress`). */
export type BenchProgress =
  | { kind: "status"; message: string }
  | { kind: "run"; index: number; total: number; decode_tps: number }
  | { kind: "scenario_started"; scenario_id: string; num_ctx: number; index: number; total: number }
  | { kind: "scenario_done"; run: BenchRun; index: number; total: number }
  | { kind: "done"; runs: BenchRun[] }
  | { kind: "failed"; message: string }
  /** A live instantaneous decode-rate reading, throttled (~90ms), for the running graphic. */
  | { kind: "sample"; tps: number };

/** Fit tier, re-exported shape kept in sync with `lib/fit.ts`. */
export type FitTier = "ok" | "tight" | "wont_fit" | "unknown";

/** A throughput figure and whether it was measured on this machine or estimated. */
export interface TokPerSec {
  value: number;
  source: "measured" | "estimated";
}

/** One measured comparison run, persisted locally so estimates can be replaced. */
export interface MeasuredRun {
  modelId: string;
  /** Host chip name, e.g. "Apple M4". Null when unknown. */
  chip: string | null;
  quant: QuantId | string;
  tokPerSec: number;
  prompt: string;
  /** Unix epoch milliseconds. */
  ts: number;
}
