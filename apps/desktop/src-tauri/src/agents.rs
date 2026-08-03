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

use anchor_hub::{AgentMemory, KbDocument};
use anchor_workflows::agents::{
    code_reviewer, code_reviewer::CodeReviewerConfig, knowledge_base,
    knowledge_base::KbIngestConfig, knowledge_base::KnowledgeBaseConfig, memory_chat,
    memory_chat::MemoryChatConfig, pdf_qa, pdf_qa::PdfQaConfig, web_researcher,
    web_researcher::WebResearcherConfig, AgentEvent,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::{ensure_server, registry, ServerState};

/// Memories returned to the management UI. Well past what any prompt injects.
const MEMORY_LIMIT: u32 = 500;

/// Where the embedding model files live. Shares the directory the semantic index
/// already populates, so the Knowledge Base never re-downloads BGE-small.
fn embed_cache_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("embeddings"))
        .unwrap_or_else(|_| std::env::temp_dir().join("anchor-embeddings"))
}

/// Answers a question from live web search, with linked sources.
#[tauri::command]
pub async fn run_web_researcher(
    app: AppHandle,
    config: WebResearcherConfig,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    web_researcher::run(&registry, &config, |event| {
        // Best-effort: a dropped channel (UI navigated away) shouldn't error.
        let _ = on_event.send(event);
    })
    .await;
    Ok(())
}

/// Answers questions about a single document held in context.
#[tauri::command]
pub async fn run_pdf_qa(
    app: AppHandle,
    config: PdfQaConfig,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    pdf_qa::run(&registry, &config, |event| {
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

/// One conversational turn that recalls and updates durable memory.
#[tauri::command]
pub async fn run_memory_chat(
    app: AppHandle,
    config: MemoryChatConfig,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    ensure_server(&app).await?;
    let registry = registry(&app)?;
    let state = app.state::<ServerState>();
    let _run = state.compare_lock.lock().await;
    memory_chat::run(&registry, &config, |event| {
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

/// An agent's remembered facts for one scope, newest first.
#[tauri::command]
pub async fn agent_memories(
    app: AppHandle,
    agent_id: String,
    scope: String,
) -> Result<Vec<AgentMemory>, String> {
    registry(&app)?
        .recall(&agent_id, &scope, MEMORY_LIMIT)
        .map_err(|e| e.to_string())
}

/// Forgets one remembered fact.
#[tauri::command]
pub async fn forget_memory(app: AppHandle, id: String) -> Result<(), String> {
    registry(&app)?.forget(&id).map_err(|e| e.to_string())
}
