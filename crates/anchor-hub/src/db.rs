//! SQLite persistence for the registry.
//!
//! The DB is a *cache* of what Ollama reports, so the app can still show the last
//! known model list when the Ollama server is offline. All functions take a
//! borrowed [`Connection`] so the [`Registry`](crate::Registry) can open a fresh,
//! short-lived connection per call (keeping its async methods `Send`).

use anchor_core::{ArchMeta, BenchRun, BenchSource, HwIdentity, MatchQuality, Model, ModelStatus};
use rusqlite::Connection;

use crate::Result;

/// The schema version this build expects. Bump alongside a new `V*` constant.
const SCHEMA_VERSION: i64 = 3;

/// Version 1 of the schema.
///
/// Two rules keep the migration runner honest:
/// 1. **Never edit a shipped `V*` string.** Databases already at that version
///    will not re-run it, so an edit silently produces two different schemas.
///    Add `V2` instead.
/// 2. **New columns must be nullable or defaulted.** `ALTER TABLE ADD COLUMN` is
///    the only cheap alter SQLite offers; anything else is a hand-written table
///    rebuild.
///
/// `models` is restated here (with `IF NOT EXISTS`) so pre-migration databases —
/// which sit at `user_version = 0` with the table already present — converge on
/// the same schema as a fresh install without a special case.
const V1: &str = "
    CREATE TABLE IF NOT EXISTS models (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        family         TEXT NOT NULL,
        size_bytes     INTEGER,
        status         TEXT NOT NULL,
        parameter_size TEXT,
        quantization   TEXT,
        context_tokens INTEGER,
        modified_at    TEXT,
        publisher      TEXT
    );
    CREATE TABLE IF NOT EXISTS bench_runs (
        id                 TEXT NOT NULL PRIMARY KEY,

        hw_key             TEXT NOT NULL,
        chip_key           TEXT NOT NULL,
        chip               TEXT NOT NULL,
        cpu_cores          INTEGER,
        gpu_cores          INTEGER,
        memory_gb          INTEGER,
        os_version         TEXT,

        model_name         TEXT NOT NULL,
        model_digest       TEXT NOT NULL,
        quant              TEXT,
        num_ctx            INTEGER NOT NULL,
        kv_cache_type      TEXT NOT NULL,
        flash_attn         BOOLEAN NOT NULL,
        ollama_version     TEXT,
        suite_id           TEXT NOT NULL,
        suite_version      INTEGER NOT NULL,

        prefill_tps_median REAL,
        decode_tps_median  REAL,
        load_ms            INTEGER,
        peak_rss_bytes     BIGINT,
        repeats            INTEGER NOT NULL,

        install_id         TEXT NOT NULL,
        rating             INTEGER CHECK (rating BETWEEN 1 AND 5),
        review             TEXT,
        visible            BOOLEAN NOT NULL DEFAULT TRUE,
        created_at         BIGINT NOT NULL,
        updated_at         BIGINT NOT NULL,

        source             TEXT NOT NULL DEFAULT 'local'
                           CHECK (source IN ('local','community')),
        synced_at          BIGINT
    );
    CREATE INDEX IF NOT EXISTS bench_runs_exact
        ON bench_runs (hw_key, model_digest);
    CREATE INDEX IF NOT EXISTS bench_runs_family
        ON bench_runs (chip_key, model_digest, memory_gb);
    CREATE TABLE IF NOT EXISTS review_views (
        run_id    TEXT NOT NULL PRIMARY KEY,
        viewed_at BIGINT NOT NULL
    );
    -- `arch` is added by ALTER rather than declared above so that a fresh
    -- install and a pre-runner database (which already has `models` without it)
    -- both reach the same schema through the same statement.
    ALTER TABLE models ADD COLUMN arch TEXT;
";

/// Version 2: chat persistence — conversations and their messages.
///
/// `ON DELETE CASCADE` needs `PRAGMA foreign_keys=ON` at the connection level;
/// the cascade is also enforced by hand in [`delete_conversation`] so a
/// connection without the pragma still can't orphan messages.
const V2: &str = "
    CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        model      TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        stats_json      TEXT,
        created_ms      INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS messages_by_conversation
        ON messages (conversation_id, created_ms);
";

/// Adds an assistant turn's reasoning (from a thinking model), shown collapsed
/// in the UI. Nullable — user turns and non-thinking replies leave it `NULL`.
const V3: &str = "ALTER TABLE messages ADD COLUMN thinking TEXT;";

/// Brings the database up to [`SCHEMA_VERSION`]. Idempotent.
///
/// Uses SQLite's built-in `user_version` pragma rather than a migrations table:
/// no extra table, no extra rows, no dependency, and SQLite maintains it for us.
pub fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    let tx = conn.transaction()?;
    if version < 1 {
        tx.execute_batch(V1)?;
    }
    if version < 2 {
        tx.execute_batch(V2)?;
    }
    if version < 3 {
        tx.execute_batch(V3)?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}

/// Replaces the entire cached model set in one transaction.
///
/// Wholesale replace (rather than upsert) keeps the cache an exact mirror of
/// Ollama: models removed upstream vanish here too.
pub fn replace_all(conn: &mut Connection, models: &[Model]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM models", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO models
                (id, name, family, size_bytes, status, parameter_size, quantization, context_tokens, modified_at, publisher, arch)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for m in models {
            stmt.execute(rusqlite::params![
                m.id,
                m.name,
                m.family,
                m.size_bytes,
                status_to_str(m.status),
                m.parameter_size,
                m.quantization,
                m.context_tokens,
                m.modified_at,
                m.publisher,
                arch_to_json(m.arch.as_ref()),
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Reads every cached model.
pub fn read_all(conn: &Connection) -> Result<Vec<Model>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, family, size_bytes, status, parameter_size, quantization, context_tokens, modified_at, publisher, arch
         FROM models ORDER BY name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Model {
            id: row.get(0)?,
            name: row.get(1)?,
            family: row.get(2)?,
            size_bytes: row.get(3)?,
            status: status_from_str(&row.get::<_, String>(4)?),
            parameter_size: row.get(5)?,
            quantization: row.get(6)?,
            context_tokens: row.get(7)?,
            modified_at: row.get(8)?,
            publisher: row.get(9)?,
            arch: arch_from_json(row.get::<_, Option<String>>(10)?.as_deref()),
        })
    })?;
    let mut models = Vec::new();
    for row in rows {
        models.push(row?);
    }
    Ok(models)
}

/// Deletes a single cached model by id.
pub fn delete_one(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM models WHERE id = ?1", [id])?;
    Ok(())
}

/// Inserts or updates one benchmark row, keyed on its deterministic id.
///
/// Upsert rather than insert: re-running the same benchmark on the same machine
/// replaces that machine's number instead of accumulating duplicates.
pub fn upsert_bench(conn: &Connection, r: &BenchRun) -> Result<()> {
    conn.execute(
        "INSERT INTO bench_runs (
            id, hw_key, chip_key, chip, cpu_cores, gpu_cores, memory_gb, os_version,
            model_name, model_digest, quant, num_ctx, kv_cache_type, flash_attn,
            ollama_version, suite_id, suite_version,
            prefill_tps_median, decode_tps_median, load_ms, peak_rss_bytes, repeats,
            install_id, rating, review, visible, created_at, updated_at, source, synced_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
            ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30
         )
         ON CONFLICT(id) DO UPDATE SET
            prefill_tps_median = excluded.prefill_tps_median,
            decode_tps_median  = excluded.decode_tps_median,
            load_ms            = excluded.load_ms,
            peak_rss_bytes     = excluded.peak_rss_bytes,
            repeats            = excluded.repeats,
            rating             = excluded.rating,
            review             = excluded.review,
            visible            = excluded.visible,
            updated_at         = excluded.updated_at,
            synced_at          = excluded.synced_at",
        rusqlite::params![
            r.id,
            r.hw.hw_key,
            r.hw.chip_key,
            r.hw.chip,
            r.hw.cpu_cores,
            r.hw.gpu_cores,
            r.hw.memory_gb,
            r.hw.os_version,
            r.model_name,
            r.model_digest,
            r.quant,
            r.num_ctx,
            r.kv_cache_type,
            r.flash_attn,
            r.ollama_version,
            r.suite_id,
            r.suite_version,
            r.prefill_tps_median,
            r.decode_tps_median,
            r.load_ms,
            r.peak_rss_bytes,
            r.repeats,
            r.install_id,
            r.rating,
            r.review,
            r.visible,
            r.created_at,
            r.updated_at,
            bench_source_to_str(r.source),
            r.synced_at,
        ],
    )?;
    Ok(())
}

/// Every column of `bench_runs`, in the order [`row_to_bench`] reads them.
const BENCH_COLUMNS: &str = "id, hw_key, chip_key, chip, cpu_cores, gpu_cores, memory_gb, os_version,
     model_name, model_digest, quant, num_ctx, kv_cache_type, flash_attn,
     ollama_version, suite_id, suite_version,
     prefill_tps_median, decode_tps_median, load_ms, peak_rss_bytes, repeats,
     install_id, rating, review, visible, created_at, updated_at, source, synced_at";

/// Benchmark results for a model, from machines resembling `hw`, best match first.
///
/// One query rather than three: tiers 1 and 2 are strictly narrower than tier 3,
/// so the tier is computed as a column and sorted on. Note `IS` rather than `=`
/// for memory — it is null-safe in SQLite, so a row with unknown memory falls to
/// the family tier instead of vanishing from the results entirely.
pub fn bench_runs_for(
    conn: &Connection,
    hw: &HwIdentity,
    model_digest: &str,
) -> Result<Vec<BenchRun>> {
    let sql = format!(
        "SELECT {BENCH_COLUMNS},
                CASE WHEN hw_key = ?1                                THEN 1
                     WHEN memory_gb IS ?3 AND memory_gb IS NOT NULL  THEN 2
                     ELSE 3
                END AS match_tier
           FROM bench_runs
          WHERE visible = TRUE AND chip_key = ?2 AND model_digest = ?4
          ORDER BY match_tier, decode_tps_median DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params![hw.hw_key, hw.chip_key, hw.memory_gb, model_digest],
        |row| {
            let mut run = row_to_bench(row)?;
            run.match_quality = Some(MatchQuality::from_tier(row.get::<_, i64>(30)?));
            Ok(run)
        },
    )?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn row_to_bench(row: &rusqlite::Row<'_>) -> rusqlite::Result<BenchRun> {
    Ok(BenchRun {
        id: row.get(0)?,
        hw: HwIdentity {
            hw_key: row.get(1)?,
            chip_key: row.get(2)?,
            chip: row.get(3)?,
            cpu_cores: row.get(4)?,
            gpu_cores: row.get(5)?,
            memory_gb: row.get(6)?,
            os_version: row.get(7)?,
        },
        model_name: row.get(8)?,
        model_digest: row.get(9)?,
        quant: row.get(10)?,
        num_ctx: row.get(11)?,
        kv_cache_type: row.get(12)?,
        flash_attn: row.get(13)?,
        ollama_version: row.get(14)?,
        suite_id: row.get(15)?,
        suite_version: row.get(16)?,
        prefill_tps_median: row.get(17)?,
        decode_tps_median: row.get(18)?,
        load_ms: row.get(19)?,
        peak_rss_bytes: row.get(20)?,
        repeats: row.get(21)?,
        install_id: row.get(22)?,
        rating: row.get(23)?,
        review: row.get(24)?,
        visible: row.get(25)?,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
        source: bench_source_from_str(&row.get::<_, String>(28)?),
        synced_at: row.get(29)?,
        match_quality: None,
    })
}

/// Marks a review as unlocked, and reports how many of the weekly allowance
/// remain afterwards.
///
/// Unlocking is idempotent: re-reading a review already opened doesn't spend
/// another slot. `now_ms` is passed in rather than read from the clock so the
/// window boundary is testable.
pub fn unlock_review(
    conn: &Connection,
    run_id: &str,
    now_ms: i64,
    allowance: u32,
) -> Result<ReviewAllowance> {
    let already: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM review_views WHERE run_id = ?1)",
        [run_id],
        |r| r.get(0),
    )?;
    if !already && reviews_used(conn, now_ms)? >= allowance {
        return Ok(ReviewAllowance {
            unlocked: false,
            used: allowance,
            allowance,
        });
    }
    conn.execute(
        "INSERT OR IGNORE INTO review_views (run_id, viewed_at) VALUES (?1, ?2)",
        rusqlite::params![run_id, now_ms],
    )?;
    Ok(ReviewAllowance {
        unlocked: true,
        used: reviews_used(conn, now_ms)?,
        allowance,
    })
}

/// Reviews unlocked within the trailing seven days.
pub fn reviews_used(conn: &Connection, now_ms: i64) -> Result<u32> {
    const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
    Ok(conn.query_row(
        "SELECT count(*) FROM review_views WHERE viewed_at > ?1",
        [now_ms - WEEK_MS],
        |r| r.get(0),
    )?)
}

/// Whether a given review has already been unlocked (and so reads for free).
pub fn review_is_unlocked(conn: &Connection, run_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM review_views WHERE run_id = ?1)",
        [run_id],
        |r| r.get(0),
    )?)
}

/// The state of the rolling weekly review allowance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ReviewAllowance {
    /// False when the request was refused for being over the allowance.
    pub unlocked: bool,
    pub used: u32,
    pub allowance: u32,
}

/// A persisted chat conversation. Mirrored on the frontend as `Conversation`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// The model this conversation talks to (changeable mid-thread).
    pub model: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// One stored chat turn. Mirrored on the frontend as `ChatMessage` (the `stats`
/// there is `GenerationStats`, JSON-encoded in `stats_json` here).
#[derive(Debug, Clone, serde::Serialize)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    /// A thinking model's reasoning for an assistant turn. `None` otherwise.
    pub thinking: Option<String>,
    /// Generation stats for an assistant turn, as raw JSON. `None` for user turns.
    pub stats_json: Option<String>,
    pub created_ms: i64,
}

/// Inserts a new conversation row.
pub fn insert_conversation(conn: &Connection, c: &Conversation) -> Result<()> {
    conn.execute(
        "INSERT INTO conversations (id, title, model, created_ms, updated_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![c.id, c.title, c.model, c.created_ms, c.updated_ms],
    )?;
    Ok(())
}

/// Lists conversations, most-recently-updated first.
pub fn list_conversations(conn: &Connection) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, model, created_ms, updated_ms
         FROM conversations ORDER BY updated_ms DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Conversation {
            id: row.get(0)?,
            title: row.get(1)?,
            model: row.get(2)?,
            created_ms: row.get(3)?,
            updated_ms: row.get(4)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// The model a conversation currently uses, or `None` if it doesn't exist.
pub fn conversation_model(conn: &Connection, id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT model FROM conversations WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.into()),
    })
}

/// Renames a conversation (title only; ordering is untouched).
pub fn rename_conversation(conn: &Connection, id: &str, title: &str) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET title = ?2 WHERE id = ?1",
        rusqlite::params![id, title],
    )?;
    Ok(())
}

/// Points a conversation at a different model.
pub fn set_conversation_model(conn: &Connection, id: &str, model: &str) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET model = ?2 WHERE id = ?1",
        rusqlite::params![id, model],
    )?;
    Ok(())
}

/// Deletes a conversation and all of its messages.
///
/// Explicit message delete rather than relying on the FK cascade, which needs
/// `PRAGMA foreign_keys=ON` per connection — this keeps it correct regardless.
pub fn delete_conversation(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM messages WHERE conversation_id = ?1", [id])?;
    conn.execute("DELETE FROM conversations WHERE id = ?1", [id])?;
    Ok(())
}

/// Appends one message and bumps its conversation's `updated_ms` to the same
/// timestamp, so the sidebar re-sorts the active chat to the top.
pub fn append_message(conn: &Connection, conversation_id: &str, m: &StoredMessage) -> Result<()> {
    conn.execute(
        "INSERT INTO messages (id, conversation_id, role, content, thinking, stats_json, created_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![m.id, conversation_id, m.role, m.content, m.thinking, m.stats_json, m.created_ms],
    )?;
    conn.execute(
        "UPDATE conversations SET updated_ms = ?2 WHERE id = ?1",
        rusqlite::params![conversation_id, m.created_ms],
    )?;
    Ok(())
}

/// Reads a conversation's messages in chronological order.
pub fn messages_for(conn: &Connection, conversation_id: &str) -> Result<Vec<StoredMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, role, content, thinking, stats_json, created_ms
         FROM messages WHERE conversation_id = ?1 ORDER BY created_ms",
    )?;
    let rows = stmt.query_map([conversation_id], |row| {
        Ok(StoredMessage {
            id: row.get(0)?,
            role: row.get(1)?,
            content: row.get(2)?,
            thinking: row.get(3)?,
            stats_json: row.get(4)?,
            created_ms: row.get(5)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn bench_source_to_str(s: BenchSource) -> &'static str {
    match s {
        BenchSource::Local => "local",
        BenchSource::Community => "community",
    }
}

fn bench_source_from_str(s: &str) -> BenchSource {
    match s {
        "community" => BenchSource::Community,
        _ => BenchSource::Local,
    }
}

/// Serialises architecture metadata to a single JSON column.
///
/// One column rather than nine: nothing queries these fields, they are only ever
/// read back whole, and a widening `ArchMeta` then costs no migration.
fn arch_to_json(arch: Option<&ArchMeta>) -> Option<String> {
    arch.and_then(|a| serde_json::to_string(a).ok())
}

/// Reads architecture metadata back. Unparseable JSON degrades to `None` (the
/// caller falls back to an estimate) rather than failing the whole cache read.
fn arch_from_json(raw: Option<&str>) -> Option<ArchMeta> {
    raw.and_then(|s| serde_json::from_str(s).ok())
}

fn status_to_str(status: ModelStatus) -> &'static str {
    match status {
        ModelStatus::Installed => "installed",
        ModelStatus::Available => "available",
    }
}

fn status_from_str(s: &str) -> ModelStatus {
    match s {
        "available" => ModelStatus::Available,
        _ => ModelStatus::Installed,
    }
}

#[cfg(test)]
mod tests;
