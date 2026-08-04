//! Tauri commands for the agents in `anchor_workflows::agents`.
//!
//! Every command here is a thin wrapper: ensure the server is up, take
//! `compare_lock` so a RAM-heavy generation never overlaps compare/chat/
//! benchmark, and forward streamed events best-effort. All domain logic lives in
//! `anchor-workflows`; all persistence lives in `anchor-hub`.
//!
//! These are written once, up front, for every agent — including ones still
//! stubbed — because the wrapper's shape doesn't change as an agent's internals
//! get built. That keeps parallel agent work out of this file entirely.

use anchor_hub::KbDocument;
use anchor_workflows::agents::{
    batch_processor, batch_processor::BatchProcessorConfig, code_reviewer,
    code_reviewer::CodeReviewerConfig, knowledge_base, knowledge_base::KbIngestConfig,
    knowledge_base::KnowledgeBaseConfig, AgentEvent,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::{ensure_server, registry, ServerState};

/// Where the embedding model files live. Shares the directory the semantic index
/// already populates, so the Knowledge Base never re-downloads BGE-small.
fn embed_cache_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("embeddings"))
        .unwrap_or_else(|_| std::env::temp_dir().join("anchor-embeddings"))
}

/// Applies one extraction instruction across many files, a row per file.
#[tauri::command]
pub async fn run_batch_processor(
    app: AppHandle,
    config: BatchProcessorConfig,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    batch_processor::run(&registry, &config, |event| {
        // Best-effort: a dropped channel (UI navigated away) shouldn't error.
        let _ = on_event.send(event);
    })
    .await;
    Ok(())
}

/// Reviews a source file or a pasted diff.
#[tauri::command]
pub async fn run_code_reviewer(
    app: AppHandle,
    config: CodeReviewerConfig,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    code_reviewer::run(&registry, &config, |event| {
        let _ = on_event.send(event);
    })
    .await;
    Ok(())
}

/// Answers a question from the ingested knowledge base.
#[tauri::command]
pub async fn run_knowledge_base(
    app: AppHandle,
    config: KnowledgeBaseConfig,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let cache_dir = embed_cache_dir(&app);
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    knowledge_base::run(&registry, &config, cache_dir, |event| {
        let _ = on_event.send(event);
    })
    .await;
    Ok(())
}

/// Adds one document to the knowledge base, streaming ingest progress.
///
/// Takes the same lock as the generating agents: embedding hundreds of chunks is
/// CPU-heavy, and racing it against a running model helps nobody.
#[tauri::command]
pub async fn kb_ingest(
    app: AppHandle,
    config: KbIngestConfig,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    let registry = registry(&app)?;
    let cache_dir = embed_cache_dir(&app);
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    knowledge_base::ingest(&registry, &config, cache_dir, |event| {
        let _ = on_event.send(event);
    })
    .await;
    Ok(())
}

/// Documents currently in the knowledge base, newest first.
#[tauri::command]
pub async fn kb_documents(app: AppHandle) -> Result<Vec<KbDocument>, String> {
    registry(&app)?.kb_documents().map_err(|e| e.to_string())
}

/// Drops a document and everything indexed from it.
#[tauri::command]
pub async fn kb_forget_document(app: AppHandle, id: String) -> Result<(), String> {
    registry(&app)?
        .forget_kb_document(&id)
        .map_err(|e| e.to_string())
}
