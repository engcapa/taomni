use rusqlite::{Connection, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbHistoryEntry {
    pub id: String,
    pub saved_session_id: Option<String>,
    pub engine: String,
    pub host: String,
    pub port: i64,
    pub catalog: Option<String>,
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub sql_content: String,
    pub started_at: i64,
    pub duration_ms: Option<i64>,
    pub rows_affected: Option<i64>,
    pub row_count: Option<i64>,
    pub has_result_set: bool,
    pub error: Option<String>,
    pub created_at: i64,
    pub panel_id: Option<String>,
    pub tab_name: Option<String>,
}

fn row_to_history(row: &rusqlite::Row<'_>) -> SqlResult<DbHistoryEntry> {
    Ok(DbHistoryEntry {
        id: row.get(0)?,
        saved_session_id: row.get(1)?,
        engine: row.get(2)?,
        host: row.get(3)?,
        port: row.get(4)?,
        catalog: row.get(5)?,
        database_name: row.get(6)?,
        schema_name: row.get(7)?,
        sql_content: row.get(8)?,
        started_at: row.get(9)?,
        duration_ms: row.get(10)?,
        rows_affected: row.get(11)?,
        row_count: row.get(12)?,
        has_result_set: row.get::<_, i64>(13)? != 0,
        error: row.get(14)?,
        created_at: row.get(15)?,
        panel_id: row.get(16)?,
        tab_name: row.get(17)?,
    })
}

pub fn init_history_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sql_history (
            id TEXT PRIMARY KEY,
            saved_session_id TEXT,
            engine TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            catalog TEXT,
            database_name TEXT,
            schema_name TEXT,
            sql_content TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            duration_ms INTEGER,
            rows_affected INTEGER,
            row_count INTEGER,
            has_result_set INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at INTEGER NOT NULL,
            panel_id TEXT,
            tab_name TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sql_history_session_time
            ON sql_history(saved_session_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sql_history_engine_time
            ON sql_history(engine, started_at DESC);",
    )?;
    let columns = {
        let mut stmt = conn.prepare("PRAGMA table_info(sql_history)")?;
        stmt.query_map([], |row| row.get::<_, String>(1))?
            .collect::<SqlResult<Vec<_>>>()?
    };
    if !columns.iter().any(|column| column == "panel_id") {
        conn.execute("ALTER TABLE sql_history ADD COLUMN panel_id TEXT", [])?;
    }
    if !columns.iter().any(|column| column == "tab_name") {
        conn.execute("ALTER TABLE sql_history ADD COLUMN tab_name TEXT", [])?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sql_history_session_panel
            ON sql_history(saved_session_id, panel_id)",
        [],
    )?;
    Ok(())
}

pub fn append_history(conn: &Connection, entry: &DbHistoryEntry) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sql_history
         (id, saved_session_id, engine, host, port, catalog, database_name, schema_name,
          sql_content, started_at, duration_ms, rows_affected, row_count, has_result_set,
          error, created_at, panel_id, tab_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            entry.id,
            entry.saved_session_id,
            entry.engine,
            entry.host,
            entry.port,
            entry.catalog,
            entry.database_name,
            entry.schema_name,
            entry.sql_content,
            entry.started_at,
            entry.duration_ms,
            entry.rows_affected,
            entry.row_count,
            if entry.has_result_set { 1 } else { 0 },
            entry.error,
            entry.created_at,
            entry.panel_id,
            entry.tab_name,
        ],
    )?;
    Ok(())
}

pub fn list_history(
    conn: &Connection,
    saved_session_id: Option<&str>,
    engine: Option<&str>,
    limit: i64,
) -> SqlResult<Vec<DbHistoryEntry>> {
    let capped = limit.clamp(1, 1000);
    let select = "SELECT id, saved_session_id, engine, host, port, catalog, database_name,
                         schema_name, sql_content, started_at, duration_ms, rows_affected,
                         row_count, has_result_set, error, created_at, panel_id, tab_name
                  FROM sql_history";
    let order = " ORDER BY started_at DESC, created_at DESC LIMIT ?";
    let rows = if let (Some(session_id), Some(engine)) = (saved_session_id, engine) {
        let mut stmt = conn.prepare(&format!(
            "{select} WHERE saved_session_id = ? AND engine = ? {order}"
        ))?;
        let rows = stmt
            .query_map(params![session_id, engine, capped], row_to_history)?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    } else if let Some(session_id) = saved_session_id {
        let mut stmt = conn.prepare(&format!("{select} WHERE saved_session_id = ? {order}"))?;
        let rows = stmt
            .query_map(params![session_id, capped], row_to_history)?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    } else if let Some(engine) = engine {
        let mut stmt = conn.prepare(&format!("{select} WHERE engine = ? {order}"))?;
        let rows = stmt
            .query_map(params![engine, capped], row_to_history)?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    } else {
        let mut stmt = conn.prepare(&format!("{select}{order}"))?;
        let rows = stmt
            .query_map(params![capped], row_to_history)?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    };
    Ok(rows)
}

pub fn update_history_tab_name(
    conn: &Connection,
    saved_session_id: &str,
    panel_id: &str,
    tab_name: Option<&str>,
) -> SqlResult<usize> {
    conn.execute(
        "UPDATE sql_history SET tab_name = ?3
         WHERE saved_session_id = ?1 AND panel_id = ?2",
        params![saved_session_id, panel_id, tab_name],
    )
}

pub fn delete_history(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM sql_history WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear_history(conn: &Connection, saved_session_id: Option<&str>) -> SqlResult<()> {
    if let Some(session_id) = saved_session_id {
        conn.execute(
            "DELETE FROM sql_history WHERE saved_session_id = ?1",
            params![session_id],
        )?;
    } else {
        conn.execute("DELETE FROM sql_history", [])?;
    }
    Ok(())
}

#[tauri::command]
pub async fn db_append_history(
    entry: DbHistoryEntry,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    append_history(&db, &entry).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_list_history(
    saved_session_id: Option<String>,
    engine: Option<String>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<DbHistoryEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    list_history(
        &db,
        saved_session_id.as_deref(),
        engine.as_deref(),
        limit.unwrap_or(200),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_delete_history(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    delete_history(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_clear_history(
    saved_session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    clear_history(&db, saved_session_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_update_history_tab_name(
    saved_session_id: String,
    panel_id: String,
    tab_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    update_history_tab_name(&db, &saved_session_id, &panel_id, tab_name.as_deref())
        .map(|changed| changed as i64)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_history_tables(&conn).unwrap();
        conn
    }

    fn entry(id: &str, session: &str, started_at: i64) -> DbHistoryEntry {
        DbHistoryEntry {
            id: id.to_string(),
            saved_session_id: Some(session.to_string()),
            engine: "PostgreSQL".to_string(),
            host: "localhost".to_string(),
            port: 5432,
            catalog: None,
            database_name: Some("app".to_string()),
            schema_name: Some("public".to_string()),
            sql_content: format!("select {started_at}"),
            started_at,
            duration_ms: Some(12),
            rows_affected: Some(0),
            row_count: Some(1),
            has_result_set: true,
            error: None,
            created_at: started_at,
            panel_id: None,
            tab_name: None,
        }
    }

    #[test]
    fn lists_history_by_session_newest_first() {
        let conn = memory_db();
        append_history(&conn, &entry("old", "s1", 10)).unwrap();
        append_history(&conn, &entry("new", "s1", 20)).unwrap();
        append_history(&conn, &entry("other", "s2", 30)).unwrap();

        let rows = list_history(&conn, Some("s1"), None, 10).unwrap();

        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["new", "old"]
        );
    }

    #[test]
    fn list_history_can_filter_session_and_engine() {
        let conn = memory_db();
        let mut postgres = entry("postgres", "s1", 10);
        postgres.engine = "PostgreSQL".to_string();
        let mut mysql = entry("mysql", "s1", 20);
        mysql.engine = "MySQL".to_string();
        append_history(&conn, &postgres).unwrap();
        append_history(&conn, &mysql).unwrap();

        let rows = list_history(&conn, Some("s1"), Some("PostgreSQL"), 10).unwrap();

        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["postgres"]
        );
    }

    #[test]
    fn clear_history_can_scope_to_one_session() {
        let conn = memory_db();
        append_history(&conn, &entry("one", "s1", 10)).unwrap();
        append_history(&conn, &entry("two", "s2", 20)).unwrap();

        clear_history(&conn, Some("s1")).unwrap();

        let rows = list_history(&conn, None, None, 10).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["two"]
        );
    }

    #[test]
    fn appends_and_lists_history_tab_names() {
        let conn = memory_db();
        let mut named = entry("named", "s1", 10);
        named.panel_id = Some("panel-1".to_string());
        named.tab_name = Some("订单巡检".to_string());
        append_history(&conn, &named).unwrap();
        append_history(&conn, &entry("plain", "s1", 20)).unwrap();

        let rows = list_history(&conn, Some("s1"), None, 10).unwrap();

        assert_eq!(rows[0].panel_id, None);
        assert_eq!(rows[0].tab_name, None);
        assert_eq!(rows[1].panel_id.as_deref(), Some("panel-1"));
        assert_eq!(rows[1].tab_name.as_deref(), Some("订单巡检"));
    }

    #[test]
    fn updates_tab_names_for_session_panel_only() {
        let conn = memory_db();
        let mut first = entry("first", "s1", 10);
        first.panel_id = Some("panel-1".to_string());
        first.tab_name = Some("旧名称".to_string());
        let mut second = entry("second", "s1", 20);
        second.panel_id = Some("panel-2".to_string());
        let mut other_session = entry("other", "s2", 30);
        other_session.panel_id = Some("panel-1".to_string());
        append_history(&conn, &first).unwrap();
        append_history(&conn, &second).unwrap();
        append_history(&conn, &other_session).unwrap();

        let changed =
            update_history_tab_name(&conn, "s1", "panel-1", Some("订单巡检")).unwrap();
        assert_eq!(changed, 1);

        let rows = list_history(&conn, None, None, 10).unwrap();
        let by_id = |id: &str| rows.iter().find(|row| row.id == id).unwrap();
        assert_eq!(by_id("first").tab_name.as_deref(), Some("订单巡检"));
        assert_eq!(by_id("second").tab_name, None);
        assert_eq!(by_id("other").tab_name, None);

        let changed = update_history_tab_name(&conn, "s1", "panel-1", None).unwrap();
        assert_eq!(changed, 1);
        let rows = list_history(&conn, None, None, 10).unwrap();
        assert!(rows.iter().all(|row| row.tab_name.is_none()));
    }

    #[test]
    fn adds_tab_name_columns_to_existing_history_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sql_history (
                id TEXT PRIMARY KEY,
                saved_session_id TEXT,
                engine TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                catalog TEXT,
                database_name TEXT,
                schema_name TEXT,
                sql_content TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                duration_ms INTEGER,
                rows_affected INTEGER,
                row_count INTEGER,
                has_result_set INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        init_history_tables(&conn).unwrap();
        init_history_tables(&conn).unwrap();

        let columns = conn
            .prepare("PRAGMA table_info(sql_history)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<SqlResult<Vec<_>>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "panel_id"));
        assert!(columns.iter().any(|column| column == "tab_name"));
    }
}
