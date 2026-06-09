//! Tauri shell for Anchor.
//!
//! This crate is deliberately thin: every command here is a small wrapper that
//! delegates to [`anchor_core`]. Keep domain logic in `anchor-core` so it stays
//! testable and reusable outside the desktop app.

use anchor_core::Model;

/// Lists the local models Anchor knows about.
#[tauri::command]
fn list_models() -> Vec<Model> {
    anchor_core::list_models()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![list_models])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
