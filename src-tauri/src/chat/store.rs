use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatThread {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub linked_session_id: Option<String>,
    pub source: String,
    /// Claude Code session ID for --resume (v2.6).
    #[serde(default)]
    pub cc_session_id: Option<String>,
    /// Per-thread Claude Code model override ("opus" | "sonnet" | "haiku").
    /// `None` means "inherit AiConfig.cc_bridge.default_model". Baked into the
    /// child's `--model` at spawn, so changing it recycles the CC process.
    #[serde(default)]
    pub cc_model: Option<String>,
    /// Per-thread output format override: "md" | "html" | "plain".
    /// `None` means "inherit AiConfig.chat_output_format".
    #[serde(default)]
    pub output_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    pub redacted: bool,
}

pub fn init_chat_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_chat_threads (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            provider_id TEXT NOT NULL DEFAULT 'deepseek',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            linked_session_id TEXT,
            source TEXT NOT NULL DEFAULT 'drawer'
        );

        CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            redacted INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (thread_id) REFERENCES ai_chat_threads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
            ON ai_chat_messages(thread_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_threads_updated
            ON ai_chat_threads(updated_at DESC);",
    )?;

    // Idempotent column add for older installs that pre-date the v2.6 CC bridge.
    let _ = conn.execute(
        "ALTER TABLE ai_chat_threads ADD COLUMN cc_session_id TEXT",
        [],
    );
    // Idempotent column add for the per-thread chat output-format override.
    let _ = conn.execute(
        "ALTER TABLE ai_chat_threads ADD COLUMN output_format TEXT",
        [],
    );
    // Idempotent column add for the per-thread Claude Code model override.
    let _ = conn.execute(
        "ALTER TABLE ai_chat_threads ADD COLUMN cc_model TEXT",
        [],
    );
    Ok(())
}

pub fn create_thread(conn: &Connection, thread: &ChatThread) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO ai_chat_threads (id, title, provider_id, created_at, updated_at, linked_session_id, source, output_format, cc_model)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            thread.id, thread.title, thread.provider_id,
            thread.created_at, thread.updated_at,
            thread.linked_session_id, thread.source,
            thread.output_format, thread.cc_model,
        ],
    )?;
    Ok(())
}

pub fn list_threads(conn: &Connection, limit: usize) -> SqlResult<Vec<ChatThread>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, provider_id, created_at, updated_at, linked_session_id, source, cc_session_id, output_format, cc_model
         FROM ai_chat_threads ORDER BY updated_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], |row| {
        Ok(ChatThread {
            id: row.get(0)?,
            title: row.get(1)?,
            provider_id: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            linked_session_id: row.get(5)?,
            source: row.get(6)?,
            cc_session_id: row.get(7).ok(),
            output_format: row.get(8).ok(),
            cc_model: row.get(9).ok(),
        })
    })?;
    rows.collect()
}

pub fn set_cc_session_id(conn: &Connection, thread_id: &str, session_id: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE ai_chat_threads SET cc_session_id = ?1 WHERE id = ?2",
        params![session_id, thread_id],
    )?;
    Ok(())
}

pub fn delete_thread(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM ai_chat_threads WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn insert_message(conn: &Connection, msg: &ChatMessage) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO ai_chat_messages (id, thread_id, role, content, created_at, redacted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            msg.id,
            msg.thread_id,
            msg.role,
            msg.content,
            msg.created_at,
            msg.redacted as i64
        ],
    )?;
    // Update thread updated_at.
    conn.execute(
        "UPDATE ai_chat_threads SET updated_at = ?1 WHERE id = ?2",
        params![msg.created_at, msg.thread_id],
    )?;
    Ok(())
}

pub fn list_messages(conn: &Connection, thread_id: &str) -> SqlResult<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, thread_id, role, content, created_at, redacted
         FROM ai_chat_messages WHERE thread_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![thread_id], |row| {
        Ok(ChatMessage {
            id: row.get(0)?,
            thread_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
            redacted: row.get::<_, i64>(5)? != 0,
        })
    })?;
    rows.collect()
}

pub fn update_thread_title(conn: &Connection, id: &str, title: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE ai_chat_threads SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

pub fn update_thread_provider(conn: &Connection, id: &str, provider_id: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE ai_chat_threads SET provider_id = ?1 WHERE id = ?2",
        params![provider_id, id],
    )?;
    Ok(())
}

/// Set or clear the per-thread Claude Code model override.
/// `None` (or `Some("")`) clears it so the thread inherits the configured
/// `cc_bridge.default_model`.
pub fn update_thread_cc_model(
    conn: &Connection,
    id: &str,
    model: Option<&str>,
) -> SqlResult<()> {
    let normalized = model.filter(|s| !s.trim().is_empty());
    conn.execute(
        "UPDATE ai_chat_threads SET cc_model = ?1 WHERE id = ?2",
        params![normalized, id],
    )?;
    Ok(())
}

/// Set or clear the per-thread output-format override.
/// `None` (or `Some("")`) clears it so the thread inherits AiConfig.chat_output_format.
pub fn update_thread_output_format(
    conn: &Connection,
    id: &str,
    output_format: Option<&str>,
) -> SqlResult<()> {
    let normalized = output_format.filter(|s| !s.is_empty());
    conn.execute(
        "UPDATE ai_chat_threads SET output_format = ?1 WHERE id = ?2",
        params![normalized, id],
    )?;
    Ok(())
}

/// Delete every thread whose `updated_at` is older than `cutoff_ts` (Unix
/// seconds). Returns the number of threads deleted; messages are removed via
/// the FK cascade. Used by the retention sweeper.
pub fn delete_threads_older_than(conn: &Connection, cutoff_ts: i64) -> SqlResult<usize> {
    let count = conn.execute(
        "DELETE FROM ai_chat_threads WHERE updated_at < ?1",
        params![cutoff_ts],
    )?;
    Ok(count)
}
