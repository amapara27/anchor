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
}

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
