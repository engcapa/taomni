//! Local-only redacted FTS index. Source snapshots are synchronized together so
//! deletions and source switches cannot leave stale private search results.
use crate::state::AppState;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tauri::State;

const SOURCES: [&str; 7] = [
    "commands", "sql", "queries", "sessions", "notes", "tao", "legacy",
];

fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ds_app_search_sources(source TEXT PRIMARY KEY,enabled INTEGER NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS ds_app_search USING fts5(source UNINDEXED,ref UNINDEXED,title,body,
        host UNINDEXED,ts UNINDEXED,use_count UNINDEXED, tokenize='trigram');")
        .map_err(|error|error.to_string())
}

pub fn sources(conn: &Connection) -> Result<BTreeMap<String, bool>, String> {
    init(conn)?;
    let mut result: S = SOURCES
        .iter()
        .map(|source| (source.to_string(), true))
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
type S = BTreeMap<String, bool>;

#[tauri::command]
pub fn deepseek_app_search_sources(
    state: State<'_, AppState>,
) -> Result<BTreeMap<String, bool>, String> {
    let db = state.db.lock().map_err(|_| "database unavailable")?;
    sources(&db)
}

#[tauri::command]
pub fn deepseek_app_set_search_sources(
    sources: BTreeMap<String, bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "database unavailable")?;
    init(&db)?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    for (source, enabled) in sources {
        if !SOURCES.contains(&source.as_str()) {
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
pub fn deepseek_app_search(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let notes = {
        let db = state
            .notes_db
            .lock()
            .map_err(|_| "notes database unavailable")?;
        collect(
            &db,
            "SELECT id,title,body,'',updated_at,1 FROM notes WHERE archived_at IS NULL",
        )?
    };
    let db = state.db.lock().map_err(|_| "database unavailable")?;
    init(&db)?;
    synchronize(&db, &notes)?;
    search(&db, &query)
}

struct Entry {
    reference: String,
    title: String,
    body: String,
    host: String,
    ts: i64,
    uses: i64,
}

fn collect(conn: &Connection, sql: &str) -> Result<Vec<Entry>, String> {
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(error) if error.to_string().contains("no such table") => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    stmt.query_map([], |row| {
        Ok(Entry {
            reference: row.get::<_, String>(0)?,
            title: row.get(1)?,
            body: row.get(2)?,
            host: row.get(3)?,
            ts: row.get(4)?,
            uses: row.get(5)?,
        })
    })
    .map_err(|e| e.to_string())?
    .map(|row| row.map_err(|e| e.to_string()))
    .collect()
}

fn synchronize(conn: &Connection, notes: &[Entry]) -> Result<(), String> {
    let enabled = sources(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM ds_app_search", [])
        .map_err(|e| e.to_string())?;
    let queries = [
        (
            "commands",
            "SELECT CAST(id AS TEXT),command,command,host_key,last_used_at,use_count FROM command_history ORDER BY last_used_at DESC LIMIT 10000",
        ),
        (
            "sql",
            "SELECT id,substr(sql_content,1,120),sql_content,host,started_at,1 FROM sql_history ORDER BY started_at DESC LIMIT 10000",
        ),
        (
            "queries",
            "SELECT id,name,content,'',updated_at,1 FROM sql_queries WHERE archived_at IS NULL",
        ),
        (
            "sessions",
            "SELECT id,name,name || ' ' || host,host,COALESCE(last_connected_at,updated_at),1 FROM sessions",
        ),
        (
            "tao",
            "SELECT id,title,snapshot,'',updated_at,1 FROM ds_app_threads",
        ),
        (
            "legacy",
            "SELECT m.id,t.title,m.content,'',m.created_at,1 FROM ai_chat_messages m JOIN ai_chat_threads t ON t.id=m.thread_id WHERE t.provider_id<>'deepseek-app' ORDER BY m.created_at DESC LIMIT 10000",
        ),
    ];
    for (source, sql) in queries {
        if enabled.get(source) != Some(&true) {
            continue;
        }
        for entry in collect(&tx, sql)? {
            insert(&tx, source, &entry)?;
        }
    }
    if enabled.get("notes") == Some(&true) {
        for entry in notes {
            insert(&tx, "notes", entry)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

fn insert(conn: &Connection, source: &str, entry: &Entry) -> Result<(), String> {
    let (title, _) = crate::chat::redact::redact(&entry.title);
    let (body, _) = crate::chat::redact::redact(&entry.body);
    let (host, _) = crate::chat::redact::redact(&entry.host);
    conn.execute("INSERT INTO ds_app_search(source,ref,title,body,host,ts,use_count) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![source,entry.reference,title,body,host,entry.ts,entry.uses]).map_err(|e|e.to_string())?;
    Ok(())
}

fn search(conn: &Connection, query: &str) -> Result<Vec<Value>, String> {
    let mut source = None;
    let mut host = None;
    let mut since = 0i64;
    let mut terms = Vec::new();
    for term in query.split_whitespace() {
        if let Some(value) = term.strip_prefix("source:") {
            source = Some(value.to_string());
        } else if let Some(value) = term.strip_prefix("host:") {
            host = Some(value.to_string());
        } else if let Some(value) = term.strip_prefix("since:") {
            since = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp())
                .unwrap_or(0);
        } else {
            terms.push(term);
        }
    }
    let term = terms.join(" ");
    if term.trim().is_empty() {
        return Ok(Vec::new());
    }
    let short = term.chars().count() < 3;
    let fts = format!("\"{}\"", term.replace('"', "\"\""));
    let pattern = format!(
        "%{}%",
        term.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let predicate = if short {
        "(title LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\')"
    } else {
        "ds_app_search MATCH ?1"
    };
    // SQLite treats an integer ORDER BY term as a selected-column position.
    // The short-query fallback has no FTS score and must sort directly by its
    // time/use tie breakers rather than using the invalid column position 0.
    let rank = if short { "" } else { "bm25(ds_app_search)," };
    let sql=format!("SELECT source,ref,title,body,host,CAST(ts AS INTEGER),CAST(use_count AS INTEGER) FROM ds_app_search WHERE {predicate}
        AND (?2 IS NULL OR source=?2) AND (?3 IS NULL OR host LIKE '%'||?3||'%') AND CAST(ts AS INTEGER)>=?4
        ORDER BY {rank}CAST(ts AS INTEGER) DESC,CAST(use_count AS INTEGER) DESC LIMIT 20");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    stmt.query_map(params![if short{pattern}else{fts},source,host,since],|row|{
        let source:String=row.get(0)?;let reference:String=row.get(1)?;let body:String=row.get(3)?;
        Ok(json!({"id":format!("{source}:{reference}"),"source":source,"ref":reference,"title":row.get::<_,String>(2)?,
            "body":body.chars().take(800).collect::<String>(),"host":row.get::<_,String>(4)?,"ts":row.get::<_,i64>(5)?,
            "useCount":row.get::<_,i64>(6)?,"exactMatchFallback":short}))
    }).map_err(|e|e.to_string())?.map(|row|row.map_err(|e|e.to_string())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fts_and_short_query_preserve_redaction_filters_and_deletions() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        insert(
            &conn,
            "commands",
            &Entry {
                reference: "one".into(),
                title: "deploy".into(),
                body: "deploy api_key=hidden".into(),
                host: "u80".into(),
                ts: 20,
                uses: 2,
            },
        )
        .unwrap();
        insert(
            &conn,
            "notes",
            &Entry {
                reference: "two".into(),
                title: "你好".into(),
                body: "你好开发".into(),
                host: "".into(),
                ts: 30,
                uses: 1,
            },
        )
        .unwrap();
        let rows = search(&conn, "deploy source:commands host:u80").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0]["body"].as_str().unwrap().contains("hidden"));
        assert_eq!(
            search(&conn, "你好").unwrap()[0]["exactMatchFallback"],
            true
        );
        conn.execute("DELETE FROM ds_app_search WHERE source='commands'", [])
            .unwrap();
        assert!(search(&conn, "deploy").unwrap().is_empty());
    }
}
