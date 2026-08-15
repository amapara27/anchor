//! SQLite persistence for the registry.
//!
//! The DB is a *cache* of what Ollama reports, so the app can still show the last
//! known model list when the Ollama server is offline. All functions take a
//! borrowed [`Connection`] so the [`Registry`](crate::Registry) can open a fresh,
//! short-lived connection per call (keeping its async methods `Send`).

use anchor_core::{
    ArchMeta, BenchRun, BenchSample, BenchSource, EnvTelemetry, HwIdentity, MatchQuality, Model,
    ModelStatus,
};
use rusqlite::Connection;

use crate::Result;

/// The schema version this build expects. Bump alongside a new `V*` constant.
const SCHEMA_VERSION: i64 = 9;

/// The preset a conversation falls back to when it has none of its own. Seeded
/// by [`V6`] and never deleted — the Settings panel edits this row, which is why
/// there is no separate "inference defaults" store.
pub const DEFAULT_PRESET_ID: &str = "default";

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

/// Version 4: agent run history — one row per finished agent run.
///
/// `detail_json` holds the run's payload (output, queries, sources, phase
/// timings) as a single column, for the same reason `models.arch` does: nothing
/// queries inside it, it is only ever read back whole, and a widening detail
/// then costs no migration.
const V4: &str = "
    CREATE TABLE IF NOT EXISTS agent_runs (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        model       TEXT NOT NULL,
        task        TEXT NOT NULL,
        status      TEXT NOT NULL,
        started_ms  INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        tokens      INTEGER,
        detail_json TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_runs_recent ON agent_runs (started_ms DESC);
";

/// Version 5: durable state for the memory-backed agents.
///
/// Both tables land in one migration on purpose — the Local Memory Chat and
/// Knowledge Base agents are built in parallel, and two migrations racing for the
/// same `user_version` is the one conflict git cannot resolve.
///
/// `kb_chunks.embedding` is the raw 384-float BGE-small vector as little-endian
/// bytes; cosine runs in Rust. SQLite can't index it usefully, and a blob keeps
/// the row readable in one pass.
const V5: &str = "
    CREATE TABLE IF NOT EXISTS agent_memory (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        scope       TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_ms  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_memory_scope
        ON agent_memory (agent_id, scope, created_ms DESC);

    CREATE TABLE IF NOT EXISTS kb_documents (
        id        TEXT PRIMARY KEY,
        title     TEXT NOT NULL,
        path      TEXT,
        chunks    INTEGER NOT NULL DEFAULT 0,
        added_ms  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kb_chunks (
        id        TEXT PRIMARY KEY,
        doc_id    TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        ord       INTEGER NOT NULL,
        text      TEXT NOT NULL,
        embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks (doc_id, ord);
";

/// Version 6: inference presets — a named bundle of {system prompt, temperature,
/// num_ctx, top_p} a conversation can be run under.
///
/// Every tuning column is nullable and `NULL` means "leave it to Ollama", which
/// maps exactly onto the `Option<T>` fields of [`ChatRequest`](crate::ChatRequest)
/// — so the seeded `default` row reproduces today's behaviour exactly until the
/// user changes something.
///
/// One table serves both presets and the app's inference defaults: the defaults
/// *are* the `default` row. Two stores would mean two resolution paths and a
/// rule about which wins.
const V6: &str = "
    CREATE TABLE IF NOT EXISTS presets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        system      TEXT,
        temperature REAL,
        num_ctx     INTEGER,
        top_p       REAL,
        model       TEXT,
        created_ms  INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO presets (id, name, created_ms) VALUES ('default', 'Default', 0);
    ALTER TABLE conversations ADD COLUMN preset_id TEXT;
";

/// Version 7: a cache of the public Ollama library listing.
///
/// Cached because it's scraped from a website (see [`library`](crate::library)):
/// browsing must work offline, must not re-fetch a 700 KB page on every visit,
/// and — most importantly — must survive a redesign that breaks the parser by
/// serving the last good copy rather than an empty catalog.
///
/// `capabilities`/`sizes` are JSON arrays in one column each, for the same
/// reason `models.arch` is: nothing queries inside them, they're only ever read
/// back whole.
const V7: &str = "
    CREATE TABLE IF NOT EXISTS library_models (
        name         TEXT PRIMARY KEY,
        description  TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        sizes        TEXT NOT NULL,
        pulls        INTEGER NOT NULL,
        tag_count    INTEGER NOT NULL,
        updated      TEXT NOT NULL,
        fetched_ms   INTEGER NOT NULL
    );
";

/// Architecture metadata for models that are *not* installed, read from the
/// registry by [`gguf`](crate::gguf) so a browsable tag can be sized exactly.
///
/// Keyed on the tag, but stamped with the manifest `digest`: a tag can be
/// re-pointed at a different build, and the GGUF behind the new one may have a
/// different architecture entirely. Comparing digests is what makes this cache
/// safe to keep forever — the bytes behind a digest never change.
///
/// `arch` is nullable on purpose. A model whose header can't be read is worth
/// remembering as unreadable, so browsing doesn't retry it on every render.
const V8: &str = "
    CREATE TABLE IF NOT EXISTS tag_arch (
        tag        TEXT PRIMARY KEY,
        digest     TEXT NOT NULL,
        arch       TEXT,
        fetched_ms INTEGER NOT NULL
    );
";

/// Version 9: per-prompt benchmark rows, per-run telemetry, and the raw
/// samples behind each row's medians.
///
/// Every `bench_runs` column added here is nullable, so the older
/// single-prompt rows that predate it read back with `NULL` rather than
/// needing a backfill. (The `anchor-std`/`anchor-full` suites this migration
/// was written for have since been replaced by `anchor-scenarios`; their rows
/// remain readable but nothing queries them.)
const V9: &str = "
    ALTER TABLE bench_runs ADD COLUMN prompt_id TEXT;
    ALTER TABLE bench_runs ADD COLUMN prompt_version INTEGER;
    ALTER TABLE bench_runs ADD COLUMN ttft_ms_median REAL;
    ALTER TABLE bench_runs ADD COLUMN thermal_label TEXT;
    ALTER TABLE bench_runs ADD COLUMN notes TEXT;
    ALTER TABLE bench_runs ADD COLUMN env_start_json TEXT;
    ALTER TABLE bench_runs ADD COLUMN env_end_json TEXT;
    CREATE INDEX IF NOT EXISTS bench_runs_cell
        ON bench_runs (suite_id, prompt_id, num_ctx, hw_key, model_digest);
    CREATE TABLE IF NOT EXISTS bench_samples (
        id                      TEXT NOT NULL PRIMARY KEY,
        bench_run_id            TEXT NOT NULL REFERENCES bench_runs(id) ON DELETE CASCADE,
        repeat_index            INTEGER NOT NULL,
        is_warmup               BOOLEAN NOT NULL DEFAULT FALSE,
        prefill_tps             REAL,
        decode_tps              REAL,
        ttft_ms                 REAL,
        prompt_eval_count       INTEGER,
        prompt_eval_duration_ns INTEGER,
        eval_count              INTEGER,
        eval_duration_ns        INTEGER,
        total_duration_ns       INTEGER,
        load_duration_ns        INTEGER,
        wall_start_ms           BIGINT NOT NULL,
        created_at              BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bench_samples_by_run
        ON bench_samples (bench_run_id, repeat_index);
";

/// Reads cached architecture metadata for `tag`, if it was recorded against
/// this exact `digest`.
///
/// The outer `Option` is "have we looked?"; the inner is "did it work?". A
/// recorded failure is a hit, not a miss.
pub fn read_tag_arch(conn: &Connection, tag: &str, digest: &str) -> Result<Option<Option<ArchMeta>>> {
    let mut stmt = conn.prepare("SELECT arch FROM tag_arch WHERE tag = ?1 AND digest = ?2")?;
    let mut rows = stmt.query(rusqlite::params![tag, digest])?;
    match rows.next()? {
        Some(row) => {
            let raw: Option<String> = row.get(0)?;
            Ok(Some(arch_from_json(raw.as_deref())))
        }
        None => Ok(None),
    }
}

/// Records what reading `tag`'s header produced, replacing any older digest.
pub fn write_tag_arch(
    conn: &Connection,
    tag: &str,
    digest: &str,
    arch: Option<&ArchMeta>,
    now_ms: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO tag_arch (tag, digest, arch, fetched_ms) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(tag) DO UPDATE SET digest = ?2, arch = ?3, fetched_ms = ?4",
        rusqlite::params![tag, digest, arch_to_json(arch), now_ms],
    )?;
    Ok(())
}

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
    if version < 4 {
        tx.execute_batch(V4)?;
    }
    if version < 5 {
        tx.execute_batch(V5)?;
    }
    if version < 6 {
        tx.execute_batch(V6)?;
    }
    if version < 7 {
        tx.execute_batch(V7)?;
    }
    if version < 8 {
        tx.execute_batch(V8)?;
    }
    if version < 9 {
        tx.execute_batch(V9)?;
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

/// Inserts or updates one benchmark row and its raw samples, keyed on the
/// row's deterministic id.
///
/// Upsert rather than insert: re-running the same benchmark on the same
/// machine replaces that machine's number instead of accumulating duplicates.
/// The samples are deleted and reinserted alongside it in the same
/// transaction — a stale sample from a previous run must never linger under
/// an id whose aggregate has moved on.
pub fn upsert_bench_with_samples(conn: &mut Connection, r: &BenchRun, samples: &[BenchSample]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO bench_runs (
            id, hw_key, chip_key, chip, cpu_cores, gpu_cores, memory_gb, os_version,
            model_name, model_digest, quant, num_ctx, kv_cache_type, flash_attn,
            ollama_version, suite_id, suite_version,
            prefill_tps_median, decode_tps_median, load_ms, peak_rss_bytes, repeats,
            install_id, rating, review, visible, created_at, updated_at, source, synced_at,
            prompt_id, prompt_version, ttft_ms_median, thermal_label, notes,
            env_start_json, env_end_json
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
            ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
            ?31, ?32, ?33, ?34, ?35, ?36, ?37
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
            synced_at          = excluded.synced_at,
            ttft_ms_median     = excluded.ttft_ms_median,
            thermal_label      = excluded.thermal_label,
            notes              = excluded.notes,
            env_start_json     = excluded.env_start_json,
            env_end_json       = excluded.env_end_json",
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
            r.prompt_id,
            r.prompt_version,
            r.ttft_ms_median,
            r.thermal_label,
            r.notes,
            env_to_json(r.env_start.as_ref()),
            env_to_json(r.env_end.as_ref()),
        ],
    )?;

    tx.execute("DELETE FROM bench_samples WHERE bench_run_id = ?1", [&r.id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO bench_samples (
                id, bench_run_id, repeat_index, is_warmup, prefill_tps, decode_tps, ttft_ms,
                prompt_eval_count, prompt_eval_duration_ns, eval_count, eval_duration_ns,
                total_duration_ns, load_duration_ns, wall_start_ms, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        for s in samples {
            stmt.execute(rusqlite::params![
                s.id,
                s.bench_run_id,
                s.repeat_index,
                s.is_warmup,
                s.prefill_tps,
                s.decode_tps,
                s.ttft_ms,
                s.prompt_eval_count,
                s.prompt_eval_duration_ns,
                s.eval_count,
                s.eval_duration_ns,
                s.total_duration_ns,
                s.load_duration_ns,
                s.wall_start_ms,
                s.created_at,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Every column of `bench_runs`, in the order [`row_to_bench`] reads them.
const BENCH_COLUMNS: &str = "id, hw_key, chip_key, chip, cpu_cores, gpu_cores, memory_gb, os_version,
     model_name, model_digest, quant, num_ctx, kv_cache_type, flash_attn,
     ollama_version, suite_id, suite_version,
     prefill_tps_median, decode_tps_median, load_ms, peak_rss_bytes, repeats,
     install_id, rating, review, visible, created_at, updated_at, source, synced_at,
     prompt_id, prompt_version, ttft_ms_median, thermal_label, notes, env_start_json, env_end_json";

/// Benchmark results from machines resembling `hw`, best match first.
///
/// One query rather than three: tiers 1 and 2 are strictly narrower than tier 3,
/// so the tier is computed as a column and sorted on. Note `IS` rather than `=`
/// for memory (and for `model_digest`/`prompt_id`/`suite_id`/`num_ctx` when
/// filtering) — `IS` is null-safe in SQLite, so an unknown/absent value matches
/// rather than vanishing from the results entirely.
///
/// `model_digest: None` ranks every model against every other one (the
/// leaderboard's cross-model view — meaningful once `suite_id`/`prompt_id`/
/// `num_ctx` pin the comparison to one apples-to-apples configuration).
/// `suite_id`/`prompt_id`/`num_ctx` are `None` when the caller wants every
/// suite mixed together; pass `suite_id: Some(bench::SUITE_ID)` and a
/// `prompt_id` (a scenario id) to pin a leaderboard to one shape, so rows from
/// a retired suite are never blended into numbers the caller expects to be
/// one suite's.
pub fn bench_runs_for(
    conn: &Connection,
    hw: &HwIdentity,
    model_digest: Option<&str>,
    suite_id: Option<&str>,
    prompt_id: Option<&str>,
    num_ctx: Option<u32>,
) -> Result<Vec<BenchRun>> {
    let sql = format!(
        "SELECT {BENCH_COLUMNS},
                CASE WHEN hw_key = ?1                                THEN 1
                     WHEN memory_gb IS ?3 AND memory_gb IS NOT NULL  THEN 2
                     ELSE 3
                END AS match_tier
           FROM bench_runs
          WHERE visible = TRUE AND chip_key = ?2
            AND (?4 IS NULL OR model_digest = ?4)
            AND (?5 IS NULL OR suite_id = ?5)
            AND (?6 IS NULL OR prompt_id IS ?6)
            AND (?7 IS NULL OR num_ctx = ?7)
          ORDER BY match_tier, decode_tps_median DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params![hw.hw_key, hw.chip_key, hw.memory_gb, model_digest, suite_id, prompt_id, num_ctx],
        |row| {
            let mut run = row_to_bench(row)?;
            run.match_quality = Some(MatchQuality::from_tier(row.get::<_, i64>(37)?));
            Ok(run)
        },
    )?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// Recent benchmark runs on this exact machine, newest first — the History
/// panel's feed. Distinct from [`bench_runs_for`]: that one ranks by *speed*
/// across whatever machines match a hardware tier; this one is chronological
/// and scoped to `hw_key` exactly (never a looser tier — it's "my history",
/// not "machines like mine"). `model_digest: None` mixes every model
/// together; `Some(digest)` scopes to one.
pub fn bench_history(
    conn: &Connection,
    hw_key: &str,
    model_digest: Option<&str>,
    limit: u32,
) -> Result<Vec<BenchRun>> {
    let sql = format!(
        "SELECT {BENCH_COLUMNS}
           FROM bench_runs
          WHERE visible = TRUE AND hw_key = ?1
            AND (?2 IS NULL OR model_digest = ?2)
          ORDER BY updated_at DESC
          LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![hw_key, model_digest, limit], row_to_bench)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// Raw per-repeat samples behind a `BenchRun`'s medians, in repeat order
/// (warmup first).
pub fn bench_samples_for(conn: &Connection, bench_run_id: &str) -> Result<Vec<BenchSample>> {
    let mut stmt = conn.prepare(
        "SELECT id, bench_run_id, repeat_index, is_warmup, prefill_tps, decode_tps, ttft_ms,
                prompt_eval_count, prompt_eval_duration_ns, eval_count, eval_duration_ns,
                total_duration_ns, load_duration_ns, wall_start_ms, created_at
           FROM bench_samples WHERE bench_run_id = ?1 ORDER BY repeat_index",
    )?;
    let rows = stmt.query_map([bench_run_id], |row| {
        Ok(BenchSample {
            id: row.get(0)?,
            bench_run_id: row.get(1)?,
            repeat_index: row.get(2)?,
            is_warmup: row.get(3)?,
            prefill_tps: row.get(4)?,
            decode_tps: row.get(5)?,
            ttft_ms: row.get(6)?,
            prompt_eval_count: row.get(7)?,
            prompt_eval_duration_ns: row.get(8)?,
            eval_count: row.get(9)?,
            eval_duration_ns: row.get(10)?,
            total_duration_ns: row.get(11)?,
            load_duration_ns: row.get(12)?,
            wall_start_ms: row.get(13)?,
            created_at: row.get(14)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// Updates a run's free-text notes, e.g. after the user edits an
/// auto-populated anomaly note.
pub fn update_bench_notes(conn: &Connection, run_id: &str, notes: Option<&str>) -> Result<()> {
    conn.execute("UPDATE bench_runs SET notes = ?2 WHERE id = ?1", rusqlite::params![run_id, notes])?;
    Ok(())
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
        prompt_id: row.get(30)?,
        prompt_version: row.get(31)?,
        ttft_ms_median: row.get(32)?,
        thermal_label: row.get(33)?,
        notes: row.get(34)?,
        env_start: env_from_json(row.get::<_, Option<String>>(35)?.as_deref()),
        env_end: env_from_json(row.get::<_, Option<String>>(36)?.as_deref()),
    })
}

/// A persisted chat conversation. Mirrored on the frontend as `Conversation`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// The model this conversation talks to (changeable mid-thread).
    pub model: String,
    /// The [`Preset`] this conversation runs under. `None` falls back to
    /// [`DEFAULT_PRESET_ID`], so an old conversation needs no backfill.
    pub preset_id: Option<String>,
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
        "INSERT INTO conversations (id, title, model, preset_id, created_ms, updated_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![c.id, c.title, c.model, c.preset_id, c.created_ms, c.updated_ms],
    )?;
    Ok(())
}

/// Lists conversations, most-recently-updated first.
pub fn list_conversations(conn: &Connection) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, model, preset_id, created_ms, updated_ms
         FROM conversations ORDER BY updated_ms DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Conversation {
            id: row.get(0)?,
            title: row.get(1)?,
            model: row.get(2)?,
            preset_id: row.get(3)?,
            created_ms: row.get(4)?,
            updated_ms: row.get(5)?,
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
    // MAX, not assignment: `updated_ms` orders the conversation rail, and a
    // message timestamped behind the conversation would move it backwards.
    // `run_chat` always passes `now_ms()`, so this is one clock skew away rather
    // than reachable today.
    conn.execute(
        "UPDATE conversations SET updated_ms = MAX(updated_ms, ?2) WHERE id = ?1",
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

/// A named bundle of generation settings. Mirrored on the frontend as `Preset`.
///
/// Every tuning field is optional and `None` means "leave it to Ollama" — the
/// same contract as the matching [`ChatRequest`](crate::ChatRequest) fields, so
/// resolving a preset is a straight field copy with no defaulting in between.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    /// Prepended as a `system` turn at request time. Never stored as a message —
    /// that would re-prepend it on every subsequent turn.
    pub system: Option<String>,
    pub temperature: Option<f32>,
    pub num_ctx: Option<u32>,
    pub top_p: Option<f32>,
    /// The model this preset was written for, when it's model-specific. Advisory
    /// only today: the UI surfaces it, nothing enforces it.
    pub model: Option<String>,
    pub created_ms: i64,
}

/// Every column of `presets`, in the order [`row_to_preset`] reads them.
const PRESET_COLUMNS: &str = "id, name, system, temperature, num_ctx, top_p, model, created_ms";

fn row_to_preset(row: &rusqlite::Row<'_>) -> rusqlite::Result<Preset> {
    Ok(Preset {
        id: row.get(0)?,
        name: row.get(1)?,
        system: row.get(2)?,
        temperature: row.get(3)?,
        num_ctx: row.get(4)?,
        top_p: row.get(5)?,
        model: row.get(6)?,
        created_ms: row.get(7)?,
    })
}

/// Lists presets with the default first, then oldest-first.
pub fn list_presets(conn: &Connection) -> Result<Vec<Preset>> {
    let sql = format!(
        "SELECT {PRESET_COLUMNS} FROM presets
         ORDER BY (id = '{DEFAULT_PRESET_ID}') DESC, created_ms, name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_preset)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// Inserts or updates one preset, keyed on its id.
pub fn upsert_preset(conn: &Connection, p: &Preset) -> Result<()> {
    conn.execute(
        "INSERT INTO presets (id, name, system, temperature, num_ctx, top_p, model, created_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            name        = excluded.name,
            system      = excluded.system,
            temperature = excluded.temperature,
            num_ctx     = excluded.num_ctx,
            top_p       = excluded.top_p,
            model       = excluded.model",
        rusqlite::params![
            p.id,
            p.name,
            p.system,
            p.temperature,
            p.num_ctx,
            p.top_p,
            p.model,
            p.created_ms,
        ],
    )?;
    Ok(())
}

/// Deletes a preset and detaches any conversation using it (which then falls
/// back to the default). Deleting [`DEFAULT_PRESET_ID`] is a no-op — every
/// conversation resolves through it, so it must always exist.
pub fn delete_preset(conn: &Connection, id: &str) -> Result<()> {
    if id == DEFAULT_PRESET_ID {
        return Ok(());
    }
    conn.execute(
        "UPDATE conversations SET preset_id = NULL WHERE preset_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM presets WHERE id = ?1", [id])?;
    Ok(())
}

/// Points a conversation at a preset, or at the default when `preset_id` is
/// `None`.
pub fn set_conversation_preset(
    conn: &Connection,
    id: &str,
    preset_id: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET preset_id = ?2 WHERE id = ?1",
        rusqlite::params![id, preset_id],
    )?;
    Ok(())
}

/// The preset a conversation runs under: its own, else the default.
///
/// One query rather than two round-trips — `COALESCE` does the fallback, and a
/// conversation pointing at a preset that no longer exists simply matches no row
/// and yields `None` (the caller then sends no options, i.e. Ollama's defaults).
pub fn preset_for_conversation(conn: &Connection, conversation_id: &str) -> Result<Option<Preset>> {
    let sql = format!(
        "SELECT {PRESET_COLUMNS} FROM presets
          WHERE id = COALESCE(
              (SELECT preset_id FROM conversations WHERE id = ?1),
              '{DEFAULT_PRESET_ID}'
          )"
    );
    conn.query_row(&sql, [conversation_id], row_to_preset)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.into()),
        })
}

/// Replaces the cached library listing in one transaction, stamping every row
/// with `fetched_ms`.
///
/// Wholesale replace for the same reason [`replace_all`] does it: the cache is a
/// mirror, and a model pulled from the library upstream should vanish here too.
/// An empty listing is a no-op rather than a wipe. A scrape that came back empty
/// means the page changed shape, not that Ollama published nothing — replacing a
/// good cache with it would zero the table *and* reset `fetched_ms`, so the UI
/// would show an empty library and immediately re-scrape. The caller
/// ([`Registry::library`](crate::Registry::library)) also guards this; the check
/// belongs here so a future caller can't reintroduce the footgun.
pub fn replace_library(
    conn: &mut Connection,
    entries: &[crate::library::LibraryEntry],
    fetched_ms: i64,
) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM library_models", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO library_models
                (name, description, capabilities, sizes, pulls, tag_count, updated, fetched_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for e in entries {
            stmt.execute(rusqlite::params![
                e.name,
                e.description,
                serde_json::to_string(&e.capabilities)?,
                serde_json::to_string(&e.sizes)?,
                e.pulls,
                e.tag_count,
                e.updated,
                fetched_ms,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Reads the cached library listing, most-pulled first, with the timestamp it
/// was fetched at (`None` when the cache is empty).
pub fn read_library(conn: &Connection) -> Result<(Vec<crate::library::LibraryEntry>, Option<i64>)> {
    let mut stmt = conn.prepare(
        "SELECT name, description, capabilities, sizes, pulls, tag_count, updated, fetched_ms
         FROM library_models ORDER BY pulls DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            crate::library::LibraryEntry {
                name: row.get(0)?,
                description: row.get(1)?,
                // A corrupt JSON column degrades to no badges rather than
                // failing the whole read — the row is still browsable.
                capabilities: json_strings(&row.get::<_, String>(2)?),
                sizes: json_strings(&row.get::<_, String>(3)?),
                pulls: row.get(4)?,
                tag_count: row.get(5)?,
                updated: row.get(6)?,
            },
            row.get::<_, i64>(7)?,
        ))
    })?;
    let mut entries = Vec::new();
    let mut fetched = None;
    for row in rows {
        let (entry, at) = row?;
        entries.push(entry);
        fetched = Some(at);
    }
    Ok((entries, fetched))
}

/// Reads a JSON string array back, degrading to empty on anything unparseable.
fn json_strings(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// One finished agent run. Mirrored on the frontend as `AgentRun`.
///
/// Deserialize as well as Serialize: unlike chat, the whole row is assembled on
/// the frontend (which owns the streamed run) and handed back to be stored.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentRun {
    pub id: String,
    /// Which agent produced it, e.g. `research-assistant`.
    pub agent_id: String,
    pub model: String,
    /// What was asked — the research focus, shown as the run's subtitle.
    pub task: String,
    /// `completed` or `failed`.
    pub status: String,
    pub started_ms: i64,
    pub duration_ms: i64,
    /// Tokens generated, when the model reported them.
    pub tokens: Option<i64>,
    /// Run payload (output, queries, sources, phase timings) as raw JSON.
    pub detail_json: Option<String>,
}

/// Stores a finished run. Upsert so a re-save of the same id can't duplicate it.
pub fn insert_agent_run(conn: &Connection, r: &AgentRun) -> Result<()> {
    conn.execute(
        "INSERT INTO agent_runs
            (id, agent_id, model, task, status, started_ms, duration_ms, tokens, detail_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            status      = excluded.status,
            duration_ms = excluded.duration_ms,
            tokens      = excluded.tokens,
            detail_json = excluded.detail_json",
        rusqlite::params![
            r.id,
            r.agent_id,
            r.model,
            r.task,
            r.status,
            r.started_ms,
            r.duration_ms,
            r.tokens,
            r.detail_json,
        ],
    )?;
    Ok(())
}

/// Reads run history, newest first.
pub fn list_agent_runs(conn: &Connection, limit: u32) -> Result<Vec<AgentRun>> {
    let mut stmt = conn.prepare(
        "SELECT id, agent_id, model, task, status, started_ms, duration_ms, tokens, detail_json
         FROM agent_runs ORDER BY started_ms DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |row| {
        Ok(AgentRun {
            id: row.get(0)?,
            agent_id: row.get(1)?,
            model: row.get(2)?,
            task: row.get(3)?,
            status: row.get(4)?,
            started_ms: row.get(5)?,
            duration_ms: row.get(6)?,
            tokens: row.get(7)?,
            detail_json: row.get(8)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// One remembered fact. Mirrored on the frontend as `AgentMemory`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentMemory {
    pub id: String,
    /// Which agent owns it, e.g. `local-memory-chat`.
    pub agent_id: String,
    /// Partitions memories within one agent (a conversation id, a project name).
    pub scope: String,
    pub content: String,
    pub created_ms: i64,
}

/// Stores a fact. Upsert so re-saving the same id can't duplicate it.
pub fn insert_memory(conn: &Connection, m: &AgentMemory) -> Result<()> {
    conn.execute(
        "INSERT INTO agent_memory (id, agent_id, scope, content, created_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content",
        rusqlite::params![m.id, m.agent_id, m.scope, m.content, m.created_ms],
    )?;
    Ok(())
}

/// Reads an agent's memories for one scope, newest first.
pub fn list_memories(
    conn: &Connection,
    agent_id: &str,
    scope: &str,
    limit: u32,
) -> Result<Vec<AgentMemory>> {
    let mut stmt = conn.prepare(
        "SELECT id, agent_id, scope, content, created_ms FROM agent_memory
         WHERE agent_id = ?1 AND scope = ?2 ORDER BY created_ms DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(rusqlite::params![agent_id, scope, limit], |row| {
        Ok(AgentMemory {
            id: row.get(0)?,
            agent_id: row.get(1)?,
            scope: row.get(2)?,
            content: row.get(3)?,
            created_ms: row.get(4)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// Forgets one fact.
pub fn delete_memory(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM agent_memory WHERE id = ?1", [id])?;
    Ok(())
}

/// One ingested knowledge-base document. Mirrored on the frontend as `KbDocument`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KbDocument {
    pub id: String,
    pub title: String,
    /// Source path on disk, when it came from a file.
    pub path: Option<String>,
    /// How many chunks it was split into.
    pub chunks: i64,
    pub added_ms: i64,
}

/// One chunk of a document plus its embedding vector.
#[derive(Debug, Clone)]
pub struct KbChunk {
    pub id: String,
    pub doc_id: String,
    /// Position within the document, 0-based.
    pub ord: i64,
    pub text: String,
    /// BGE-small vector; empty when the chunk was stored without one.
    pub embedding: Vec<f32>,
}

/// Registers a document. Upsert so a re-ingest of the same id replaces it.
pub fn insert_kb_document(conn: &Connection, d: &KbDocument) -> Result<()> {
    conn.execute(
        "INSERT INTO kb_documents (id, title, path, chunks, added_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title, path = excluded.path, chunks = excluded.chunks",
        rusqlite::params![d.id, d.title, d.path, d.chunks, d.added_ms],
    )?;
    Ok(())
}

/// Lists ingested documents, newest first.
pub fn list_kb_documents(conn: &Connection) -> Result<Vec<KbDocument>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, path, chunks, added_ms FROM kb_documents ORDER BY added_ms DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(KbDocument {
            id: row.get(0)?,
            title: row.get(1)?,
            path: row.get(2)?,
            chunks: row.get(3)?,
            added_ms: row.get(4)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// Drops a document and its chunks. Deletes chunks by hand rather than trusting
/// `ON DELETE CASCADE`, which needs a per-connection pragma — same reason
/// [`delete_conversation`] does.
pub fn delete_kb_document(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM kb_chunks WHERE doc_id = ?1", [id])?;
    conn.execute("DELETE FROM kb_documents WHERE id = ?1", [id])?;
    Ok(())
}

/// Stores a document's chunks in one transaction, replacing any it already had.
pub fn replace_kb_chunks(conn: &mut Connection, doc_id: &str, chunks: &[KbChunk]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM kb_chunks WHERE doc_id = ?1", [doc_id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO kb_chunks (id, doc_id, ord, text, embedding) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for c in chunks {
            stmt.execute(rusqlite::params![
                c.id,
                c.doc_id,
                c.ord,
                c.text,
                embedding_to_blob(&c.embedding),
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Reads every chunk, for a linear cosine scan.
///
/// ponytail: whole-table read + brute-force similarity. Fine into tens of
/// thousands of chunks; add an ANN index only if a real corpus outgrows it.
pub fn list_kb_chunks(conn: &Connection) -> Result<Vec<KbChunk>> {
    let mut stmt = conn.prepare("SELECT id, doc_id, ord, text, embedding FROM kb_chunks")?;
    let rows = stmt.query_map([], |row| {
        let blob: Option<Vec<u8>> = row.get(4)?;
        Ok(KbChunk {
            id: row.get(0)?,
            doc_id: row.get(1)?,
            ord: row.get(2)?,
            text: row.get(3)?,
            embedding: blob.as_deref().map(blob_to_embedding).unwrap_or_default(),
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// Packs an embedding into little-endian bytes for the `BLOB` column.
fn embedding_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Unpacks a stored embedding. A truncated blob yields the floats that survive
/// rather than failing the read — a bad vector just ranks poorly.
fn blob_to_embedding(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
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

/// Serialises an environmental telemetry snapshot to a single JSON column —
/// same rationale as [`arch_to_json`]: nothing queries inside it.
fn env_to_json(env: Option<&EnvTelemetry>) -> Option<String> {
    env.and_then(|e| serde_json::to_string(e).ok())
}

/// Reads a telemetry snapshot back. Corrupt JSON degrades to `None`.
fn env_from_json(raw: Option<&str>) -> Option<EnvTelemetry> {
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
