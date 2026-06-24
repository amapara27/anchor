//! Persistent log of recent model-search queries.
//!
//! Keeps the last [`MAX_RECORDS`] queries a user has run, newest-first, in a
//! human-readable JSON file under the app data dir. This is *user state* (unlike
//! the bundled catalog), so it lives on disk, not in the binary. Recording is
//! best-effort: a search must never fail because history couldn't be written.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::Result;

/// How many of the most recent queries to retain. Older entries are dropped.
const MAX_RECORDS: usize = 20;

/// One recorded search: the query text, when it ran, and which model ids it
/// returned (top-k). Storing ids (not full profiles) keeps the file compact and
/// readable; the catalog is the source of truth for everything else.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryRecord {
    pub query: String,
    /// Unix epoch milliseconds when the query was recorded.
    pub timestamp_ms: u64,
    /// Model ids returned for this query, most relevant first.
    pub results: Vec<String>,
}

/// A rolling, on-disk history of the last [`MAX_RECORDS`] search queries.
pub struct QueryHistory {
    path: PathBuf,
}

impl QueryHistory {
    /// Point at the backing JSON file. Does not touch disk until used.
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Read the stored records, newest-first. A missing or unreadable/corrupt
    /// file yields an empty history rather than an error — history is an aid,
    /// never a hard dependency.
    pub fn load(&self) -> Vec<QueryRecord> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Record a query and the ids it returned, prepending it as the newest entry
    /// and trimming the log back to [`MAX_RECORDS`]. Writes the whole file back
    /// as pretty JSON.
    pub fn record(&self, query: &str, result_ids: &[String]) -> Result<()> {
        let mut records = self.load();
        records.insert(
            0,
            QueryRecord {
                query: query.to_string(),
                timestamp_ms: now_ms(),
                results: result_ids.to_vec(),
            },
        );
        records.truncate(MAX_RECORDS);

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&records)?;
        std::fs::write(&self.path, json)?;
        Ok(())
    }
}

/// Current time in Unix epoch milliseconds. Clamps a pre-epoch clock to 0.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
