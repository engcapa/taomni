//! Read-only L1 metadata and redacted L2 text. No options_json, Vault or row data.
use rusqlite::Connection;
use serde_json::Value;

pub struct Entry {
    pub source: String,
    pub reference: String,
    pub title: String,
    pub body: String,
    pub host: String,
    pub ts: i64,
    pub uses: i64,
}

pub fn collect(conn: &Connection, source: &str, sql: &str) -> Result<Vec<Entry>, String> {
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message.starts_with("no such table:") =>
        {
            return Ok(Vec::new());
        }
        Err(error) => return Err(format!("search {source}: {error}")),
    };
    stmt.query_map([], |row| {
        let ts: i64 = row.get(4)?;
        Ok(Entry {
            source: source.into(),
            reference: row.get(0)?,
            title: row.get(1)?,
            body: row.get(2)?,
            host: row.get(3)?,
            ts: if ts > 0 && ts < 100_000_000_000 {
                ts.saturating_mul(1000)
            } else {
                ts
            },
            uses: row.get(5)?,
        })
    })
    .map_err(|e| e.to_string())?
    .map(|row| row.map_err(|e| format!("search {source}: {e}")))
    .collect()
}

pub const QUERIES: &[(&str, &str)] = &[
    (
        "commands",
        "SELECT CAST(id AS TEXT),substr(command,1,120),command,host_key,last_used_at,use_count FROM command_history ORDER BY last_used_at DESC LIMIT 10000",
    ),
    (
        "sql",
        "SELECT id,substr(sql_content,1,120),sql_content||' engine:'||engine||' database:'||COALESCE(database_name,'')||' schema:'||COALESCE(schema_name,'')||' error:'||COALESCE(error,'')||' duration_ms:'||COALESCE(duration_ms,0),host,started_at,1 FROM sql_history ORDER BY started_at DESC LIMIT 10000",
    ),
    (
        "queries",
        "SELECT id,name,content||' engine:'||engine||' database:'||COALESCE(database_name,'')||' '||COALESCE(remarks,''),'',updated_at,1 FROM sql_queries WHERE archived_at IS NULL",
    ),
    (
        "bookmarks",
        "SELECT id,name,sql_content||' engine:'||engine||' database:'||COALESCE(database_name,'')||' '||COALESCE(remarks,''),'',updated_at,1 FROM sql_bookmarks",
    ),
    (
        "sessions",
        "SELECT id,name,'name:'||name||' protocol:'||session_type||' host:'||host||' port:'||port||' username:'||COALESCE(username,'')||' group:'||COALESCE(group_path,''),host,COALESCE(last_connected_at,updated_at),1 FROM sessions",
    ),
    (
        "groups",
        "SELECT id,name,'group:'||name||' parent:'||COALESCE(parent_id,''),'',0,1 FROM session_groups",
    ),
    (
        "legacy",
        "SELECT m.id,t.title,m.content,'',m.created_at,1 FROM ai_chat_messages m JOIN ai_chat_threads t ON t.id=m.thread_id WHERE t.source<>'home' AND m.role IN ('user','assistant') ORDER BY m.created_at DESC LIMIT 10000",
    ),
    (
        "memory",
        "SELECT id,title,kind||' '||content,'',updated_at,1 FROM tao_memory_entries WHERE enabled=1",
    ),
    (
        "voice",
        "SELECT CAST(id AS TEXT),'语音记录',COALESCE(transcript,'')||' '||COALESCE(command,'')||' outcome:'||outcome,'',created_at,1 FROM voice_audit ORDER BY created_at DESC LIMIT 1000",
    ),
];

pub fn tao(conn: &Connection) -> Result<Vec<Entry>, String> {
    let snapshots = collect(
        conn,
        "tao",
        "SELECT id,'Tao',snapshot,'',updated_at,1 FROM ds_app_threads",
    )?;
    let mut entries = Vec::new();
    for snapshot in snapshots {
        let value: Value = serde_json::from_str(&snapshot.body)
            .map_err(|_| "search tao: invalid conversation snapshot")?;
        // Index visible conversation text only. Drafts, thinking, raw protocol,
        // attachment paths, binding IDs and provider settings are not prose.
        if let Some(messages) = value["messages"].as_array() {
            for (index, message) in messages.iter().enumerate() {
                let text = message["text"].as_str().unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                entries.push(Entry {
                    source: "tao".into(),
                    reference: format!("{}:{index}", snapshot.reference),
                    title: value["title"].as_str().unwrap_or("Tao").into(),
                    body: text.into(),
                    host: String::new(),
                    ts: snapshot.ts,
                    uses: 1,
                });
            }
        }
    }
    Ok(entries)
}

pub fn capability_entries() -> Vec<Entry> {
    super::super::agent_prompt::capabilities()
        .lines()
        .enumerate()
        .map(|(index, line)| Entry {
            source: "capabilities".into(),
            reference: format!("feature-{index}"),
            title: line.split(':').next().unwrap_or("Taomni").into(),
            body: line.into(),
            host: String::new(),
            ts: 0,
            uses: 0,
        })
        .collect()
}
