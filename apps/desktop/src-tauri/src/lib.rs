//! Tauri shell for Anchor.
//!
//! This crate is deliberately thin: every command here is a small wrapper that
//! delegates to the domain crates. Model discovery, the SQLite cache, and Ollama
//! calls all live in [`anchor_hub`]; commands just resolve the cache path, call
//! the registry, and adapt errors to strings for the IPC boundary.

use anchor_core::Model;
use anchor_hub::{PullProgress, Registry};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// Builds a [`Registry`] backed by `registry.db` in the app's data directory.
fn registry(app: &AppHandle) -> Result<Registry, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Registry::open(dir.join("registry.db")).map_err(|e| e.to_string())
}

/// Lists local models: syncs from Ollama and caches the result, falling back to
/// the last-synced cache when Ollama is unreachable.
#[tauri::command]
async fn list_models(app: AppHandle) -> Result<Vec<Model>, String> {
    let registry = registry(&app)?;
    match registry.sync().await {
        Ok(models) => Ok(models),
        // Ollama down / unreachable: serve the cache so the UI still has data.
        Err(_) => registry.cached_models().map_err(|e| e.to_string()),
    }
}

/// Pulls a model via Ollama, streaming progress events back over `on_event`.
#[tauri::command]
async fn download_model(
    app: AppHandle,
    id: String,
    on_event: Channel<PullProgress>,
) -> Result<(), String> {
    let registry = registry(&app)?;
    registry
        .pull(&id, |progress| {
            // Best-effort: a dropped channel (UI navigated away) shouldn't error.
            let _ = on_event.send(progress);
        })
        .await
        .map_err(|e| e.to_string())
}

/// Removes a model from Ollama and the cache.
#[tauri::command]
async fn remove_model(app: AppHandle, id: String) -> Result<(), String> {
    registry(&app)?.remove(&id).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_models,
            download_model,
            remove_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
