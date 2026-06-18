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
// The Model Hub backend (`anchor-hub`) is still a stub, so the rich per-model
// metadata that powers Model Cards isn't on the wire yet. These types describe
// what the UI renders today; when the registry lands, `ModelSpec` should move
// into `anchor-core` and be mirrored back here.
// ---------------------------------------------------------------------------

/** Quantisation level, kept loose since registries expose many variants. */
export type Quant = string; // e.g. "Q4_K_M", "Q8_0", "F16"

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
export type Tab = "home" | "models" | "workflows" | "comparison";

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
