//! Provider-independent, local-only retrieval of redacted data and metadata.
mod connectors;
mod query;
mod stored_sources;
pub use stored_sources::sensitive_path;
#[cfg(test)]
mod tests;

use crate::state::AppState;
use connectors::Entry;
use rusqlite::{Connection, params};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

pub const SOURCES: &[(&str, bool)] = &[
    ("commands", true),
    ("sql", true),
    ("queries", true),
    ("bookmarks", true),
    ("sessions", true),
    ("groups", true),
    ("notes", true),
    ("tao", true),
    ("legacy", true),
    ("capabilities", true),
    ("memory", true),
    ("snapshots", true),
    ("file_contents", false),
    ("mail", false),
    ("mail_bodies", false),
    ("voice", false),
];

fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ds_app_search_sources(source TEXT PRIMARY KEY,enabled INTEGER NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS ds_app_search USING fts5(source UNINDEXED,ref UNINDEXED,title,body,
        host UNINDEXED,ts UNINDEXED,use_count UNINDEXED, tokenize='trigram');")
        .map_err(|error| error.to_string())
}

pub fn sources(conn: &Connection) -> Result<BTreeMap<String, bool>, String> {
    init(conn)?;
    let mut result: BTreeMap<String, bool> = SOURCES
        .iter()
        .map(|(name, enabled)| (name.to_string(), *enabled))
        .collect();
    let mut stmt = conn
        .prepare("SELECT source,enabled FROM ds_app_search_sources")
        .map_err(|e| e.to_string())?;
    for row in stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })
        .map_err(|e| e.to_string())?
    {
        let (source, enabled) = row.map_err(|e| e.to_string())?;
        if result.contains_key(&source) {
            result.insert(source, enabled);
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn deepseek_app_search_sources(
    state: State<'_, AppState>,
) -> Result<BTreeMap<String, bool>, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    sources(&db)
}

pub fn set_sources(conn: &Connection, values: BTreeMap<String, bool>) -> Result<(), String> {
    init(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (source, enabled) in values {
        let source = query::canonical_source(&source);
        if !SOURCES.iter().any(|(name, _)| *name == source) {
            return Err("protocol: unknown search source".into());
        }
        tx.execute(
            "INSERT OR REPLACE INTO ds_app_search_sources VALUES(?1,?2)",
            params![source, enabled],
        )
        .map_err(|e| e.to_string())?;
        if !enabled {
            tx.execute("DELETE FROM ds_app_search WHERE source=?1", [source])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn deepseek_app_set_search_sources(
    sources: BTreeMap<String, bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    set_sources(&db, sources)
}

#[tauri::command]
pub async fn deepseek_app_search(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    retrieve(state.inner(), &query).await
}

pub async fn retrieve(state: &AppState, query: &str) -> Result<Vec<Value>, String> {
    if matches!(
        state.core.vault.status()?.state,
        crate::vault::VaultStateKind::Locked
    ) {
        return Err("vault_locked: unlock Vault before searching local records".into());
    }
    let enabled = {
        let db = state.core.db.lock().map_err(|_| "database unavailable")?;
        sources(&db)?
    };
    let mut extras = Vec::new();
    if enabled.get("notes") == Some(&true) {
        let notes = state
            .core
            .notes_db
            .lock()
            .map_err(|_| "notes database unavailable")?;
        extras.extend(connectors::collect(
            &notes,
            "notes",
            "SELECT id,title,body,'',updated_at,1 FROM notes WHERE archived_at IS NULL",
        )?);
        extras.extend(connectors::collect(&notes, "notes", "SELECT s.id,n.title,s.title||' completed:'||CASE WHEN s.completed_at IS NULL THEN 'no' ELSE 'yes' END,'',s.updated_at,1 FROM note_steps s JOIN notes n ON n.id=s.note_id WHERE n.archived_at IS NULL")?);
    }
    extras.extend(stored_sources::collect(state, &enabled).await?);
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    synchronize(&db, extras)?;
    query::search(&db, query)
}

fn synchronize(conn: &Connection, extras: Vec<Entry>) -> Result<(), String> {
    let enabled = sources(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM ds_app_search", [])
        .map_err(|e| e.to_string())?;
    let mut entries = extras;
    for (source, sql) in connectors::QUERIES {
        if enabled.get(*source) == Some(&true) {
            entries.extend(connectors::collect(&tx, source, sql)?);
        }
    }
    if enabled.get("tao") == Some(&true) {
        entries.extend(connectors::tao(&tx)?);
    }
    if enabled.get("capabilities") == Some(&true) {
        entries.extend(connectors::capability_entries());
    }
    for entry in entries {
        // Recheck switches after collecting external stores: a concurrent
        // disable must win and must not reinsert previously collected content.
        if enabled.get(&entry.source) == Some(&true) {
            insert(&tx, &entry)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

fn insert(conn: &Connection, entry: &Entry) -> Result<(), String> {
    let Some((title, _)) = super::local_data::safe_excerpt(&entry.title, 240) else {
        return Ok(());
    };
    let Some((body, _)) = super::local_data::safe_excerpt(&entry.body, 16000) else {
        return Ok(());
    };
    let Some((host, _)) = super::local_data::safe_excerpt(&entry.host, 240) else {
        return Ok(());
    };
    conn.execute("INSERT INTO ds_app_search(source,ref,title,body,host,ts,use_count) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![entry.source, entry.reference, title, body, host, entry.ts, entry.uses]).map_err(|e| e.to_string())?;
    Ok(())
}
