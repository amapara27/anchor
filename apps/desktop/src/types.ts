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
  /** Latent-attention rank; its presence marks an MLA model. */
  kv_lora_rank: number | null;
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
  /** Minimum RAM/VRAM in bytes to run comfortably. */
  min_memory_bytes: number;
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
  /** Catalog estimate of RAM/VRAM in gigabytes to run comfortably. */
  min_memory_gb: number;
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
// Navigation & workflows.
// ---------------------------------------------------------------------------

/** The top-level sections selectable from the sidebar. */
export type Tab = "home" | "search" | "models" | "workflows" | "comparison" | "benchmarks" | "disk";

/**
 * A tool a workflow can enable. Mirrors `anchor_workflows::Tool`
 * (`rename_all = "snake_case"`). The crate is a stub today, so these only drive
 * the frontend mock library until the registry/executor lands.
 */
export type Tool = "web_search" | "file_reader" | "memory";

/**
 * A workflow template shown in the Workflow Library. Superset of the Rust
 * `anchor_workflows::Workflow { id, name, tools }` with frontend-only display
 * fields; the extra fields move onto the wire when the backend is implemented.
 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** Suggested model id (e.g. a catalog id like "llama3.1:8b"). */
  model: string;
  tools: Tool[];
}

// ---------------------------------------------------------------------------
// Research Assistant workflow. Mirrors the `anchor_workflows::research` types;
// driven by the `run_research` command over a Tauri Channel.
// ---------------------------------------------------------------------------

/** How thorough a brief to produce. Mirrors `anchor_workflows::Depth`. */
export type ResearchDepth = "brief" | "standard" | "deep";

/** Output shape for the brief. Mirrors `anchor_workflows::Format`. */
export type ResearchFormat = "report" | "outline" | "qa";

/** Setup for a Research Assistant run. Mirrors `anchor_workflows::ResearchConfig`. */
export interface ResearchConfig {
  model: string;
  focus: string;
  depth: ResearchDepth;
  format: ResearchFormat;
  /** Audience/tone hint, e.g. "explain for a beginner". Empty = default. */
  audience?: string;
  /** Extra instructions appended to the system prompt. Empty = none. */
  system_override?: string;
  /** Tavily API key; falls back to the backend's TAVILY_API_KEY env var. */
  api_key?: string;
}

/** A web source cited in the brief. Mirrors `anchor_workflows::Source`. */
export interface ResearchSource {
  title: string;
  url: string;
  content: string;
}

/** Lifecycle phase of a research run. Mirrors `anchor_workflows::Phase`. */
export type ResearchPhase = "planning" | "searching" | "synthesizing" | "done";

/**
 * One streamed event from the `run_research` command, mirrored from
 * `anchor_workflows::ResearchEvent` (serde-tagged on `kind`).
 */
export type ResearchEvent =
  /** A lifecycle transition. */
  | { kind: "status"; phase: ResearchPhase }
  /** A planned search query (emitted before it's run). */
  | { kind: "query"; text: string }
  /** A source found and kept for synthesis. */
  | { kind: "source"; title: string; url: string }
  /** One streamed synthesis delta. */
  | { kind: "token"; text: string }
  /** The finished brief, its stats, and the sources it drew on. */
  | { kind: "result"; response: string; stats: GenerationStats; sources: ResearchSource[] }
  /** The run failed. */
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
}

/** Streamed progress from a running benchmark (`anchor_hub::BenchProgress`). */
export type BenchProgress =
  | { kind: "status"; message: string }
  | { kind: "run"; index: number; total: number; decode_tps: number }
  | { kind: "done"; run: BenchRun }
  | { kind: "failed"; message: string };

/** State of the rolling weekly written-review allowance. */
export interface ReviewAllowance {
  /** False when a request was refused for being over the allowance. */
  unlocked: boolean;
  used: number;
  allowance: number;
}

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
