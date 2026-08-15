//! The Model Hub: Anchor's unified registry of locally available models.
//!
//! It discovers what's installed by querying the local Ollama server's REST API
//! ([`ollama`]), persists that to a small SQLite cache ([`db`]) so the app still
//! works when Ollama is offline, and drives pulls/removals. This crate is free of
//! any Tauri/UI dependency so it stays testable and reusable from a future CLI.

use std::collections::HashMap;
use std::path::PathBuf;

use anchor_core::Model;
use rusqlite::Connection;

pub mod bench;
pub mod db;
pub mod gguf;
pub mod library;
pub mod ollama;
pub mod server;
pub mod status;
pub mod storage;
pub mod updates;

pub use bench::{BenchProgress, RepeatsMode, Scenario, CATALOG, SUITE_ID, SUITE_VERSION};
pub use db::{
    AgentMemory, AgentRun, Conversation, KbChunk, KbDocument, Preset, StoredMessage,
    DEFAULT_PRESET_ID,
};
pub use ollama::{ChatMessage, ChatRequest, GenerateRequest, GenerationStats, PullProgress};

use serde::Serialize;

/// Which side of a two-model comparison an event belongs to.
///
/// Mirrored on the frontend as `Slot` in `types.ts` (`"a" | "b"`).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    A,
    B,
}

/// Lifecycle phase of one model's run within a comparison.
///
/// Mirrored on the frontend as `Phase` in `types.ts`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Waiting its turn (the other model is currently running).
    Queued,
    /// Weights are loading into RAM (no token has arrived yet).
    Loading,
    /// Tokens are streaming.
    Generating,
    /// Finished; weights have been evicted.
    Done,
}

/// A single streamed event from [`Registry::compare`], carrying everything the
/// comparison UI needs: download progress, per-token deltas, the final buffered
/// response with stats, or a per-slot failure.
///
/// Mirrored on the frontend as the `CompareEvent` union in `types.ts`, keyed on
/// the `kind` tag.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompareEvent {
    /// Download progress while a not-yet-installed model is pulled.
    Pull { slot: Slot, progress: PullProgress },
    /// A lifecycle transition for the slot.
    Status { slot: Slot, phase: Phase },
    /// One streamed response delta (for liveness; the frontend may buffer these).
    Token { slot: Slot, text: String },
    /// The final, complete response and its generation stats.
    Result {
        slot: Slot,
        response: String,
        stats: GenerationStats,
    },
    /// The slot failed (pull or generation error); the other slot still runs.
    Failed { slot: Slot, message: String },
}

/// Default address of a locally running Ollama server.
pub const DEFAULT_HOST: &str = "http://localhost:11434";

/// The resolved Ollama base URL (honours `OLLAMA_HOST`, else [`DEFAULT_HOST`]).
///
/// Exposed so the Tauri shell can health-check / start the server against the
/// exact host a [`Registry`] will talk to.
pub fn ollama_host() -> String {
    host_from_env()
}

/// Resolves the Ollama host from `OLLAMA_HOST`, falling back to [`DEFAULT_HOST`].
///
/// Matches the `ollama` CLI: the value may be a full URL (`http://host:port`) or
/// a bare `host:port`, in which case `http://` is prepended. An empty/unset var
/// yields the default.
fn host_from_env() -> String {
    normalize_host(std::env::var("OLLAMA_HOST").ok().as_deref())
}

/// Normalises a raw `OLLAMA_HOST` value into a base URL (pure; see
/// [`host_from_env`]). `None`/empty → [`DEFAULT_HOST`]; a bare `host:port` gets
/// an `http://` scheme; an already-qualified URL is passed through.
fn normalize_host(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(v) if !v.is_empty() => {
            if v.contains("://") {
                v.to_string()
            } else {
                format!("http://{v}")
            }
        }
        _ => DEFAULT_HOST.to_string(),
    }
}

/// Whether a base URL resolves to this machine.
///
/// `OLLAMA_HOST` is honoured verbatim, so it can point at another machine —
/// which sends every prompt and response off this Mac, contradicting the promise
/// the rest of Anchor makes. False here drives an explicit warning rather than
/// silent remote inference.
///
/// `0.0.0.0` counts: it is a bind address rather than a destination, and a
/// server listening on it is still the local one.
pub fn is_local_host(host: &str) -> bool {
    let after_scheme = host.split_once("://").map_or(host, |(_, rest)| rest);
    let authority = after_scheme.split('/').next().unwrap_or("");
    // A bracketed IPv6 literal ends at `]`; everything else drops a trailing port.
    let h = match authority.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => authority.rsplit_once(':').map_or(authority, |(h, _)| h),
    };
    matches!(h, "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" | "::")
}

/// `n` random bytes from the system CSPRNG, hex-encoded. Used for install,
/// conversation and message ids without pulling in a uuid crate.
pub fn rand_hex(n: usize) -> std::io::Result<String> {
    let mut bytes = vec![0u8; n];
    std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// This install's anonymous id, created in `dir` on first use.
///
/// A random value in a file, deliberately *not* derived from the hardware: it
/// exists so someone can update or withdraw their own benchmark submissions, and
/// must not double as a machine fingerprint. Lives here rather than in the Tauri
/// shell so the CLI's runs are attributed to the same install as the app's.
pub fn install_id(dir: &std::path::Path) -> std::io::Result<String> {
    let path = dir.join("install_id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let id = rand_hex(16)?;
    let _ = std::fs::create_dir_all(dir);
    std::fs::write(&path, &id)?;
    Ok(id)
}

/// Errors surfaced by the registry. Stringified at the Tauri boundary.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An HTTP / Ollama transport failure.
    #[error("ollama request failed: {0}")]
    Http(String),
    /// An error the Ollama server reported in a response body (HTTP 200), e.g. a
    /// `{"error": "..."}` frame mid-pull for an unknown model.
    #[error("ollama error: {0}")]
    Ollama(String),
    /// A SQLite failure.
    #[error("registry database error: {0}")]
    Db(#[from] rusqlite::Error),
    /// A JSON (de)serialisation failure.
    #[error("malformed response: {0}")]
    Json(#[from] serde_json::Error),
    /// The user cancelled a long-running operation. Not a failure — callers
    /// should treat it as a normal terminal state, not surface it as an error.
    #[error("cancelled")]
    Cancelled,
}

/// Convenience alias for registry results.
pub type Result<T> = std::result::Result<T, Error>;

/// The unified registry of locally known models.
///
/// Holds only the cache path and Ollama host — never a live DB connection — so a
/// fresh, short-lived [`Connection`] is opened per operation. That keeps the
/// async methods `Send` (a `rusqlite::Connection` must not be held across an
/// `.await`) and sidesteps any shared-connection locking.
#[derive(Debug, Clone)]
pub struct Registry {
    db_path: PathBuf,
    host: String,
}

impl Registry {
    /// Opens (creating if needed) the registry cache at `db_path`, ensuring the
    /// parent directory and schema exist.
    ///
    /// The Ollama host honours the `OLLAMA_HOST` environment variable (the same
    /// knob the `ollama` CLI uses) so a server bound to a non-default address or
    /// port is still reachable; it falls back to [`DEFAULT_HOST`] when unset. A
    /// bare `host:port` (no scheme) is normalised to an `http://` URL.
    pub fn open(db_path: impl Into<PathBuf>) -> Result<Self> {
        Self::open_with_host(db_path, host_from_env())
    }

    /// Like [`open`](Self::open) but with an explicit Ollama host (e.g. tests).
    pub fn open_with_host(db_path: impl Into<PathBuf>, host: impl Into<String>) -> Result<Self> {
        let db_path = db_path.into();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                Error::Db(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                    Some(e.to_string()),
                ))
            })?;
        }
        let registry = Self {
            db_path,
            host: host.into(),
        };
        db::migrate(&mut registry.connect()?)?;
        Ok(registry)
    }

    /// Opens a fresh connection to the cache database.
    fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path)?;
        // Waits out a concurrent writer (e.g. a sync racing the tray poll)
        // instead of failing immediately with SQLITE_BUSY. Readers never block
        // here — measured clean at 4 readers against an 8 s write — so this is
        // purely writer-vs-writer, the realistic case being a `replace_library`
        // overlapping a chat turn's `append_message`.
        //
        // ponytail: past the timeout the loser still fails hard with "database
        // is locked". WAL does *not* help — it gives writers no concurrency, and
        // both journal modes measured identical. Retrying the loser is the real
        // fix; a longer wait covers every write this app actually issues, all of
        // which are milliseconds.
        conn.busy_timeout(std::time::Duration::from_secs(30))?;
        Ok(conn)
    }

    /// Syncs from the live Ollama server: lists installed models, enriches each
    /// with `/api/show` metadata (context window, publisher, and the
    /// architecture fields behind KV sizing — all best-effort), and replaces the
    /// cache. Returns the freshly synced models.
    ///
    /// Enrichment is skipped for models already cached at the same
    /// `modified_at`. GGUF metadata is immutable for a given blob, and Ollama
    /// moves `modified_at` when a tag is re-pulled — the only way the bytes
    /// behind a stable id can change. Without this the UI paid one `/api/show`
    /// per installed model on every mount, every pull and every manual reload.
    pub async fn sync(&self) -> Result<Vec<Model>> {
        let mut models = ollama::list_local_models(&self.host).await?;

        // A cache read failure is not fatal: fall back to enriching everything.
        let cached: HashMap<String, Model> = self
            .cached_models()
            .unwrap_or_default()
            .into_iter()
            .map(|m| (m.id.clone(), m))
            .collect();
        let reusable = |m: &Model| -> Option<&Model> {
            let hit = cached.get(&m.id)?;
            // Only skip the fetch when the answer is already complete: a cached
            // row whose own enrichment failed must be retried, not carried.
            let fresh = hit.modified_at == m.modified_at && m.modified_at.is_some();
            (fresh && hit.arch.is_some()).then_some(hit)
        };

        // Enrichment is best-effort and concurrent: a failing `/api/show` for one
        // model must neither sink nor serialize the whole sync.
        let details = futures_util::future::join_all(models.iter().map(|m| {
            let stale = reusable(m).is_none();
            async move {
                match stale {
                    true => Some(ollama::show_details(&self.host, &m.id).await),
                    false => None,
                }
            }
        }))
        .await;

        for (model, detail) in models.iter_mut().zip(details) {
            match detail {
                Some(Ok(d)) => {
                    model.context_tokens = d.context_tokens;
                    model.publisher = d.publisher;
                    model.arch = (!d.arch.is_empty()).then_some(d.arch);
                }
                Some(Err(_)) => {}
                // Unchanged since the last sync — carry the cached enrichment
                // forward, since `replace_all` rewrites the whole table.
                None => {
                    let hit = &cached[&model.id];
                    model.context_tokens = hit.context_tokens;
                    model.publisher = hit.publisher.clone();
                    model.arch = hit.arch.clone();
                }
            }
        }
        // No `.await` is held across this connection, so it stays `Send`-safe.
        let mut conn = self.connect()?;
        db::replace_all(&mut conn, &models)?;
        Ok(models)
    }

    /// Returns the last-synced models from the cache (works while offline).
    pub fn cached_models(&self) -> Result<Vec<Model>> {
        db::read_all(&self.connect()?)
    }

    /// Pulls a model via Ollama, forwarding each progress event to `on_progress`.
    ///
    /// Setting `cancel` aborts the pull and returns [`Error::Cancelled`] — see
    /// [`ollama::pull`]. The cache is refreshed on the next [`sync`](Self::sync);
    /// callers typically re-list afterwards to pick up the newly installed model.
    pub async fn pull<F>(
        &self,
        id: &str,
        cancel: &std::sync::atomic::AtomicBool,
        on_progress: F,
    ) -> Result<()>
    where
        F: FnMut(PullProgress) + Send,
    {
        ollama::pull(&self.host, id, cancel, on_progress).await
    }

    /// Removes a model from Ollama and drops it from the cache.
    pub async fn remove(&self, id: &str) -> Result<()> {
        ollama::delete(&self.host, id).await?;
        db::delete_one(&self.connect()?, id)?;
        Ok(())
    }

    /// Runs a streaming generation, forwarding each token delta to `on_token` and
    /// returning the full text plus final [`GenerationStats`].
    pub async fn generate<F>(
        &self,
        req: &GenerateRequest,
        on_token: F,
    ) -> Result<(String, GenerationStats)>
    where
        F: FnMut(&str) + Send,
    {
        ollama::generate(&self.host, req, on_token).await
    }

    /// Runs a streaming multi-turn chat, forwarding each token delta to
    /// `on_token` and returning the full assistant text plus final stats.
    pub async fn chat<F>(
        &self,
        req: &ChatRequest,
        cancel: &std::sync::atomic::AtomicBool,
        on_token: F,
    ) -> Result<(String, String, GenerationStats)>
    where
        F: FnMut(bool, &str) + Send,
    {
        ollama::chat(&self.host, req, cancel, on_token).await
    }

    // --- Chat persistence: thin wrappers over `db`, one connection each. ---

    /// Lists conversations, most-recently-updated first.
    pub fn list_conversations(&self) -> Result<Vec<Conversation>> {
        db::list_conversations(&self.connect()?)
    }

    /// Creates a conversation with the given id/title/model at `now_ms`.
    ///
    /// `preset_id` of `None` leaves it on the default preset.
    pub fn create_conversation(
        &self,
        id: &str,
        title: &str,
        model: &str,
        preset_id: Option<String>,
        now_ms: i64,
    ) -> Result<Conversation> {
        let conv = Conversation {
            id: id.to_string(),
            title: title.to_string(),
            model: model.to_string(),
            preset_id,
            created_ms: now_ms,
            updated_ms: now_ms,
        };
        db::insert_conversation(&self.connect()?, &conv)?;
        Ok(conv)
    }

    /// Reads a conversation's messages in chronological order.
    pub fn messages_for(&self, conversation_id: &str) -> Result<Vec<StoredMessage>> {
        db::messages_for(&self.connect()?, conversation_id)
    }

    /// The model a conversation currently uses (`None` if it doesn't exist).
    pub fn conversation_model(&self, id: &str) -> Result<Option<String>> {
        db::conversation_model(&self.connect()?, id)
    }

    /// Appends one message and bumps the conversation's `updated_ms`.
    pub fn append_message(&self, conversation_id: &str, m: &StoredMessage) -> Result<()> {
        db::append_message(&self.connect()?, conversation_id, m)
    }

    /// Renames a conversation.
    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<()> {
        db::rename_conversation(&self.connect()?, id, title)
    }

    /// Points a conversation at a different model.
    pub fn set_conversation_model(&self, id: &str, model: &str) -> Result<()> {
        db::set_conversation_model(&self.connect()?, id, model)
    }

    /// Deletes a conversation and all of its messages.
    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        db::delete_conversation(&self.connect()?, id)
    }

    // --- The public Ollama library: everything installable, not just installed. ---

    /// The full Ollama library listing, served from cache when it's younger than
    /// `max_age_ms` and re-scraped otherwise.
    ///
    /// Three rules, in order, because the source is a website we don't control:
    /// 1. A fresh cache is used as-is — browsing never waits on the network.
    /// 2. A fetch that yields **zero** models is treated as a failure, not as an
    ///    empty library. That's what a redesign looks like, and replacing a good
    ///    catalog with nothing is the one outcome worse than stale data.
    /// 3. Any failure falls back to the cache however old it is; only an empty
    ///    cache surfaces the error.
    pub async fn library(&self, max_age_ms: i64, now_ms: i64) -> Result<Vec<library::LibraryEntry>> {
        let (cached, fetched_ms) = db::read_library(&self.connect()?)?;
        if !cached.is_empty() && fetched_ms.is_some_and(|at| now_ms - at < max_age_ms) {
            return Ok(cached);
        }

        match library::fetch_library().await {
            Ok(fresh) if !fresh.is_empty() => {
                db::replace_library(&mut self.connect()?, &fresh, now_ms)?;
                Ok(fresh)
            }
            // Parsed to nothing, or the fetch failed: keep what we had.
            Ok(_) if !cached.is_empty() => Ok(cached),
            Ok(_) => Err(Error::Http(
                "couldn't read the Ollama library listing (the page format may have changed)".into(),
            )),
            Err(_) if !cached.is_empty() => Ok(cached),
            Err(e) => Err(e),
        }
    }

    /// Architecture metadata for a tag that may not be installed, so browsing
    /// can size its KV cache exactly instead of guessing from parameter count.
    ///
    /// Reads the model's GGUF header from the registry — about a megabyte, never
    /// the weights — and caches the answer against the manifest `digest` the
    /// listing already carries. A digest is immutable, so a hit is good forever;
    /// a tag re-pointed at a new build simply misses and re-reads.
    ///
    /// An unreadable header is cached as `None` rather than left absent, so a
    /// model Anchor cannot parse is not re-fetched on every visit. `Ok(None)`
    /// therefore means "looked, and there is no answer", not "didn't look".
    pub async fn tag_arch(
        &self,
        tag: &str,
        digest: &str,
        now_ms: i64,
    ) -> Result<Option<anchor_core::ArchMeta>> {
        if let Some(hit) = db::read_tag_arch(&self.connect()?, tag, digest)? {
            return Ok(hit);
        }
        // A failed *fetch* is transient (offline, rate limit) and must not be
        // cached — only a successful read that yielded nothing usable is.
        let info = gguf::fetch_model_info(tag).await?;
        let arch = ollama::details_from_info(&info).arch;
        let arch = (!arch.is_empty()).then_some(arch);
        db::write_tag_arch(&self.connect()?, tag, digest, arch.as_ref(), now_ms)?;
        Ok(arch)
    }

    /// Every pullable tag of one library model. Not cached — it's only fetched
    /// when a row is expanded, and a stale tag list is worse than a short wait.
    pub async fn library_tags(&self, name: &str) -> Result<Vec<library::LibraryTag>> {
        library::fetch_tags(name).await
    }

    // --- Presets: named generation settings, resolved per conversation. ---

    /// Lists presets, default first.
    pub fn presets(&self) -> Result<Vec<Preset>> {
        db::list_presets(&self.connect()?)
    }

    /// Creates or updates one preset.
    pub fn save_preset(&self, preset: &Preset) -> Result<()> {
        db::upsert_preset(&self.connect()?, preset)
    }

    /// Deletes a preset (the default is protected) and detaches its conversations.
    pub fn delete_preset(&self, id: &str) -> Result<()> {
        db::delete_preset(&self.connect()?, id)
    }

    /// Points a conversation at a preset; `None` returns it to the default.
    pub fn set_conversation_preset(&self, id: &str, preset_id: Option<&str>) -> Result<()> {
        db::set_conversation_preset(&self.connect()?, id, preset_id)
    }

    /// The preset a conversation runs under (its own, else the default).
    pub fn preset_for_conversation(&self, conversation_id: &str) -> Result<Option<Preset>> {
        db::preset_for_conversation(&self.connect()?, conversation_id)
    }

    /// Stores a finished agent run.
    pub fn save_agent_run(&self, run: &AgentRun) -> Result<()> {
        db::insert_agent_run(&self.connect()?, run)
    }

    /// Reads agent run history, newest first.
    pub fn agent_runs(&self, limit: u32) -> Result<Vec<AgentRun>> {
        db::list_agent_runs(&self.connect()?, limit)
    }

    // --- Agent memory: facts an agent keeps across sessions. ---

    /// Stores a remembered fact.
    pub fn remember(&self, memory: &AgentMemory) -> Result<()> {
        db::insert_memory(&self.connect()?, memory)
    }

    /// Reads an agent's memories for one scope, newest first.
    pub fn recall(&self, agent_id: &str, scope: &str, limit: u32) -> Result<Vec<AgentMemory>> {
        db::list_memories(&self.connect()?, agent_id, scope, limit)
    }

    /// Forgets one fact.
    pub fn forget(&self, id: &str) -> Result<()> {
        db::delete_memory(&self.connect()?, id)
    }

    // --- Knowledge base: ingested documents and their embedded chunks. ---

    /// Registers (or re-registers) an ingested document.
    pub fn add_kb_document(&self, doc: &KbDocument) -> Result<()> {
        db::insert_kb_document(&self.connect()?, doc)
    }

    /// Lists ingested documents, newest first.
    pub fn kb_documents(&self) -> Result<Vec<KbDocument>> {
        db::list_kb_documents(&self.connect()?)
    }

    /// Drops a document and everything indexed from it.
    pub fn forget_kb_document(&self, id: &str) -> Result<()> {
        db::delete_kb_document(&self.connect()?, id)
    }

    /// Replaces a document's chunks with a freshly embedded set.
    pub fn replace_kb_chunks(&self, doc_id: &str, chunks: &[KbChunk]) -> Result<()> {
        db::replace_kb_chunks(&mut self.connect()?, doc_id, chunks)
    }

    /// Reads every stored chunk, for a similarity scan.
    pub fn kb_chunks(&self) -> Result<Vec<KbChunk>> {
        db::list_kb_chunks(&self.connect()?)
    }

    /// Evicts a model's weights from Ollama with a zero-length, `keep_alive: 0`
    /// generate. Used to guarantee nothing stays resident after a run, on cancel,
    /// or on app exit. Best-effort at the call site (a down server just errors).
    pub async fn unload(&self, model: &str) -> Result<()> {
        let req = GenerateRequest {
            model: model.to_string(),
            prompt: String::new(),
            system: None,
            num_predict: Some(0),
            keep_alive_secs: 0,
            think: None,
            num_ctx: None,
            temperature: None,
        };
        self.generate(&req, |_| {}).await.map(|_| ())
    }

    /// Whether a model is currently installed in Ollama. Queries the live server
    /// (`/api/tags`) rather than the cache, so a model pulled this session — but
    /// not yet re-synced — is still detected.
    pub async fn is_installed(&self, id: &str) -> Result<bool> {
        let models = ollama::list_local_models(&self.host).await?;
        Ok(models.iter().any(|m| m.id == id))
    }

    /// Compares two models against one prompt, emitting [`CompareEvent`]s as it
    /// goes. The whole reason this is **sequential** (slot A fully, then slot B)
    /// is the RAM constraint: each model uses `keep_alive: 0`, so its weights are
    /// evicted the instant it finishes, freeing memory before the next loads.
    ///
    /// A missing model is pulled first (streaming [`CompareEvent::Pull`]). A pull
    /// or generation failure is reported as [`CompareEvent::Failed`] for that slot
    /// only; the other slot still runs.
    pub async fn compare<F>(&self, model_a: &str, model_b: &str, prompt: &str, mut on_event: F)
    where
        F: FnMut(CompareEvent) + Send,
    {
        // Seed both panes as queued so the UI can render the side-by-side layout
        // immediately, then drive each slot through its lifecycle in turn.
        on_event(CompareEvent::Status {
            slot: Slot::A,
            phase: Phase::Queued,
        });
        on_event(CompareEvent::Status {
            slot: Slot::B,
            phase: Phase::Queued,
        });
        for (slot, id) in [(Slot::A, model_a), (Slot::B, model_b)] {
            self.compare_one(slot, id, prompt, &mut on_event).await;
        }
    }

    /// Runs one slot of a [`compare`](Self::compare): ensure installed (pulling if
    /// needed), then generate, emitting status/token/result events along the way.
    async fn compare_one<F>(&self, slot: Slot, id: &str, prompt: &str, on_event: &mut F)
    where
        F: FnMut(CompareEvent) + Send,
    {
        match self.is_installed(id).await {
            Ok(true) => {}
            Ok(false) => {
                // Compare has no cancel affordance of its own, so this pull is
                // never interrupted — the flag is a permanently-false constant.
                let never = std::sync::atomic::AtomicBool::new(false);
                let pulled = self
                    .pull(id, &never, |progress| {
                        on_event(CompareEvent::Pull { slot, progress })
                    })
                    .await;
                if let Err(e) = pulled {
                    on_event(CompareEvent::Failed {
                        slot,
                        message: e.to_string(),
                    });
                    return;
                }
            }
            Err(e) => {
                on_event(CompareEvent::Failed {
                    slot,
                    message: e.to_string(),
                });
                return;
            }
        }

        // Weights load on the first request; the UI shows "loading" until the
        // first token arrives, at which point we flip to "generating".
        on_event(CompareEvent::Status {
            slot,
            phase: Phase::Loading,
        });
        let req = GenerateRequest::for_comparison(id, prompt);
        let mut started = false;
        let result = self
            .generate(&req, |tok| {
                if !started {
                    started = true;
                    on_event(CompareEvent::Status {
                        slot,
                        phase: Phase::Generating,
                    });
                }
                on_event(CompareEvent::Token {
                    slot,
                    text: tok.to_string(),
                });
            })
            .await;

        match result {
            Ok((response, stats)) => {
                on_event(CompareEvent::Result {
                    slot,
                    response,
                    stats,
                });
                on_event(CompareEvent::Status {
                    slot,
                    phase: Phase::Done,
                });
            }
            Err(e) => on_event(CompareEvent::Failed {
                slot,
                message: e.to_string(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_host_handles_unset_bare_and_full() {
        assert_eq!(normalize_host(None), DEFAULT_HOST);
        assert_eq!(normalize_host(Some("")), DEFAULT_HOST);
        assert_eq!(normalize_host(Some("  ")), DEFAULT_HOST);
        // Bare host:port gets an http scheme.
        assert_eq!(normalize_host(Some("127.0.0.1:11434")), "http://127.0.0.1:11434");
        assert_eq!(normalize_host(Some("ollama.local:1234")), "http://ollama.local:1234");
        // Already-qualified URLs pass through (incl. https / trimmed whitespace).
        assert_eq!(normalize_host(Some(" http://host:9 ")), "http://host:9");
        assert_eq!(normalize_host(Some("https://remote:443")), "https://remote:443");
    }

    #[test]
    fn only_this_machine_counts_as_a_local_host() {
        assert!(is_local_host("http://127.0.0.1:11434"));
        assert!(is_local_host("http://localhost:11434"));
        assert!(is_local_host("http://[::1]:11434"));
        // A bind-all listener is still the local server.
        assert!(is_local_host("http://0.0.0.0:11434"));
        // Anything naming another machine is not, however it is spelled.
        assert!(!is_local_host("http://192.168.1.40:11434"));
        assert!(!is_local_host("https://ollama.example.com"));
        assert!(!is_local_host("http://127.0.0.1.evil.test:11434"));
    }

    /// A second sync must not re-fetch `/api/show` for unchanged models.
    ///
    /// Proved without mocking the HTTP layer: stamp a sentinel into the cached
    /// `publisher`, then sync again. `/api/show` would overwrite it with the
    /// model's real publisher, so the sentinel surviving means the fetch was
    /// genuinely skipped and the cached enrichment carried forward instead.
    ///
    ///   cargo test -p anchor-hub -- --ignored --nocapture reuses_cached
    #[tokio::test]
    #[ignore = "needs a live Ollama server with at least one model installed"]
    async fn sync_reuses_cached_arch_for_unchanged_models() {
        let dir = std::env::temp_dir().join(format!("anchor-sync-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("registry.db");
        let registry = Registry::open(&db).unwrap();

        let first = registry.sync().await.expect("first sync");
        let target = first
            .iter()
            .find(|m| m.arch.is_some() && m.modified_at.is_some())
            .expect("at least one enriched model installed")
            .clone();

        // Stamp the sentinel directly into the cache.
        let mut cached = registry.cached_models().unwrap();
        for m in cached.iter_mut() {
            m.publisher = Some("SENTINEL".into());
        }
        let mut conn = Connection::open(&db).unwrap();
        db::replace_all(&mut conn, &cached).unwrap();
        drop(conn);

        let second = registry.sync().await.expect("second sync");
        let after = second.iter().find(|m| m.id == target.id).unwrap();

        assert_eq!(
            after.publisher.as_deref(),
            Some("SENTINEL"),
            "{}: /api/show was re-fetched for an unchanged model",
            target.id
        );
        assert_eq!(after.arch, target.arch, "cached arch must survive the reuse path");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `tag_arch` reads a browsable model's header once, then serves the cache —
    /// and re-reads when the tag is re-pointed at a different build.
    ///
    /// The cache is proved the same way as the sync path: overwrite the stored
    /// value with a sentinel and confirm the next call returns *that*, which it
    /// only can if it never went back to the network.
    ///
    ///   cargo test -p anchor-hub -- --ignored --nocapture tag_arch_is_cached
    #[tokio::test]
    #[ignore = "fetches a GGUF header from registry.ollama.ai"]
    async fn tag_arch_is_cached_per_digest() {
        let dir = std::env::temp_dir().join(format!("anchor-tagarch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let registry = Registry::open(dir.join("registry.db")).unwrap();

        // gemma2:2b is also installed here, so the figures are cross-checkable
        // against /api/show — see catalog_arch_matches_live_metadata.
        let first = registry
            .tag_arch("gemma2:2b", "digest-one", 1_000)
            .await
            .expect("header read")
            .expect("gemma2 has usable metadata");
        assert_eq!(first.block_count, Some(26));
        assert_eq!(first.head_count_kv, Some(4));
        assert_eq!(first.sliding_window, Some(4096));

        let sentinel = anchor_core::ArchMeta { block_count: Some(999), ..first.clone() };
        db::write_tag_arch(
            &Connection::open(dir.join("registry.db")).unwrap(),
            "gemma2:2b",
            "digest-one",
            Some(&sentinel),
            1_000,
        )
        .unwrap();

        let cached = registry.tag_arch("gemma2:2b", "digest-one", 2_000).await.unwrap();
        assert_eq!(
            cached.and_then(|a| a.block_count),
            Some(999),
            "second call went back to the network instead of the cache"
        );

        // A re-pointed tag must not serve the old build's architecture.
        let repointed = registry.tag_arch("gemma2:2b", "digest-two", 3_000).await.unwrap();
        assert_eq!(
            repointed.and_then(|a| a.block_count),
            Some(26),
            "a changed digest must invalidate the cached header"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
