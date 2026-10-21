use crate::database::QueryResult;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

/// Event payload echoed to the frontend after CC runs a statement on the bound
/// connection, so the linked query tab can append it to a query editor (gated
/// by a frontend toggle, default on). Emitted for reads and approved writes
/// alike, on success and failure — the frontend decides whether to surface it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct SqlEcho {
    pub(super) thread_id: String,
    pub(super) sql: String,
    pub(super) ok: bool,
    pub(super) rows_affected: u64,
    pub(super) row_count: usize,
    pub(super) duration_ms: u64,
    /// True when the statement ran via `run_sql_captured` (full result spooled
    /// to a file); the frontend annotates the echoed comment accordingly.
    pub(super) captured: bool,
    pub(super) error: Option<String>,
}

/// Best-effort emit of `agent-cc-sql-echo` for a just-executed statement. A
/// failed emit must never affect the tool result, so the error is swallowed.
pub(super) fn emit_sql_echo(
    app: &AppHandle,
    thread_id: &str,
    sql: &str,
    res: &Result<QueryResult, String>,
    captured: bool,
) {
    let payload = match res {
        Ok(r) => SqlEcho {
            thread_id: thread_id.to_string(),
            sql: sql.to_string(),
            ok: true,
            rows_affected: r.rows_affected,
            row_count: r.rows.len(),
            duration_ms: r.duration_ms,
            captured,
            error: None,
        },
        Err(e) => SqlEcho {
            thread_id: thread_id.to_string(),
            sql: sql.to_string(),
            ok: false,
            rows_affected: 0,
            row_count: 0,
            duration_ms: 0,
            captured,
            error: Some(e.clone()),
        },
    };
    let _ = app.emit("agent-cc-sql-echo", payload);
}
