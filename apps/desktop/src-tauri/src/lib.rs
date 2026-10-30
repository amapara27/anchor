//! Tauri shell for Anchor.
//!
//! This crate is deliberately thin: every command here is a small wrapper that
//! delegates to the domain crates. Model discovery, the SQLite cache, Ollama
//! calls, and the server lifecycle all live in [`anchor_hub`]; commands just
//! resolve the cache path, make sure the Ollama server is up, call the registry,
//! and adapt errors to strings for the IPC boundary.

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use anchor_core::{BenchRun, HardwareProfile, HwIdentity, Model, StorageScan};
use anchor_hub::server::{self, EnsureOutcome};
use anchor_hub::{
    BenchProgress, ChatMessage, ChatRequest, CompareEvent, Conversation, GenerationStats, Preset,
    PullProgress, Registry, RepeatsMode, StoredMessage,
};
use anchor_system::Profiler;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent};

#[cfg(not(feature = "native-e2e"))]
mod tray;
#[cfg(all(dev, target_os = "macos"))]
mod dev_icon;

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
/// - `pulls` maps a model id to the flag its in-flight download watches, so
///   [`cancel_download`] can stop a pull that [`download_model`] is still
///   awaiting. Entries are removed by the pull that owns them.
/// - `chats` is the same idea for generation: a conversation id to the flag its
///   in-flight turn watches, so [`stop_chat`] can end a turn the user no longer
///   wants. Keyed per conversation, since two conversations can generate at once.
/// - `bench_cancel` is [`stop_benchmark`]'s flag. ponytail: one flag, not a map
///   — `compare_lock` and the disabled Run button already mean at most one suite
///   is ever in flight, so there is nothing to key it by.
#[derive(Default)]
struct ServerState {
    child: Mutex<Option<Child>>,
    start_lock: tokio::sync::Mutex<()>,
    compare_lock: tokio::sync::Mutex<()>,
    pulls: Mutex<std::collections::HashMap<String, std::sync::Arc<AtomicBool>>>,
    chats: Mutex<std::collections::HashMap<String, std::sync::Arc<AtomicBool>>>,
    bench_cancel: AtomicBool,
    comparison_cancel: AtomicBool,
    mlx_download: Mutex<Option<std::sync::Arc<AtomicBool>>>,
}

/// Builds a [`Registry`] backed by `registry.db` in the app's data directory.
#[cfg(all(feature = "native-e2e", not(debug_assertions)))]
compile_error!("native-e2e automation must never be enabled in release builds");

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, tauri::Error> {
    #[cfg(feature = "native-e2e")]
    if let Some(path) = std::env::var_os("ANCHOR_E2E_DATA_DIR") {
        return Ok(std::path::PathBuf::from(path));
    }
    app.path().app_data_dir()
}

fn registry(app: &AppHandle) -> Result<Registry, String> {
    let dir = data_dir(&app)
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
            // Recorded so a crash or force-quit — neither of which reaches the
            // exit handler — doesn't strand a server the next launch won't own.
            if let Ok(dir) = data_dir(&app) {
                server::record_pid(&dir, child.id());
            }
            // Replace any prior handle; killing a stale one avoids orphans.
            let mut guard = state.child.lock().unwrap();
            if let Some(mut old) = guard.replace(child) {
                let _ = old.kill();
                let _ = old.wait(); // reap it; `kill` alone leaves a zombie
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
fn list_catalog() -> Result<Vec<anchor_core::catalog::ModelProfile>, String> {
    anchor_core::catalog::load_profiles().map_err(|e| e.to_string())
}

/// How long the scraped Ollama library listing stays good. Models are published
/// on a scale of days, and the page is ~700 KB — a day-old list is fine.
const LIBRARY_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

/// The full public Ollama library — every model installable from ollama.com,
/// not just the curated suggested profiles.
///
/// Served from a SQLite cache; `refresh: true` forces a re-scrape (the button
/// in the UI). Needs no Ollama server: this is about what *could* be installed.
#[tauri::command]
async fn list_library(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<Vec<anchor_hub::library::LibraryEntry>, String> {
    let max_age = if refresh.unwrap_or(false) { 0 } else { LIBRARY_MAX_AGE_MS };
    registry(&app)?
        .library(max_age, now_ms())
        .await
        .map_err(|e| e.to_string())
}

/// Every pullable tag of one library model, fetched when a row is expanded.
#[tauri::command]
async fn library_tags(
    app: AppHandle,
    name: String,
) -> Result<Vec<anchor_hub::library::LibraryTag>, String> {
    registry(&app)?
        .library_tags(&name)
        .await
        .map_err(|e| e.to_string())
}

/// Architecture metadata for a browsable tag, so its memory fit can be computed
/// exactly rather than guessed from parameter count.
///
/// Reads the model's GGUF header from the Ollama registry (~1 MB, never the
/// weights) and caches it against `digest` forever. `Ok(None)` means the header
/// was read but carried nothing usable — the UI keeps its labelled estimate.
#[tauri::command]
async fn tag_arch(
    app: AppHandle,
    tag: String,
    digest: String,
) -> Result<Option<anchor_core::ArchMeta>, String> {
    registry(&app)?
        .tag_arch(&tag, &digest, now_ms())
        .await
        .map_err(|e| e.to_string())
}

/// Pulls a model via Ollama, streaming progress events back over `on_event`.
///
/// Registers a cancel flag under `id` for the duration, so [`cancel_download`]
/// can stop the pull server-side. Returns `Err("cancelled")`, which the frontend
/// treats as a normal terminal state rather than a failure.
#[tauri::command]
async fn download_model(
    app: AppHandle,
    id: String,
    on_event: Channel<PullProgress>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;

    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let state = app.state::<ServerState>();
    state.pulls.lock().unwrap().insert(id.clone(), cancel.clone());

    let result = registry
        .pull(&id, &cancel, |progress| {
            // Best-effort: a dropped channel (UI navigated away) shouldn't error.
            let _ = on_event.send(progress);
        })
        .await;

    // Owned by this pull, so it goes whichever way the pull ended.
    state.pulls.lock().unwrap().remove(&id);
    result.map_err(|e| e.to_string())
}

/// Stops an in-flight download.
///
/// Ollama exposes no cancel endpoint, so this trips the flag the pull's stream
/// loop checks; dropping the response closes the connection and Ollama abandons
/// the transfer. Nothing already written to the blob store is removed — a later
/// pull of the same model resumes from it, which is Ollama's own behaviour.
/// Unknown or already-finished ids are a no-op.
#[tauri::command]
fn cancel_download(app: AppHandle, id: String) {
    if let Some(flag) = app.state::<ServerState>().pulls.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
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
    let state = app.state::<ServerState>();
    state.comparison_cancel.store(false, Ordering::Relaxed);
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let _run = state.compare_lock.lock().await;
    registry
        .compare_cancellable(&model_a, &model_b, &prompt, &state.comparison_cancel, |event| {
            // Best-effort: a dropped channel (UI navigated away) shouldn't error.
            let _ = on_event.send(event);
        })
        .await;
    Ok(())
}

#[tauri::command]
fn stop_comparison(app: AppHandle) {
    app.state::<ServerState>().comparison_cancel.store(true, Ordering::Relaxed);
}

/// Keep-alive for chat: weights stay resident between turns so a follow-up
/// doesn't reload the model. Evicted on leaving chat / switching model (the
/// frontend calls `unload_model`).
const CHAT_KEEP_ALIVE_SECS: i64 = 300;

/// Chars of the first user message kept as a conversation's auto-title.
const CHAT_TITLE_LEN: usize = 60;

/// One streamed event from [`run_chat`]. Mirrored on the frontend as `ChatEvent`.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ChatEvent {
    /// The model isn't resident yet, so the wait before the first token is a
    /// load from disk rather than generation. Only sent for a cold model.
    Loading { model: String },
    /// One streamed response delta.
    Token { text: String },
    /// One streamed reasoning delta (thinking-capable models only).
    Thinking { text: String },
    /// The assistant turn finished; carries the full text (authoritative — a
    /// thinking model may stream nothing and only produce it here), the reasoning
    /// (empty if none), and stats.
    Result { response: String, thinking: String, stats: GenerationStats },
    /// The turn failed (the user message is still persisted for a retry).
    Failed { message: String },
}

/// Streams one assistant turn for a conversation.
///
/// The DB is the source of truth: the user message is persisted first, the full
/// history is loaded and sent to `/api/chat` (so the model's chat template frames
/// the roles), tokens stream back over `on_event`, and the assistant message +
/// stats are persisted on success. Serialized behind `compare_lock` (shared with
/// compare and benchmark) so a turn never competes for RAM with those.
///
/// Generation settings come from the conversation's [`Preset`] (falling back to
/// the default one), read here rather than passed over IPC — so the frontend
/// can't drift from what's stored, and every caller of a conversation gets the
/// same settings.
///
/// The cancel flag is registered before anything else runs. Stop is on screen
/// for the whole turn, including the seconds spent starting a cold server,
/// queueing on `compare_lock`, and loading weights — registering it later (as
/// this once did) left the button inert for exactly those waits.
#[tauri::command]
async fn run_chat(
    app: AppHandle,
    conversation_id: String,
    model: String,
    content: String,
    on_event: Channel<ChatEvent>,
) -> Result<(), String> {
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    app.state::<ServerState>()
        .chats
        .lock()
        .unwrap()
        .insert(conversation_id.clone(), cancel.clone());
    // One exit point, so the flag is always removed however the turn ends — a
    // stale flag would abort the *next* turn in this conversation.
    let outcome = chat_turn(&app, &conversation_id, model, content, &cancel, &on_event).await;
    app.state::<ServerState>().chats.lock().unwrap().remove(&conversation_id);
    outcome
}

/// The body of [`run_chat`], split out so its caller owns flag registration.
async fn chat_turn(
    app: &AppHandle,
    conversation_id: &str,
    model: String,
    content: String,
    cancel: &AtomicBool,
    on_event: &Channel<ChatEvent>,
) -> Result<(), String> {
    /// Ends a turn that was stopped before it generated anything. No assistant
    /// message is persisted — a blank bubble is worse than none — but `Result`
    /// still goes out so the frontend clears `running` and reloads from the DB.
    fn stopped_early(on_event: &Channel<ChatEvent>) -> Result<(), String> {
        let _ = on_event.send(ChatEvent::Result {
            response: String::new(),
            thinking: String::new(),
            stats: GenerationStats::default(),
        });
        Ok(())
    }

    ensure_server(app).await?;
    if cancel.load(Ordering::Relaxed) {
        return stopped_early(on_event);
    }
    let registry = registry(app)?;

    // First message in an empty conversation names it (and it may switch models).
    let prior = registry.messages_for(conversation_id).map_err(|e| e.to_string())?;
    if prior.is_empty() {
        let title: String = content.trim().chars().take(CHAT_TITLE_LEN).collect();
        let _ = registry.rename_conversation(conversation_id, if title.is_empty() { "New chat" } else { &title });
    }
    let _ = registry.set_conversation_model(conversation_id, &model);

    // Persist the user turn, then build the message array from full history.
    registry
        .append_message(
            conversation_id,
            &StoredMessage {
                id: rand_hex(8)?,
                role: "user".into(),
                content: content.clone(),
                thinking: None,
                stats_json: None,
                created_ms: now_ms(),
            },
        )
        .map_err(|e| e.to_string())?;
    let mut messages: Vec<ChatMessage> = registry
        .messages_for(conversation_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| ChatMessage { role: m.role, content: m.content })
        .collect();

    // Preset resolution is best-effort: a DB hiccup falls back to Ollama's own
    // defaults rather than failing a turn the user is waiting on.
    let preset = registry.preset_for_conversation(conversation_id).ok().flatten();

    // The system turn is prepended per request, never persisted — storing it
    // would re-prepend a second copy on the next turn, and again on the one
    // after that.
    if let Some(system) = preset
        .as_ref()
        .and_then(|p| p.system.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        messages.insert(
            0,
            ChatMessage { role: "system".into(), content: system.to_string() },
        );
    }

    let req = ChatRequest {
        model,
        messages,
        keep_alive_secs: CHAT_KEEP_ALIVE_SECS,
        // Omit `think` so thinking-capable models stream their reasoning (surfaced
        // collapsed in the UI) while others answer directly. `Some(true)` would
        // error on non-thinking models like llama3.1.
        think: None,
        num_ctx: preset.as_ref().and_then(|p| p.num_ctx),
        temperature: preset.as_ref().and_then(|p| p.temperature),
        top_p: preset.as_ref().and_then(|p| p.top_p),
    };

    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    // The queue behind this lock is the other window Stop has to work in: a
    // benchmark ahead of us holds it for minutes.
    if cancel.load(Ordering::Relaxed) {
        return stopped_early(on_event);
    }

    // A cold model spends several seconds loading before the first token, which
    // otherwise reads as a hung app. Only announced when the model really is
    // cold — a resident one goes straight to prompt eval. Best-effort: an
    // unreachable /api/ps just skips the notice.
    if !anchor_hub::status::running(&registry)
        .await
        .is_ok_and(|list| list.iter().any(|r| r.name == req.model))
    {
        let _ = on_event.send(ChatEvent::Loading { model: req.model.clone() });
    }

    let result = registry
        .chat(&req, cancel, |is_thinking, tok| {
            // Best-effort: a dropped channel (UI navigated away) shouldn't error.
            let _ = on_event.send(if is_thinking {
                ChatEvent::Thinking { text: tok.to_string() }
            } else {
                ChatEvent::Token { text: tok.to_string() }
            });
        })
        .await;

    match result {
        // A stop during the model load returns an empty turn: nothing was
        // generated, so nothing is stored.
        Ok((text, _, _)) if text.is_empty() => stopped_early(on_event),
        Ok((text, thinking, stats)) => {
            let _ = registry.append_message(
                conversation_id,
                &StoredMessage {
                    id: rand_hex(8)?,
                    role: "assistant".into(),
                    content: text.clone(),
                    thinking: (!thinking.is_empty()).then(|| thinking.clone()),
                    stats_json: serde_json::to_string(&stats).ok(),
                    created_ms: now_ms(),
                },
            );
            let _ = on_event.send(ChatEvent::Result { response: text, thinking, stats });
            Ok(())
        }
        Err(e) => {
            let _ = on_event.send(ChatEvent::Failed { message: e.to_string() });
            Ok(())
        }
    }
}

/// Stops the in-flight turn in a conversation, keeping what it generated.
///
/// Ollama exposes no cancel endpoint, so this trips the flag the chat stream
/// loop checks; dropping the response closes the connection and ends the
/// generation. The partial answer still lands in the DB — a stopped turn is a
/// short turn, not a discarded one, so the thread stays coherent for a
/// follow-up. Unknown or already-finished conversations are a no-op.
#[tauri::command]
fn stop_chat(app: AppHandle, conversation_id: String) {
    if let Some(flag) = app.state::<ServerState>().chats.lock().unwrap().get(&conversation_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Rewinds a conversation to the prompt behind `message_id` and returns it, so
/// the frontend can re-send it — the whole of Regenerate.
///
/// Deliberately not a "regenerate" command that re-runs the turn itself: the
/// re-run is an ordinary [`run_chat`], so a regenerated turn is identical to a
/// fresh one (same preset resolution, same cancel plumbing, same persistence).
/// `None` means nothing matched and nothing was deleted.
#[tauri::command]
async fn rewind_to_prompt(
    app: AppHandle,
    conversation_id: String,
    message_id: String,
) -> Result<Option<String>, String> {
    registry(&app)?
        .rewind_to_prompt(&conversation_id, &message_id)
        .map_err(|e| e.to_string())
}

/// Lists chat conversations, most-recently-updated first.
#[tauri::command]
async fn list_conversations(app: AppHandle) -> Result<Vec<Conversation>, String> {
    registry(&app)?.list_conversations().map_err(|e| e.to_string())
}

/// Creates an empty conversation for the given model. Title is set from the
/// first message on the first [`run_chat`]; a `None` preset uses the default.
#[tauri::command]
async fn create_conversation(
    app: AppHandle,
    model: String,
    preset_id: Option<String>,
) -> Result<Conversation, String> {
    registry(&app)?
        .create_conversation(&rand_hex(8)?, "New chat", &model, preset_id, now_ms())
        .map_err(|e| e.to_string())
}

/// Lists generation presets, default first.
#[tauri::command]
async fn list_presets(app: AppHandle) -> Result<Vec<Preset>, String> {
    registry(&app)?.presets().map_err(|e| e.to_string())
}

/// Creates or updates a preset. The frontend owns preset ids (a new one is
/// minted there), so this is a plain upsert.
#[tauri::command]
async fn save_preset(app: AppHandle, preset: Preset) -> Result<(), String> {
    registry(&app)?.save_preset(&preset).map_err(|e| e.to_string())
}

/// Deletes a preset. The default preset is protected — conversations resolve
/// through it — so deleting it is a no-op rather than an error.
#[tauri::command]
async fn delete_preset(app: AppHandle, id: String) -> Result<(), String> {
    registry(&app)?.delete_preset(&id).map_err(|e| e.to_string())
}

/// Points a conversation at a preset; `None` returns it to the default.
#[tauri::command]
async fn set_conversation_preset(
    app: AppHandle,
    id: String,
    preset_id: Option<String>,
) -> Result<(), String> {
    registry(&app)?
        .set_conversation_preset(&id, preset_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Reads a conversation's messages in chronological order.
#[tauri::command]
async fn conversation_messages(app: AppHandle, id: String) -> Result<Vec<StoredMessage>, String> {
    registry(&app)?.messages_for(&id).map_err(|e| e.to_string())
}

/// Evicts a model's weights from Ollama. The frontend calls this when a run is
/// cancelled or its view unmounts, so a dropped generation stream never leaves a
/// model resident. Best-effort — a down server (nothing to unload) is ignored.
#[tauri::command]
async fn unload_model(app: AppHandle, model: String) -> Result<(), String> {
    let _ = registry(&app)?.unload(&model).await;
    Ok(())
}

/// Which models Ollama currently has resident, with each one's real resident
/// size and loaded context length.
///
/// Deliberately does *not* call [`ensure_server`]: this backs a repeating poll,
/// and a status read must never be the thing that starts a server. A down server
/// simply has nothing loaded, which is exactly an empty list.
#[tauri::command]
async fn running_models(app: AppHandle) -> Result<Vec<anchor_hub::status::RunningModel>, String> {
    Ok(anchor_hub::status::running(&registry(&app)?)
        .await
        .unwrap_or_default())
}

/// Removes a model from Ollama and the cache.
#[tauri::command]
async fn remove_model(app: AppHandle, id: String) -> Result<(), String> {
    ensure_server(&app).await?;
    registry(&app)?.remove(&id).await.map_err(|e| e.to_string())
}

/// Scans Ollama's on-disk model store (`blobs/` + `manifests/`): dedupe
/// savings from content-addressed sharing, and blobs no manifest references
/// anymore. `Ok(None)` when the store doesn't exist yet (nothing pulled). Runs
/// on a blocking thread — filesystem walking, like the hardware profiler's
/// subprocess, must not block the async runtime.
#[tauri::command]
async fn scan_storage() -> Result<Option<StorageScan>, String> {
    tauri::async_runtime::spawn_blocking(anchor_hub::storage::scan)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Deletes every orphaned blob listed in `scan` and returns the bytes freed.
#[tauri::command]
async fn clean_orphaned_blobs(scan: StorageScan) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || anchor_hub::storage::clean_orphaned(&scan))
        .await
        .map_err(|e| e.to_string())
}

/// Builds a [`Profiler`] backed by `hardware.json` in the app's data directory.
fn profiler(app: &AppHandle) -> Result<Profiler, String> {
    let dir = data_dir(&app)
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

/// Live status of the Ollama server for the Settings panel.
#[derive(serde::Serialize)]
struct ServerStatus {
    /// The server answers at the configured host.
    reachable: bool,
    /// Its version string, when reachable.
    version: Option<String>,
    /// Anchor started (and owns) this server, vs one that was already running.
    managed: bool,
    /// Base URL actually in use, from `OLLAMA_HOST` or the loopback default.
    host: String,
    /// Whether that host is on this machine. `OLLAMA_HOST` is honoured verbatim,
    /// so it can point at another machine — which sends every prompt and response
    /// off this Mac, contradicting the promise the rest of the UI makes. False
    /// here drives an explicit warning rather than silent remote inference.
    local: bool,
}

/// Reports whether Ollama is reachable, its version, and whether Anchor owns it.
///
/// Thin status read — never starts the server (unlike [`ensure_server`]); the
/// Settings panel shows the real state, including "stopped".
#[tauri::command]
async fn get_server_status(app: AppHandle) -> Result<ServerStatus, String> {
    let host = anchor_hub::ollama_host();
    let reachable = server::is_running(&host).await;
    let version = if reachable {
        anchor_hub::ollama::version(&host).await.ok()
    } else {
        None
    };
    let managed = app.state::<ServerState>().child.lock().unwrap().is_some();
    let local = anchor_hub::is_local_host(&host);
    Ok(ServerStatus { reachable, version, managed, host, local })
}

/// This install's anonymous id — see [`anchor_hub::install_id`], which the CLI
/// shares so both front-ends attribute benchmark rows to the same install.
fn install_id(app: &AppHandle) -> Result<String, String> {
    let dir = data_dir(&app)
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    anchor_hub::install_id(&dir).map_err(|e| e.to_string())
}

/// `n` random bytes from the system CSPRNG, hex-encoded (message ids).
fn rand_hex(n: usize) -> Result<String, String> {
    anchor_hub::rand_hex(n).map_err(|e| e.to_string())
}

/// The host's benchmark match identity, derived from the cached hardware profile.
fn hw_identity(app: &AppHandle) -> Result<HwIdentity, String> {
    let profile = profiler(app)?.get().map_err(|e| e.to_string())?;
    Ok(HwIdentity::from_profile(&profile))
}

/// Repeats tradeoff for a run: `fast` drops the long-generation scenarios to a
/// single repeat, `thorough` runs everything three times.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum BenchRepeatsMode {
    Thorough,
    Fast,
}

impl From<BenchRepeatsMode> for RepeatsMode {
    fn from(mode: BenchRepeatsMode) -> Self {
        match mode {
            BenchRepeatsMode::Thorough => RepeatsMode::Thorough,
            BenchRepeatsMode::Fast => RepeatsMode::Fast,
        }
    }
}

/// Runs the benchmark suite against a model and stores one row per scenario.
///
/// Takes `compare_lock` (shared with `compare_models`) so a benchmark can never
/// run alongside another RAM-heavy generation — a contended run would measure
/// the contention, not the model. That also means a nine-scenario suite can
/// keep a chat turn waiting for minutes, which is why it has to be stoppable.
#[tauri::command]
async fn run_benchmark(
    app: AppHandle,
    model: String,
    repeats: BenchRepeatsMode,
    // One scenario id for the app's quick measure; `None` runs the whole suite.
    scenario: Option<String>,
    on_event: Channel<BenchProgress>,
) -> Result<(), String> {
    let state = app.state::<ServerState>();
    // Cleared here rather than on stop: a Stop pressed after the previous suite
    // ended would otherwise abort this one before it started.
    state.bench_cancel.store(false, Ordering::Relaxed);

    // A stop is a normal terminal state, so it emits `Done` (with whatever
    // completed) the same as a finished suite — the frontend needs no new case.
    let stopped = |on_event: &Channel<BenchProgress>| {
        let _ = on_event.send(BenchProgress::Done { runs: Vec::new() });
        Ok(())
    };

    ensure_server(&app).await?;
    if state.bench_cancel.load(Ordering::Relaxed) {
        return stopped(&on_event);
    }
    let registry = registry(&app)?;
    let hw = hw_identity(&app)?;
    let id = install_id(&app)?;
    let _run = state.compare_lock.lock().await;
    if state.bench_cancel.load(Ordering::Relaxed) {
        return stopped(&on_event);
    }

    let on_progress = |event: BenchProgress| {
        // Best-effort: a dropped channel (UI navigated away) shouldn't error.
        let _ = on_event.send(event);
    };
    let result = registry
        .run_benchmark(&model, &hw, &id, repeats.into(), scenario.as_deref(), &state.bench_cancel, on_progress)
        .await
        .map(|_| ());
    if let Err(e) = result {
        let _ = on_event.send(BenchProgress::Failed {
            message: e.to_string(),
        });
        return Err(e.to_string());
    }
    Ok(())
}

/// Stops the running benchmark suite, keeping the scenarios it already measured.
///
/// Same mechanism as [`stop_chat`] — Ollama has no cancel endpoint, so this
/// trips the flag the suite checks between scenarios and the generation stream
/// reads while waiting for bytes. The interrupted scenario is discarded rather
/// than stored half-measured, and the model is unloaded on the way out. A no-op
/// when nothing is running.
#[tauri::command]
fn stop_benchmark(app: AppHandle) {
    app.state::<ServerState>().bench_cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn calibrate_model(app: AppHandle, model: String, on_event: Channel<BenchProgress>)
    -> Result<Option<anchor_hub::bench::calibration::CalibrationSummary>, String> {
    let state = app.state::<ServerState>();
    state.bench_cancel.store(false, Ordering::Relaxed);
    let _ = on_event.send(BenchProgress::Status { message:"Preparing Ollama".into() });
    ensure_server(&app).await?;
    if state.bench_cancel.load(Ordering::Relaxed) { return Ok(None); }
    let _ = on_event.send(BenchProgress::Status { message:"Waiting for other model work to finish".into() });
    let _run = state.compare_lock.lock().await;
    if state.bench_cancel.load(Ordering::Relaxed) { return Ok(None); }
    let registry = registry(&app)?;
    let export = registry.calibrate_ollama(&model, &hw_identity(&app)?, &install_id(&app)?, &state.bench_cancel, |event| {
        let _ = on_event.send(event);
    }).await.map_err(|e| e.to_string())?;
    registry.calibration_summary(&export.session.id).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn latest_calibration(app: AppHandle, model: String) -> Result<Option<anchor_hub::bench::calibration::CalibrationSummary>, String> {
    registry(&app)?.latest_calibration(&model, &hw_identity(&app)?.hw_key).map_err(|e| e.to_string())
}

#[tauri::command]
fn calibration_report(app: AppHandle, id: String) -> Result<anchor_hub::bench::calibration::CalibrationSummary, String> {
    registry(&app)?.calibration_summary(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mlx_catalog() -> Result<Vec<anchor_hub::bench::mlx_catalog::CatalogModel>, String> {
    tauri::async_runtime::spawn_blocking(anchor_hub::bench::mlx_catalog::catalog)
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_mlx_model(
    app: AppHandle,
    id: String,
    on_event: Channel<anchor_hub::bench::mlx_catalog::DownloadProgress>,
) -> Result<anchor_hub::bench::mlx::NativeModel, String> {
    let root = data_dir(&app).map_err(|e| e.to_string())?.join("mlx-worker");
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<ServerState>();
        let mut active = state.mlx_download.lock().unwrap();
        if active.is_some() { return Err("An MLX download is already running".into()); }
        *active = Some(cancel.clone());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        anchor_hub::bench::mlx_catalog::download(&id, &root, &cancel, |p| { let _ = on_event.send(p); })
            .map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string());
    *app.state::<ServerState>().mlx_download.lock().unwrap() = None;
    result?
}

#[tauri::command]
fn cancel_mlx_download(app: AppHandle) {
    if let Some(flag) = app.state::<ServerState>().mlx_download.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn mlx_models(
    paths: Option<Vec<std::path::PathBuf>>,
) -> Result<Vec<anchor_hub::bench::mlx::NativeModel>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut models = anchor_hub::bench::mlx::cached_models();
        for path in paths.unwrap_or_default().into_iter().take(20) {
            if let Ok(model) = anchor_hub::bench::mlx::local_model(&path) {
                if !models.iter().any(|m| m.path == model.path) {
                    models.push(model);
                }
            }
        }
        models
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn choose_mlx_model(
    app: AppHandle,
) -> Result<Option<anchor_hub::bench::mlx::NativeModel>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a local MLX-LM checkpoint")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        anchor_hub::bench::mlx::local_model(&path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn run_mlx_suite(
    app: AppHandle,
    model_path: std::path::PathBuf,
    repeats: BenchRepeatsMode,
    scenario: Option<String>,
    on_event: Channel<BenchProgress>,
) -> Result<Vec<BenchRun>, String> {
    let state = app.state::<ServerState>();
    state.bench_cancel.store(false, Ordering::Relaxed);
    let _run = state.compare_lock.lock().await;
    if state.bench_cancel.load(Ordering::Relaxed) {
        let _ = on_event.send(BenchProgress::Done { runs: Vec::new() });
        return Ok(Vec::new());
    }
    // Blocking subprocess reads stay off the async/webview threads.
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = registry(&worker_app)?;
        let root = data_dir(&worker_app)
            .map_err(|e| e.to_string())?
            .join("mlx-worker");
        registry
            .run_mlx_suite(
                &model_path,
                &root,
                &hw_identity(&worker_app)?,
                &install_id(&worker_app)?,
                repeats.into(),
                scenario.as_deref(),
                &worker_app.state::<ServerState>().bench_cancel,
                |event| {
                    let _ = on_event.send(event);
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn native_mlx_report(
    app: AppHandle,
    id: String,
) -> Result<anchor_hub::bench::mlx::NativeSummary, String> {
    registry(&app)?
        .native_mlx_summary(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn mlx_suite_report(
    app: AppHandle,
    id: String,
) -> Result<anchor_hub::bench::mlx_suite::MlxSummary, String> {
    registry(&app)?
        .mlx_suite_summary(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn mlx_suite_runs(
    app: AppHandle,
    model_path: Option<std::path::PathBuf>,
    reference_path: Option<std::path::PathBuf>,
    prompt_id: Option<String>,
    history: bool,
) -> Result<Vec<BenchRun>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        registry(&app)?
            .mlx_suite_runs(
                &hw_identity(&app)?,
                model_path.as_deref(),
                reference_path.as_deref(),
                prompt_id.as_deref(),
                history,
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Benchmark results from machines resembling this one, best match first.
/// Each row carries the tier it matched at so the UI can group them.
///
/// `model: None` ranks every benchmarked model against every other one — the
/// leaderboard's cross-model view. Pass `model: Some(id)` to scope to one
/// model instead (the Suite tab's "how does my machine compare" table).
/// `suite_id`/`prompt_id`/`num_ctx` filter which rows come back — pass the
/// current `suite_id` and a `prompt_id` (a scenario id) to pin a ranking to
/// one shape, so a retired suite's numbers are never blended into one
/// leaderboard.
#[tauri::command]
async fn bench_runs_for_model(
    app: AppHandle,
    model: Option<String>,
    suite_id: Option<String>,
    prompt_id: Option<String>,
    num_ctx: Option<u32>,
) -> Result<Vec<BenchRun>, String> {
    let registry = registry(&app)?;
    let hw = hw_identity(&app)?;
    let digest = match &model {
        Some(model) => Some(
            anchor_hub::ollama::digest_of(&anchor_hub::ollama_host(), model)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("{model} is not installed"))?,
        ),
        None => None,
    };
    registry
        .bench_runs_for(&hw, digest.as_deref(), suite_id.as_deref(), prompt_id.as_deref(), num_ctx)
        .map_err(|e| e.to_string())
}

/// This machine's latest headline-scenario run for each installed model whose
/// digest still matches — the measured speed shown on model rows. A re-pulled
/// model has a new digest, so its old number drops out instead of going stale.
#[tauri::command]
async fn latest_measurements(app: AppHandle) -> Result<Vec<BenchRun>, String> {
    let registry = registry(&app)?;
    let hw = hw_identity(&app)?;
    let installed = anchor_hub::ollama::installed_digests(&anchor_hub::ollama_host()).await.map_err(|e| e.to_string())?;
    let runs = registry
        .bench_runs_for(&hw, None, Some(anchor_hub::bench::SUITE_ID), Some(anchor_hub::bench::HEADLINE_SCENARIO), None)
        .map_err(|e| e.to_string())?;
    Ok(runs
        .into_iter()
        .filter(|r| r.hw.hw_key == hw.hw_key && installed.iter().any(|(name, d)| *name == r.model_name && *d == r.model_digest))
        .collect())
}

/// Recent benchmark runs on this exact machine, newest first — the History
/// panel's feed. `model: None` mixes every model together; `Some(id)` scopes
/// to one. Distinct from `bench_runs_for_model`, which ranks by speed rather
/// than time.
#[tauri::command]
async fn bench_history(app: AppHandle, model: Option<String>, limit: u32) -> Result<Vec<BenchRun>, String> {
    let registry = registry(&app)?;
    let hw = hw_identity(&app)?;
    let digest = match &model {
        Some(model) => Some(
            anchor_hub::ollama::digest_of(&anchor_hub::ollama_host(), model)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("{model} is not installed"))?,
        ),
        None => None,
    };
    registry.bench_history(&hw, digest.as_deref(), limit).map_err(|e| e.to_string())
}

#[tauri::command]
fn bench_sessions(app: AppHandle, limit: u32) -> Result<Vec<anchor_hub::bench::evidence::SessionSummary>, String> {
    registry(&app)?.bench_session_summaries(limit.min(200)).map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Relaunches after an update has been staged. Tauri swaps the .app bundle on
/// disk but leaves the old binary running, so nothing changes until this fires.
#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "native-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_opener::init())
        // The native save dialog + file write behind `savePng` (benchmark card
        // export). Only saving — nothing in the app opens a file any more.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Signed auto-updates. The pubkey that verifies them is compiled in
        // from tauri.conf.json, so a build without this plugin can never be
        // updated in place — it has to ship in the very first release.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServerState::default())
        .setup(|app| {
            // Clean up a server a previous run left behind before anything can
            // reuse it and conclude Anchor doesn't own it.
            if let Ok(dir) = data_dir(app.handle()) {
                server::reap_orphan(&dir);
                // ponytail: one-time sweep of the removed semantic search's cache
                // (BGE model, ~130 MB) and query log; delete this once installs have updated.
                let _ = std::fs::remove_dir_all(dir.join("embeddings"));
                let _ = std::fs::remove_file(dir.join("search_history.json"));
            }
            #[cfg(not(feature = "native-e2e"))]
            tray::init(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_models,
            list_catalog,
            list_library,
            library_tags,
            tag_arch,
            download_model,
            cancel_download,
            compare_models,
            stop_comparison,
            run_chat,
            stop_chat,
            rewind_to_prompt,
            list_conversations,
            create_conversation,
            conversation_messages,
            list_presets,
            save_preset,
            delete_preset,
            set_conversation_preset,
            // ponytail: the agents + Research Assistant feature is gone — crate,
            // commands, panels, and storage layer all deleted. It read arbitrary
            // files off a caller-supplied path whose only guard was "the native
            // picker is the trust boundary", an assumption that stopped holding
            // once nothing opened a picker. Bringing it back means rebuilding it,
            // not re-adding a nav item.
            unload_model,
            running_models,
            remove_model,
            scan_storage,
            clean_orphaned_blobs,
            get_hardware_profile,
            refresh_hardware_profile,
            get_server_status,
            run_benchmark,
            stop_benchmark,
            calibrate_model,
            latest_calibration,
            calibration_report,
            mlx_models,
            mlx_catalog,
            download_mlx_model,
            cancel_mlx_download,
            choose_mlx_model,
            run_mlx_suite,
            native_mlx_report,
            mlx_suite_report,
            mlx_suite_runs,
            restart_app,
            bench_runs_for_model,
            bench_history,
            bench_sessions,
            latest_measurements
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(all(dev, target_os = "macos"))]
            if matches!(event, RunEvent::Ready | RunEvent::WindowEvent { event: tauri::WindowEvent::Focused(true), .. }) {
                dev_icon::apply();
            }
            // On exit, make sure nothing is left resident. If we started the
            // server, killing it unloads everything. If it was already running
            // (not ours to kill), best-effort evict any models we may have loaded
            // so quitting Anchor never leaves weights in someone else's Ollama.
            if let RunEvent::Exit = event {
                let child = app.state::<ServerState>().child.lock().unwrap().take();
                match child {
                    Some(mut child) => {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    None => unload_all_resident(app),
                }
                // Shut down cleanly, so the next launch has nothing to reap.
                if let Ok(dir) = data_dir(&app) {
                    server::clear_pid(&dir);
                }
            }
        });
}

/// Best-effort teardown for a server Anchor didn't start: evict every resident
/// model so quitting leaves nothing loaded. Exit is synchronous, so this blocks
/// briefly on a quick `/api/ps` + unload of each model.
fn unload_all_resident(app: &AppHandle) {
    let Ok(registry) = registry(app) else { return };
    tauri::async_runtime::block_on(async {
        let Ok(models) = anchor_hub::status::running(&registry).await else {
            return;
        };
        for model in models {
            let _ = registry.unload(&model.name).await;
        }
    });
}
