//! The Model Hub: Anchor's unified registry of locally available models.
//!
//! It discovers what's installed by querying the local Ollama server's REST API
//! ([`ollama`]), persists that to a small SQLite cache ([`db`]) so the app still
//! works when Ollama is offline, and drives pulls/removals. This crate is free of
//! any Tauri/UI dependency so it stays testable and reusable from a future CLI.

use std::path::PathBuf;

use anchor_core::Model;
use rusqlite::Connection;

pub mod db;
pub mod ollama;

pub use ollama::PullProgress;

/// Default address of a locally running Ollama server.
pub const DEFAULT_HOST: &str = "http://localhost:11434";

/// Errors surfaced by the registry. Stringified at the Tauri boundary.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An HTTP / Ollama transport failure.
    #[error("ollama request failed: {0}")]
    Http(String),
    /// A SQLite failure.
    #[error("registry database error: {0}")]
    Db(#[from] rusqlite::Error),
    /// A JSON (de)serialisation failure.
    #[error("malformed response: {0}")]
    Json(#[from] serde_json::Error),
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
    /// parent directory and schema exist. Uses [`DEFAULT_HOST`] for Ollama.
    pub fn open(db_path: impl Into<PathBuf>) -> Result<Self> {
        Self::open_with_host(db_path, DEFAULT_HOST)
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
        db::init_schema(&registry.connect()?)?;
        Ok(registry)
    }

    /// Opens a fresh connection to the cache database.
    fn connect(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    /// Syncs from the live Ollama server: lists installed models, enriches each
    /// with `/api/show` metadata (context window + publisher, best-effort), and
    /// replaces the cache. Returns the freshly synced models.
    pub async fn sync(&self) -> Result<Vec<Model>> {
        let mut models = ollama::list_local_models(&self.host).await?;
        for model in &mut models {
            // Enrichment is best-effort: a failing `/api/show` for one model must
            // not sink the whole sync.
            if let Ok(details) = ollama::show_details(&self.host, &model.id).await {
                model.context_tokens = details.context_tokens;
                model.publisher = details.publisher;
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
    /// The cache is refreshed on the next [`sync`](Self::sync); callers typically
    /// re-list afterwards to pick up the newly installed model.
    pub async fn pull<F>(&self, id: &str, on_progress: F) -> Result<()>
    where
        F: FnMut(PullProgress) + Send,
    {
        ollama::pull(&self.host, id, on_progress).await
    }

    /// Removes a model from Ollama and drops it from the cache.
    pub async fn remove(&self, id: &str) -> Result<()> {
        ollama::delete(&self.host, id).await?;
        db::delete_one(&self.connect()?, id)?;
        Ok(())
    }
}
