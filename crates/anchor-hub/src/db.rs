//! SQLite persistence for the registry.
//!
//! The DB is a *cache* of what Ollama reports, so the app can still show the last
//! known model list when the Ollama server is offline. All functions take a
//! borrowed [`Connection`] so the [`Registry`](crate::Registry) can open a fresh,
//! short-lived connection per call (keeping its async methods `Send`).

use anchor_core::{Model, ModelStatus};
use rusqlite::Connection;

use crate::Result;

/// Creates the `models` table if it does not already exist.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS models (
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
        )",
        [],
    )?;
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
                (id, name, family, size_bytes, status, parameter_size, quantization, context_tokens, modified_at, publisher)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Reads every cached model.
pub fn read_all(conn: &Connection) -> Result<Vec<Model>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, family, size_bytes, status, parameter_size, quantization, context_tokens, modified_at, publisher
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
