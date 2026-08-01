//! Tauri shell for Anchor.
//!
//! This crate is deliberately thin: every command here is a small wrapper that
//! delegates to the domain crates. Model discovery, the SQLite cache, Ollama
//! calls, and the server lifecycle all live in [`anchor_hub`]; commands just
//! resolve the cache path, make sure the Ollama server is up, call the registry,
//! and adapt errors to strings for the IPC boundary.

use std::process::Child;
use std::sync::Mutex;

use anchor_core::{BenchRun, HardwareProfile, HwIdentity, Model};
use anchor_hub::db::ReviewAllowance;
use anchor_hub::server::{self, EnsureOutcome};
use anchor_hub::{
    AgentRun, BenchProgress, ChatMessage, ChatRequest, CompareEvent, Conversation, GenerationStats,
    PullProgress, Registry, StoredMessage,
};
use anchor_search::{QueryHistory, SemanticIndex};
use anchor_workflows::{ResearchConfig, ResearchEvent};
use anchor_system::Profiler;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent};

mod tray;

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

/// Builds a [`QueryHistory`] backed by `search_history.json` in the app's data
/// directory (the rolling log of the user's recent searches).
fn history(app: &AppHandle) -> Result<QueryHistory, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(QueryHistory::new(dir.join("search_history.json")))
}

/// Ranks the catalog against a natural-language `query` and returns the top
/// `limit` models (default 3) by cosine similarity. Reads the in-memory index
/// built at launch; errors while it's still warming up. Recording the query to
/// history is best-effort and never fails the search.
#[tauri::command]
async fn search_models(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<anchor_search::ScoredModel>, String> {
    let k = limit.unwrap_or(3);
    let state = app.state::<SearchState>();
    let guard = state.index.read().await;
    let index = guard
        .as_ref()
        .ok_or("Model search is still warming up — try again in a moment.")?;
    let results = index.search(&query, k).map_err(|e| e.to_string())?;

    // Best-effort: a failed history write shouldn't sink an otherwise-good search.
    let ids: Vec<String> = results.iter().map(|r| r.profile.id.clone()).collect();
    if let Err(e) = history(&app).and_then(|h| h.record(&query, &ids).map_err(|e| e.to_string())) {
        eprintln!("[anchor-search] failed to record query history: {e}");
    }
    Ok(results)
}

/// Returns the most recent search queries (newest first), for the Discover
/// page's "Recent" suggestions. Reads the same `QueryHistory` store that
/// `search_models` writes to; a missing/empty store yields an empty list.
#[tauri::command]
fn recent_searches(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<Vec<anchor_search::QueryRecord>, String> {
    let mut records = history(&app)?.load();
    records.truncate(limit.unwrap_or(10));
    Ok(records)
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

/// Runs the Research Assistant workflow: plans web searches, gathers sources via
/// Tavily, and streams a cited brief synthesized by the chosen model back over
/// `on_event`. Serialized behind `compare_lock` (shared with `compare_models`)
/// so only one RAM-heavy generation runs at a time.
#[tauri::command]
async fn run_research(
    app: AppHandle,
    config: ResearchConfig,
    on_event: Channel<ResearchEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    anchor_workflows::run_research(&registry, &config, |event| {
        // Best-effort: a dropped channel (UI navigated away) shouldn't error.
        let _ = on_event.send(event);
    })
    .await;
    Ok(())
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
/// compare/research/benchmark) so a turn never competes for RAM with those.
#[tauri::command]
async fn run_chat(
    app: AppHandle,
    conversation_id: String,
    model: String,
    content: String,
    on_event: Channel<ChatEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;

    // First message in an empty conversation names it (and it may switch models).
    let prior = registry.messages_for(&conversation_id).map_err(|e| e.to_string())?;
    if prior.is_empty() {
        let title: String = content.trim().chars().take(CHAT_TITLE_LEN).collect();
        let _ = registry.rename_conversation(&conversation_id, if title.is_empty() { "New chat" } else { &title });
    }
    let _ = registry.set_conversation_model(&conversation_id, &model);

    // Persist the user turn, then build the message array from full history.
    registry
        .append_message(
            &conversation_id,
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
    let messages: Vec<ChatMessage> = registry
        .messages_for(&conversation_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| ChatMessage { role: m.role, content: m.content })
        .collect();

    let req = ChatRequest {
        model,
        messages,
        keep_alive_secs: CHAT_KEEP_ALIVE_SECS,
        // Omit `think` so thinking-capable models stream their reasoning (surfaced
        // collapsed in the UI) while others answer directly. `Some(true)` would
        // error on non-thinking models like llama3.1.
        think: None,
        num_ctx: None,
        temperature: None,
    };

    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    let result = registry
        .chat(&req, |is_thinking, tok| {
            // Best-effort: a dropped channel (UI navigated away) shouldn't error.
            let _ = on_event.send(if is_thinking {
                ChatEvent::Thinking { text: tok.to_string() }
            } else {
                ChatEvent::Token { text: tok.to_string() }
            });
        })
        .await;

    match result {
        Ok((text, thinking, stats)) => {
            let _ = registry.append_message(
                &conversation_id,
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

/// Lists chat conversations, most-recently-updated first.
#[tauri::command]
async fn list_conversations(app: AppHandle) -> Result<Vec<Conversation>, String> {
    registry(&app)?.list_conversations().map_err(|e| e.to_string())
}

/// Creates an empty conversation for the given model. Title is set from the
/// first message on the first [`run_chat`].
#[tauri::command]
async fn create_conversation(app: AppHandle, model: String) -> Result<Conversation, String> {
    registry(&app)?
        .create_conversation(&rand_hex(8)?, "New chat", &model, now_ms())
        .map_err(|e| e.to_string())
}

/// Reads a conversation's messages in chronological order.
#[tauri::command]
async fn conversation_messages(app: AppHandle, id: String) -> Result<Vec<StoredMessage>, String> {
    registry(&app)?.messages_for(&id).map_err(|e| e.to_string())
}

/// Renames a conversation.
#[tauri::command]
async fn rename_conversation(app: AppHandle, id: String, title: String) -> Result<(), String> {
    registry(&app)?.rename_conversation(&id, &title).map_err(|e| e.to_string())
}

/// Deletes a conversation and all of its messages.
#[tauri::command]
async fn delete_conversation(app: AppHandle, id: String) -> Result<(), String> {
    registry(&app)?.delete_conversation(&id).map_err(|e| e.to_string())
}

/// Stores a finished agent run. The frontend owns the streamed run, so it
/// assembles the whole row and hands it over once the run settles.
#[tauri::command]
async fn save_agent_run(app: AppHandle, run: AgentRun) -> Result<(), String> {
    registry(&app)?.save_agent_run(&run).map_err(|e| e.to_string())
}

/// Agent run history, newest first.
#[tauri::command]
async fn agent_runs(app: AppHandle) -> Result<Vec<AgentRun>, String> {
    registry(&app)?.agent_runs(AGENT_RUN_LIMIT).map_err(|e| e.to_string())
}

/// Runs kept in the history view. Enough to cover the stat band's 7-day window
/// many times over; the table itself is never pruned.
const AGENT_RUN_LIMIT: u32 = 200;

/// Evicts a model's weights from Ollama. The frontend calls this when a run is
/// cancelled or its view unmounts, so a dropped generation stream never leaves a
/// model resident. Best-effort — a down server (nothing to unload) is ignored.
#[tauri::command]
async fn unload_model(app: AppHandle, model: String) -> Result<(), String> {
    let _ = registry(&app)?.unload(&model).await;
    Ok(())
}

/// Removes a model from Ollama and the cache.
#[tauri::command]
async fn remove_model(app: AppHandle, id: String) -> Result<(), String> {
    ensure_server(&app).await?;
    registry(&app)?.remove(&id).await.map_err(|e| e.to_string())
}

/// Reports which installed models have a newer version upstream as
/// `(model_id, update_available)` pairs, by diffing manifest digests against
/// the Ollama registry (heavily cached, best-effort — see [`anchor_hub::updates`]).
/// Currently uninvoked: the update badge UI was pulled pending an "apply" flow.
#[tauri::command]
async fn check_updates(app: AppHandle) -> Result<Vec<(String, bool)>, String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    anchor_hub::updates::check_updates(&registry)
        .await
        .map_err(|e| e.to_string())
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

/// Live status of the Ollama server for the Settings panel.
#[derive(serde::Serialize)]
struct ServerStatus {
    /// The server answers at the configured host.
    reachable: bool,
    /// Its version string, when reachable.
    version: Option<String>,
    /// Anchor started (and owns) this server, vs one that was already running.
    managed: bool,
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
    Ok(ServerStatus { reachable, version, managed })
}

/// How many written community reviews a free install may open per week.
const REVIEW_ALLOWANCE: u32 = 3;

/// This install's anonymous id, created on first use.
///
/// A random value in a file, deliberately *not* derived from the hardware: it
/// exists so someone can update or withdraw their own submissions, and must not
/// double as a machine fingerprint. Reads 16 bytes from the system CSPRNG rather
/// than pulling in a uuid crate for one call site.
fn install_id(app: &AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let path = dir.join("install_id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let id = rand_hex(16)?;
    let _ = std::fs::create_dir_all(&dir);
    std::fs::write(&path, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

/// `n` random bytes from the system CSPRNG, hex-encoded. Used for install and
/// message ids without pulling in a uuid crate for a couple of call sites.
fn rand_hex(n: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; n];
    std::io::Read::read_exact(
        &mut std::fs::File::open("/dev/urandom").map_err(|e| e.to_string())?,
        &mut bytes,
    )
    .map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The host's benchmark match identity, derived from the cached hardware profile.
fn hw_identity(app: &AppHandle) -> Result<HwIdentity, String> {
    let profile = profiler(app)?.get().map_err(|e| e.to_string())?;
    Ok(HwIdentity::from_profile(&profile))
}

/// Runs the standard benchmark suite against a model and stores the result.
///
/// Takes `compare_lock` (shared with `compare_models` and `run_research`) so a
/// benchmark can never run alongside another RAM-heavy generation — a contended
/// run would measure the contention, not the model.
#[tauri::command]
async fn run_benchmark(
    app: AppHandle,
    model: String,
    on_event: Channel<BenchProgress>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let hw = hw_identity(&app)?;
    let id = install_id(&app)?;
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;

    let result = registry
        .run_benchmark(&model, &hw, &id, |event| {
            // Best-effort: a dropped channel (UI navigated away) shouldn't error.
            let _ = on_event.send(event);
        })
        .await;
    if let Err(e) = result {
        let _ = on_event.send(BenchProgress::Failed {
            message: e.to_string(),
        });
        return Err(e.to_string());
    }
    Ok(())
}

/// Benchmark results for a model from machines resembling this one, best match
/// first. Each row carries the tier it matched at so the UI can group them.
#[tauri::command]
async fn bench_runs_for_model(app: AppHandle, model: String) -> Result<Vec<BenchRun>, String> {
    let registry = registry(&app)?;
    let hw = hw_identity(&app)?;
    let digest = anchor_hub::ollama::digest_of(&anchor_hub::ollama_host(), &model)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{model} is not installed"))?;
    registry
        .bench_runs_for(&hw, &digest)
        .map_err(|e| e.to_string())
}

/// Opens one written review, spending a slot from the weekly allowance.
///
/// Re-opening a review already unlocked is free. Returns the allowance state so
/// the UI can show what's left without a second call.
#[tauri::command]
async fn unlock_review(app: AppHandle, run_id: String) -> Result<ReviewAllowance, String> {
    registry(&app)?
        .unlock_review(&run_id, now_ms(), REVIEW_ALLOWANCE)
        .map_err(|e| e.to_string())
}

/// The current state of the weekly review allowance.
#[tauri::command]
async fn review_allowance(app: AppHandle) -> Result<ReviewAllowance, String> {
    let used = registry(&app)?
        .reviews_used(now_ms())
        .map_err(|e| e.to_string())?;
    Ok(ReviewAllowance {
        unlocked: false,
        used,
        allowance: REVIEW_ALLOWANCE,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
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
            tray::init(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_models,
            list_catalog,
            search_models,
            recent_searches,
            download_model,
            compare_models,
            run_research,
            run_chat,
            list_conversations,
            create_conversation,
            conversation_messages,
            rename_conversation,
            delete_conversation,
            save_agent_run,
            agent_runs,
            unload_model,
            remove_model,
            get_hardware_profile,
            refresh_hardware_profile,
            get_server_status,
            check_updates,
            run_benchmark,
            bench_runs_for_model,
            unlock_review,
            review_allowance
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // On exit, make sure nothing is left resident. If we started the
            // server, killing it unloads everything. If it was already running
            // (not ours to kill), best-effort evict any models we may have loaded
            // so quitting Anchor never leaves weights in someone else's Ollama.
            if let RunEvent::Exit = event {
                let child = app.state::<ServerState>().child.lock().unwrap().take();
                match child {
                    Some(mut child) => {
                        let _ = child.kill();
                    }
                    None => unload_all_resident(app),
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
