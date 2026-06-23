//! Tauri shell for Anchor.
//!
//! This crate is deliberately thin: every command here is a small wrapper that
//! delegates to the domain crates. Model discovery, the SQLite cache, Ollama
//! calls, and the server lifecycle all live in [`anchor_hub`]; commands just
//! resolve the cache path, make sure the Ollama server is up, call the registry,
//! and adapt errors to strings for the IPC boundary.

use std::process::Child;
use std::sync::Mutex;

use anchor_core::{HardwareProfile, Model};
use anchor_hub::server::{self, EnsureOutcome};
use anchor_hub::{CompareEvent, PullProgress, Registry};
use anchor_search::SemanticIndex;
use anchor_system::Profiler;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent};

/// Owns Anchor's relationship to the Ollama server.
///
/// - `child` holds the `ollama serve` process Anchor started, if any, so it can
///   be stopped on exit. It stays `None` when a server was already running (we
///   never kill a server we didn't start).
/// - `start_lock` serializes startup so two commands firing at once (e.g. an
///   initial `list_models` while the user clicks download) can't both observe a
///   down server and each spawn `ollama serve`. The holder re-checks liveness
///   inside [`server::ensure_running`] before spawning.
/// - `compare_lock` serializes [`compare_models`] runs so two side-by-side
///   comparisons can't load models concurrently and exhaust RAM — the whole
///   point of the feature is that only one model is resident at a time.
#[derive(Default)]
struct ServerState {
    child: Mutex<Option<Child>>,
    start_lock: tokio::sync::Mutex<()>,
    compare_lock: tokio::sync::Mutex<()>,
}

/// Holds the semantic-search index built at launch.
///
/// The index — every catalogued model profile plus its embedding vector — is
/// computed in the background during `setup` (the first launch downloads the
/// embedding model, so it must not block startup) and stored here. `None` until
/// the build finishes, and stays `None` if it fails: search is best-effort and a
/// build failure never blocks the rest of the app.
#[derive(Default)]
struct SearchState {
    index: tokio::sync::RwLock<Option<SemanticIndex>>,
}

/// Builds a [`Registry`] backed by `registry.db` in the app's data directory.
fn registry(app: &AppHandle) -> Result<Registry, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Registry::open(dir.join("registry.db")).map_err(|e| e.to_string())
}

/// Makes sure an Ollama server is reachable, starting one if needed.
///
/// Fast-paths the common case (server already up) without locking, then
/// serializes actual startup behind `start_lock` so concurrent commands can't
/// double-spawn: [`server::ensure_running`] re-checks liveness under the lock and
/// only spawns when nothing is listening. A process Anchor starts is stashed in
/// [`ServerState`] so it can be killed on exit.
async fn ensure_server(app: &AppHandle) -> Result<(), String> {
    let host = anchor_hub::ollama_host();
    if server::is_running(&host).await {
        return Ok(());
    }
    let state = app.state::<ServerState>();
    // Only one startup runs at a time; the loser re-checks and sees it up.
    let _start = state.start_lock.lock().await;
    match server::ensure_running(&host).await {
        EnsureOutcome::AlreadyRunning => Ok(()),
        EnsureOutcome::Started(child) => {
            // Replace any prior handle; killing a stale one avoids orphans.
            let mut guard = state.child.lock().unwrap();
            if let Some(mut old) = guard.replace(child) {
                let _ = old.kill();
            }
            Ok(())
        }
        EnsureOutcome::NotInstalled => Err(
            "Ollama isn't installed (or couldn't be found). Install it from https://ollama.com to manage local models."
                .into(),
        ),
        EnsureOutcome::FailedToStart(e) => Err(format!("Couldn't start the Ollama server: {e}")),
    }
}

/// Lists local models: ensures the server is up, syncs from Ollama and caches the
/// result, falling back to the last-synced cache when Ollama is unreachable.
#[tauri::command]
async fn list_models(app: AppHandle) -> Result<Vec<Model>, String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    match registry.sync().await {
        Ok(models) => Ok(models),
        // Ollama down / unreachable: serve the last-synced cache so the UI still
        // has data. But if the cache is also empty we'd otherwise return an empty
        // list and silently hide the failure — surface the original sync error so
        // the UI can show *why* nothing appeared instead of a blank library.
        Err(sync_err) => match registry.cached_models() {
            Ok(cached) if !cached.is_empty() => Ok(cached),
            Ok(_) => Err(sync_err.to_string()),
            Err(db_err) => Err(format!("{sync_err}; cache unavailable: {db_err}")),
        },
    }
}

/// Returns the curated model catalog (authored profiles + display specs) that
/// the library joins against live installed models. This is the backend source
/// of truth that replaces the frontend's old hard-coded catalog.
#[tauri::command]
fn list_catalog() -> Result<Vec<anchor_search::ModelProfile>, String> {
    anchor_search::load_profiles().map_err(|e| e.to_string())
}

/// Pulls a model via Ollama, streaming progress events back over `on_event`.
#[tauri::command]
async fn download_model(
    app: AppHandle,
    id: String,
    on_event: Channel<PullProgress>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    registry
        .pull(&id, |progress| {
            // Best-effort: a dropped channel (UI navigated away) shouldn't error.
            let _ = on_event.send(progress);
        })
        .await
        .map_err(|e| e.to_string())
}

/// Compares two models against one prompt, streaming progress, tokens, and final
/// results+stats back over `on_event`. Runs the models sequentially (each evicts
/// its weights on finish) so they don't have to fit in RAM at once; the frontend
/// buffers the two responses and reveals them side-by-side. Serialized behind
/// `compare_lock` so two runs can't compete for memory.
#[tauri::command]
async fn compare_models(
    app: AppHandle,
    model_a: String,
    model_b: String,
    prompt: String,
    on_event: Channel<CompareEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    registry
        .compare(&model_a, &model_b, &prompt, |event| {
            // Best-effort: a dropped channel (UI navigated away) shouldn't error.
            let _ = on_event.send(event);
        })
        .await;
    Ok(())
}

/// Removes a model from Ollama and the cache.
#[tauri::command]
async fn remove_model(app: AppHandle, id: String) -> Result<(), String> {
    ensure_server(&app).await?;
    registry(&app)?.remove(&id).await.map_err(|e| e.to_string())
}

/// Builds a [`Profiler`] backed by `hardware.json` in the app's data directory.
fn profiler(app: &AppHandle) -> Result<Profiler, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(Profiler::new(dir.join("hardware.json")))
}

/// Returns the host hardware profile, profiling once and caching to disk on the
/// first call (then reading the cache on later launches).
#[tauri::command]
async fn get_hardware_profile(app: AppHandle) -> Result<HardwareProfile, String> {
    let profiler = profiler(&app)?;
    // `system_profiler` is a blocking subprocess; keep the async runtime free.
    tauri::async_runtime::spawn_blocking(move || profiler.get())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Re-runs the profiler, overwriting the cache. Backs a manual refresh.
#[tauri::command]
async fn refresh_hardware_profile(app: AppHandle) -> Result<HardwareProfile, String> {
    let profiler = profiler(&app)?;
    tauri::async_runtime::spawn_blocking(move || profiler.refresh())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Kicks off the semantic-search index build in the background at launch.
///
/// Embedding model files cache under `app_data_dir()/embeddings` so they
/// download only on first launch and persist afterwards. The build runs on a
/// blocking thread (it's CPU-bound and the first run downloads the model) so the
/// UI stays responsive; the result is stashed in [`SearchState`]. Best-effort:
/// any failure is logged and leaves the index empty rather than crashing.
fn build_semantic_index(app: AppHandle) {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("embeddings"))
        .unwrap_or_else(|_| std::env::temp_dir().join("anchor-embeddings"));

    tauri::async_runtime::spawn(async move {
        match tauri::async_runtime::spawn_blocking(move || SemanticIndex::build(cache_dir)).await {
            Ok(Ok(index)) => {
                let count = index.len();
                *app.state::<SearchState>().index.write().await = Some(index);
                eprintln!("[anchor-search] semantic index ready: {count} models embedded");
            }
            Ok(Err(e)) => eprintln!("[anchor-search] failed to build semantic index: {e}"),
            Err(e) => eprintln!("[anchor-search] index build task failed: {e}"),
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ServerState::default())
        .manage(SearchState::default())
        .setup(|app| {
            build_semantic_index(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_models,
            list_catalog,
            download_model,
            compare_models,
            remove_model,
            get_hardware_profile,
            refresh_hardware_profile
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // On exit, stop the Ollama server *we* started (if any). A server
            // that was already running isn't ours to kill, so its handle is None.
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<ServerState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
