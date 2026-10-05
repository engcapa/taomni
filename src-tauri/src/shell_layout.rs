use crate::state::AppState;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use tauri::State;

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS shell_layout (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            layout TEXT NOT NULL
        );",
    )
}

fn load_layout(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row("SELECT layout FROM shell_layout WHERE id = 1", [], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|error| format!("Could not read workspace layout: {error}"))
}

fn save_layout(conn: &mut Connection, layout: &str, expected: Option<&str>) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(layout)
        .map_err(|error| format!("Invalid workspace layout: {error}"))?;
    if parsed.get("version").and_then(|value| value.as_u64()) != Some(2) {
        return Err("Unsupported workspace layout version".into());
    }
    // SQLite commits atomically and syncs before acknowledging the IPC. The
    // transaction also prevents an older document/process replacing a newer
    // record, including a record from a future version of the app.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not save workspace layout: {error}"))?;
    if load_layout(&tx)?.as_deref() != expected {
        return Err("SHELL_LAYOUT_CHANGED".into());
    }
    tx.execute(
        "INSERT INTO shell_layout (id, layout) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET layout = excluded.layout",
        params![layout],
    )
    .map_err(|error| format!("Could not save workspace layout: {error}"))?;
    tx.commit()
        .map_err(|error| format!("Could not commit workspace layout: {error}"))
}

#[tauri::command]
pub fn load_shell_layout(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    load_layout(&conn)
}

#[tauri::command]
pub fn save_shell_layout(
    layout: String,
    expected_layout: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|error| error.to_string())?;
    save_layout(&mut conn, &layout, expected_layout.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: &str = r#"{"version":2,"navigator":{"width":200}}"#;
    const SECOND: &str = r#"{"version":2,"navigator":{"width":232}}"#;

    #[test]
    fn acknowledged_layout_survives_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("taomni.db");
        let mut conn = Connection::open(&path).unwrap();
        init_tables(&conn).unwrap();
        assert_eq!(load_layout(&conn).unwrap(), None);
        save_layout(&mut conn, FIRST, None).unwrap();
        save_layout(&mut conn, SECOND, Some(FIRST)).unwrap();
        drop(conn);
        let reopened = Connection::open(path).unwrap();
        assert_eq!(load_layout(&reopened).unwrap().as_deref(), Some(SECOND));
    }

    #[test]
    fn stale_documents_cannot_replace_the_latest_record() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        save_layout(&mut conn, FIRST, None).unwrap();
        save_layout(&mut conn, SECOND, Some(FIRST)).unwrap();
        assert_eq!(
            save_layout(&mut conn, FIRST, Some(FIRST)).unwrap_err(),
            "SHELL_LAYOUT_CHANGED"
        );
        assert_eq!(load_layout(&conn).unwrap().as_deref(), Some(SECOND));
    }

    #[test]
    fn invalid_input_and_unacknowledged_future_records_are_preserved() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        let future = r#"{"version":999,"sentinel":"preserve"}"#;
        conn.execute("INSERT INTO shell_layout VALUES (1, ?1)", [future])
            .unwrap();
        assert!(save_layout(&mut conn, "{", Some(future)).is_err());
        assert!(save_layout(&mut conn, future, Some(future)).is_err());
        assert_eq!(
            save_layout(&mut conn, FIRST, None).unwrap_err(),
            "SHELL_LAYOUT_CHANGED"
        );
        assert_eq!(load_layout(&conn).unwrap().as_deref(), Some(future));
        // Explicit Reset can replace the record after reading its exact value.
        save_layout(&mut conn, FIRST, Some(future)).unwrap();
    }

    #[test]
    fn a_failed_commit_does_not_acknowledge_or_replace_the_record() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        save_layout(&mut conn, FIRST, None).unwrap();
        conn.execute_batch("PRAGMA query_only = ON").unwrap();
        assert!(save_layout(&mut conn, SECOND, Some(FIRST)).is_err());
        assert_eq!(load_layout(&conn).unwrap().as_deref(), Some(FIRST));
        conn.execute_batch("PRAGMA query_only = OFF").unwrap();
        save_layout(&mut conn, SECOND, Some(FIRST)).unwrap();
    }
}
