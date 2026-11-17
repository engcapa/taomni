//! Persist attachment ownership and explicit branch grants, never file bodies.
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::HashSet;

pub(super) struct StoredFile {
    pub path: String,
    pub hash: String,
    pub filename: String,
    pub mime: String,
}

pub(super) fn init(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS tao_inline_files(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL)").map_err(|e| e.to_string())?;
    let has_provider = db
        .prepare("PRAGMA table_info(tao_inline_files)")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|column| column == "provider");
    if !has_provider {
        db.execute_batch(
            "ALTER TABLE tao_inline_files ADD COLUMN provider TEXT NOT NULL DEFAULT 'opencode-go'",
        )
        .map_err(|e| e.to_string())?;
    }
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS tao_inline_file_grants (
        id TEXT NOT NULL,thread_id TEXT NOT NULL,provider TEXT NOT NULL,
        PRIMARY KEY(id,thread_id,provider),
        FOREIGN KEY(id) REFERENCES tao_inline_files(id) ON DELETE CASCADE)",
    )
    .map_err(|e| e.to_string())
}

pub(super) fn remember(
    db: &Connection,
    id: &str,
    thread: &str,
    provider: &str,
    file: &StoredFile,
    size: usize,
) -> Result<bool, String> {
    init(db)?;
    let reused = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tao_inline_files WHERE id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    // Re-selecting identical bytes must not DELETE the row and cascade away
    // grants held by branches. IDs already bind the original owner and hash.
    db.execute("INSERT INTO tao_inline_files(id,thread_id,path,hash,filename,mime,size,provider)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET
        path=excluded.path,hash=excluded.hash,filename=excluded.filename,mime=excluded.mime,size=excluded.size",
        params![id, thread, file.path, file.hash, file.filename, file.mime, size as i64, provider])
        .map_err(|e| e.to_string())?;
    Ok(reused)
}

pub(super) fn lookup(
    db: &Connection,
    thread: &str,
    provider: &str,
    id: &str,
) -> Result<StoredFile, String> {
    init(db)?;
    db.query_row("SELECT f.path,f.hash,f.filename,f.mime FROM tao_inline_files f
        WHERE f.id=?1 AND f.provider=?3 AND (f.thread_id=?2 OR EXISTS(
        SELECT 1 FROM tao_inline_file_grants g WHERE g.id=f.id AND g.thread_id=?2 AND g.provider=f.provider))",
        params![id, thread, provider], |row| Ok(StoredFile {
            path: row.get(0)?, hash: row.get(1)?, filename: row.get(2)?, mime: row.get(3)?,
        }))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "file: attachment removed or belongs to a different conversation/provider".into())
}

/// Inherit only actual retained user attachments and saved composer selections.
/// A forged reference cannot grant access that the source did not already hold.
pub(crate) fn inherit<'a>(
    db: &Connection,
    source: &str,
    target: &str,
    snapshot: &Value,
    blocks: impl Iterator<Item = &'a Value>,
) -> Result<(), String> {
    init(db)?;
    let mut references = HashSet::new();
    for block in blocks {
        if !matches!(block["type"].as_str(), Some("image" | "document")) {
            continue;
        }
        if let Some(id) = block["source"]["file_id"].as_str() {
            let provider = block["source"]["provider"]
                .as_str()
                .unwrap_or("opencode-go");
            references.insert((id.to_string(), provider.to_string()));
        }
    }
    if let Some(chips) = snapshot["preferences"]["composer"]["chips"].as_array() {
        for chip in chips {
            if let Some(id) = chip["fileId"].as_str() {
                let provider = chip["provider"].as_str().unwrap_or("deepseek-app");
                references.insert((id.to_string(), provider.to_string()));
            }
        }
    }
    for (id, provider) in references {
        db.execute(
            "INSERT OR IGNORE INTO tao_inline_file_grants(id,thread_id,provider)
            SELECT f.id,?2,f.provider FROM tao_inline_files f WHERE f.id=?1 AND f.provider=?4
            AND (f.thread_id=?3 OR EXISTS(SELECT 1 FROM tao_inline_file_grants g
            WHERE g.id=f.id AND g.thread_id=?3 AND g.provider=f.provider))",
            params![id, target, source, provider],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn forget_thread(db: &Connection, thread: &str) -> Result<(), String> {
    init(db)?;
    db.execute(
        "DELETE FROM tao_inline_file_grants WHERE thread_id=?1",
        [thread],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn remove(db: &Connection, id: &str) -> Result<(), String> {
    init(db)?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM tao_inline_file_grants WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM tao_inline_files WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
