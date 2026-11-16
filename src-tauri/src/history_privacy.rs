//! Write-time privacy migration for the history sources used by Tao.
//! Original secrets are intentionally discarded; SQLite transactions make an
//! interrupted migration retryable without publishing a partly migrated source.
use crate::chat::redact::redact;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPrivacySummary {
    pub version: i64,
    pub commands_cleaned: i64,
    pub queries_cleaned: i64,
}

pub fn summary(conn: &Connection) -> rusqlite::Result<HistoryPrivacySummary> {
    conn.query_row(
        "SELECT version, commands_cleaned, queries_cleaned
         FROM history_privacy_migrations ORDER BY version DESC LIMIT 1",
        [],
        |row| {
            Ok(HistoryPrivacySummary {
                version: row.get(0)?,
                commands_cleaned: row.get(1)?,
                queries_cleaned: row.get(2)?,
            })
        },
    )
    .optional()
    .map(|value| value.unwrap_or_default())
}

#[tauri::command]
pub async fn history_privacy_summary(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<HistoryPrivacySummary, String> {
    let conn = state.core.db.lock().map_err(|error| error.to_string())?;
    summary(&conn).map_err(|error| error.to_string())
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS history_privacy_migrations (
            version INTEGER PRIMARY KEY,
            commands_cleaned INTEGER NOT NULL,
            queries_cleaned INTEGER NOT NULL
        );",
    )?;
    let columns = tx
        .prepare("PRAGMA table_info(command_history)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == "redacted") {
        tx.execute(
            "ALTER TABLE command_history ADD COLUMN redacted INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if summary(&tx)?.version >= 1 {
        return tx.commit();
    }
    let commands = tx.prepare(
        "SELECT id, host_key, command, last_used_at, use_count FROM command_history ORDER BY id",
    )?.query_map([], |row| Ok((
        row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
        row.get::<_, i64>(3)?, row.get::<_, i64>(4)?,
    )))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut commands_cleaned = 0;
    for (id, host, original, used_at, count) in commands {
        let (clean, matches) = redact(&original);
        if matches == 0 {
            continue;
        }
        tx.execute("DELETE FROM command_history WHERE id = ?1", [id])?;
        tx.execute(
            "INSERT INTO command_history(host_key, command, last_used_at, use_count, redacted)
             VALUES (?1, ?2, ?3, ?4, 1)
             ON CONFLICT(host_key, command) DO UPDATE SET
               last_used_at = MAX(last_used_at, excluded.last_used_at),
               use_count = use_count + excluded.use_count, redacted = 1",
            params![host, clean, used_at, count],
        )?;
        commands_cleaned += 1;
    }
    let queries = tx
        .prepare("SELECT id, sql_content, error FROM sql_history")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut queries_cleaned = 0;
    for (id, original, error) in queries {
        let (clean, matches) = redact(&original);
        let (error, error_matches) = error.map_or((None, 0), |text| {
            let (clean, count) = redact(&text);
            (Some(clean), count)
        });
        if matches + error_matches == 0 {
            continue;
        }
        tx.execute(
            "UPDATE sql_history SET sql_content=?2, error=?3, redacted=1 WHERE id=?1",
            params![id, clean, error],
        )?;
        queries_cleaned += 1;
    }
    tx.execute(
        "INSERT INTO history_privacy_migrations VALUES (1, ?1, ?2)",
        params![commands_cleaned, queries_cleaned],
    )?;
    tx.commit()
}

#[cfg(test)]
#[path = "history_privacy_tests.rs"]
mod tests;
