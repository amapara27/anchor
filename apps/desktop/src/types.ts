// Mirrors the Rust types exposed by `anchor-core` over Tauri commands.
// Keep in sync with `crates/anchor-core/src/lib.rs`.

export type ModelStatus = "installed" | "available";

export interface Model {
  id: string;
  name: string;
  family: string;
  size_bytes: number | null;
  status: ModelStatus;
}
