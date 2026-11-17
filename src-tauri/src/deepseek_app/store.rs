//! SQLite ownership for UI snapshots and provider-native ordered message blocks.
use super::types::TaoRequest;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub fn init(conn: &Connection) -> Result<(), String> {
    crate::chat::store::init_chat_tables(conn).map_err(|error| error.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ds_app_threads (
        id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL,
        last_request TEXT, FOREIGN KEY(id) REFERENCES ai_chat_threads(id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS ds_app_messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, blocks TEXT NOT NULL,
        status TEXT NOT NULL, stop_reason TEXT, created_at INTEGER NOT NULL, position INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES ai_chat_threads(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS ds_app_messages_order ON ds_app_messages(thread_id, position);")
        .map_err(|error| error.to_string())
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 256 {
        return Err("protocol: invalid thread id".into());
    }
    Ok(())
}

pub fn save_thread(conn: &Connection, mut thread: Value) -> Result<(), String> {
    let id = thread
        .get("id")
        .and_then(Value::as_str)
        .ok_or("protocol: thread id required")?
        .to_string();
    valid_id(&id)?;
    let updated = thread
        .get("updatedAt")
        .and_then(Value::as_i64)
        .unwrap_or_else(now);
    redact_json(&mut thread);
    let title = thread
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("新 Tao 对话")
        .to_string();
    let serialized = serde_json::to_string(&thread).map_err(|error| error.to_string())?;
    if serialized.len() > 16 * 1024 * 1024 {
        return Err("protocol: conversation exceeds storage limit".into());
    }
    // Branching owns an outer transaction; participate in it so copied
    // snapshots, canonical messages and attachment grants settle together.
    let tx = conn
        .is_autocommit()
        .then(|| conn.unchecked_transaction())
        .transpose()
        .map_err(|error| error.to_string())?;
    let db = tx.as_deref().unwrap_or(conn);
    db.execute(
        "INSERT INTO ai_chat_threads (id,title,provider_id,created_at,updated_at,source)
        VALUES (?1,?2,'deepseek-app',?3,?3,'home') ON CONFLICT(id) DO UPDATE SET
        title=CASE WHEN excluded.updated_at >= updated_at THEN excluded.title ELSE title END,
        updated_at=MAX(updated_at,excluded.updated_at)",
        params![id, title, updated / 1000],
    )
    .map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO ds_app_threads(id,snapshot,updated_at) VALUES (?1,?2,?3)
        ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=excluded.updated_at
        WHERE excluded.updated_at >= ds_app_threads.updated_at",
        params![id, serialized, updated],
    )
    .map_err(|error| error.to_string())?;
    tx.map_or(Ok(()), |tx| tx.commit().map_err(|error| error.to_string()))
}

pub fn load_threads(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT snapshot FROM ds_app_threads ORDER BY updated_at DESC,id")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut snapshots: Vec<Value> = rows
        .map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect::<Result<_, String>>()?;
    drop(stmt);
    snapshots.extend(legacy_threads(conn)?);
    snapshots.sort_by(|left, right| {
        right["updatedAt"]
            .as_i64()
            .unwrap_or_default()
            .cmp(&left["updatedAt"].as_i64().unwrap_or_default())
            .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
    });
    let mut recovered = false;
    for snapshot in &snapshots {
        if let Some(id) = snapshot["id"].as_str() {
            if !super::runtime::is_active(id) {
                let changed=conn.execute("UPDATE ds_app_messages SET status='interrupted' WHERE thread_id=?1 AND status='streaming'",[id])
                    .map_err(|error|error.to_string())?;
                if changed > 0 {
                    sync_snapshot(conn, id, None)?;
                    recovered = true;
                }
            }
        }
    }
    if recovered {
        let mut statement = conn
            .prepare("SELECT snapshot FROM ds_app_threads ORDER BY updated_at DESC,id")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut recovered_snapshots: Vec<Value> = rows
            .map(|row| {
                serde_json::from_str(&row.map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<_, String>>()?;
        recovered_snapshots.extend(legacy_threads(conn)?);
        recovered_snapshots.sort_by(|left, right| {
            right["updatedAt"]
                .as_i64()
                .unwrap_or_default()
                .cmp(&left["updatedAt"].as_i64().unwrap_or_default())
        });
        return Ok(recovered_snapshots);
    }
    Ok(snapshots)
}

/// Return legacy ChatDrawer entries as read-only Tao history summaries. They
/// deliberately have no Tao messages and are never copied into ds_app_threads;
/// the host routes selection back to ChatDrawer, which owns their transcript.
fn legacy_threads(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT id,title,provider_id,created_at,updated_at,linked_session_id,source FROM ai_chat_threads WHERE provider_id <> 'deepseek-app' ORDER BY updated_at DESC,rowid DESC")
        .map_err(|error| error.to_string())?;
    stmt.query_map([], |row| {
        let created: i64 = row.get(3)?;
        let updated: i64 = row.get(4)?;
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "title": row.get::<_, String>(1)?,
            "source": "legacy",
            "legacyProvider": row.get::<_, String>(2)?,
            "createdAt": created.saturating_mul(1000),
            "updatedAt": updated.saturating_mul(1000),
            "linkedSessionId": row.get::<_, Option<String>>(5)?,
            "legacySource": row.get::<_, String>(6)?,
            "messages": [],
            "running": false,
        }))
    })
    .map_err(|error| error.to_string())?
    .map(|row| row.map_err(|error| error.to_string()))
    .collect()
}

pub fn delete_thread(conn: &Connection, id: &str) -> Result<(), String> {
    valid_id(id)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM ds_app_messages WHERE thread_id=?1", [id])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM ds_app_threads WHERE id=?1", [id])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM ai_chat_messages WHERE thread_id=?1", [id])
        .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM ai_chat_threads WHERE id=?1 AND provider_id='deepseek-app'",
        [id],
    )
    .map_err(|error| error.to_string())?;
    super::inline_files::forget_thread(&tx, id)?;
    tx.commit().map_err(|error| error.to_string())
}

pub fn clone_thread(
    conn: &Connection,
    source_id: &str,
    target_id: &str,
    through_message_index: Option<usize>,
) -> Result<Value, String> {
    valid_id(source_id)?;
    valid_id(target_id)?;
    if source_id == target_id {
        return Err("protocol: branch target must differ from source".into());
    }
    let raw: String = conn
        .query_row(
            "SELECT snapshot FROM ds_app_threads WHERE id=?1",
            [source_id],
            |r| r.get(0),
        )
        .map_err(|_| "protocol: source conversation not found")?;
    let mut snapshot: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(index) = through_message_index {
        if let Some(messages) = snapshot["messages"].as_array_mut() {
            messages.truncate(index.saturating_add(1));
        }
    }
    snapshot["id"] = Value::String(target_id.to_string());
    snapshot["source"] = Value::String("branch".into());
    snapshot["updatedAt"] = json!(now());
    let source = messages(conn, source_id)?;
    let limit = through_message_index
        .map(|index| index.saturating_add(1))
        .unwrap_or(source.len());
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    save_thread(&tx, snapshot.clone())?;
    super::inline_files::inherit(
        &tx,
        source_id,
        target_id,
        &snapshot,
        source
            .iter()
            .take(limit)
            .filter(|message| message.role == "user")
            .flat_map(|message| message.blocks.iter()),
    )?;
    for message in source.into_iter().take(limit) {
        tx.execute("INSERT INTO ds_app_messages(id,thread_id,role,blocks,status,stop_reason,created_at,position) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![
            uuid::Uuid::new_v4().to_string(), target_id, message.role,
            serde_json::to_string(&message.blocks).map_err(|e|e.to_string())?, message.status,
            message.stop_reason, message.created_at,
            tx.query_row("SELECT COALESCE(MAX(position)+1,0) FROM ds_app_messages WHERE thread_id=?1", [target_id], |r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?
        ]).map_err(|e|e.to_string())?;
    }
    sync_snapshot(&tx, target_id, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(snapshot)
}

pub fn save_request(conn: &Connection, request: &TaoRequest) -> Result<(), String> {
    let mut request = serde_json::to_value(request).map_err(|error| error.to_string())?;
    redact_json(&mut request);
    conn.execute(
        "UPDATE ds_app_threads SET last_request=?2 WHERE id=?1",
        params![
            request["threadId"].as_str(),
            serde_json::to_string(&request).map_err(|error| error.to_string())?
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn last_request(conn: &Connection, id: &str) -> Result<TaoRequest, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT last_request FROM ds_app_threads WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    serde_json::from_str(&raw.ok_or("protocol: this conversation has no request to resume")?)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub blocks: Vec<Value>,
    pub status: String,
    pub stop_reason: Option<String>,
    pub created_at: i64,
}

pub fn messages(conn: &Connection, id: &str) -> Result<Vec<Message>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,role,blocks,status,stop_reason,created_at FROM ds_app_messages
        WHERE thread_id=?1 ORDER BY position",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (id, role, blocks, status, stop_reason, created_at) =
            row.map_err(|error| error.to_string())?;
        Ok(Message {
            id,
            role,
            blocks: serde_json::from_str(&blocks).map_err(|error| error.to_string())?,
            status,
            stop_reason,
            created_at,
        })
    })
    .collect()
}

pub fn append_message(
    conn: &Connection,
    thread_id: &str,
    role: &str,
    blocks: &[Value],
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute("INSERT INTO ds_app_messages(id,thread_id,role,blocks,status,created_at,position)
        VALUES (?1,?2,?3,?4,?5,?6,COALESCE((SELECT MAX(position)+1 FROM ds_app_messages WHERE thread_id=?2),0))",
        params![id,thread_id,role,serde_json::to_string(blocks).map_err(|error|error.to_string())?,
            if role == "user" { "complete" } else { "streaming" },now()])
        .map_err(|error| error.to_string())?;
    Ok(id)
}

pub fn settle(
    conn: &Connection,
    id: &str,
    blocks: &[Value],
    status: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE ds_app_messages SET blocks=?2,status=?3,stop_reason=?4 WHERE id=?1",
        params![
            id,
            serde_json::to_string(blocks).map_err(|error| error.to_string())?,
            status,
            reason
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn remove_last_assistant(conn: &Connection, thread_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ds_app_messages WHERE id=(SELECT id FROM ds_app_messages
        WHERE thread_id=?1 AND role='assistant' ORDER BY position DESC LIMIT 1)",
        [thread_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn redact_json(value: &mut Value) {
    match value {
        Value::String(text) => *text = crate::chat::redact::redact(text).0,
        Value::Array(values) => values.iter_mut().for_each(redact_json),
        Value::Object(values) => values
            .iter_mut()
            .filter(|(key, _)| key.as_str() != "signature")
            .for_each(|(_, value)| redact_json(value)),
        _ => {}
    }
}

pub fn ensure_thread(conn: &Connection, id: &str) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ds_app_threads WHERE id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        save_thread(
            conn,
            json!({"id":id,"title":"新 Tao 对话","messages":[],"updatedAt":now(),"source":"tao"}),
        )?;
    }
    Ok(())
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn sync_snapshot(
    conn: &Connection,
    thread_id: &str,
    title: Option<&str>,
) -> Result<(), String> {
    let raw: String = conn
        .query_row(
            "SELECT snapshot FROM ds_app_threads WHERE id=?1",
            [thread_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut snapshot: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let history = messages(conn, thread_id)?;
    snapshot["messages"]=json!(history.iter().map(|message|json!({"id":message.id,"role":message.role,
        "text":text(&message.blocks),"blocks":message.blocks.iter().enumerate().filter(|(_,block)|!block.is_null())
            .map(|(index,block)|super::protocol::ui_block(block,index)).collect::<Vec<_>>(),
        "createdAt":message.created_at,"status":message.status,"stopReason":message.stop_reason})).collect::<Vec<_>>());
    snapshot["running"] = json!(false);
    snapshot["updatedAt"] = json!(now());
    if let Some(title) = title {
        if !title.trim().is_empty() {
            snapshot["title"] = json!(title);
        }
    }
    save_thread(conn, snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_preserve_threads_and_reject_stale_updates_after_reopen() {
        let path = std::env::temp_dir().join(format!("tao-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            init(&conn).unwrap();
            save_thread(&conn,json!({"id":"one","title":"New","updatedAt":20,"messages":[],"preferences":{"model":"pro"}})).unwrap();
            save_thread(
                &conn,
                json!({"id":"two","title":"Other","updatedAt":10,"messages":[]}),
            )
            .unwrap();
            crate::chat::store::create_thread(
                &conn,
                &crate::chat::store::ChatThread {
                    id: "legacy-one".into(),
                    title: "Legacy ChatDrawer".into(),
                    provider_id: "deepseek".into(),
                    created_at: 5,
                    updated_at: 30,
                    linked_session_id: None,
                    source: "drawer".into(),
                    mode: "chat".into(),
                    cc_session_id: None,
                    acp_session_id: None,
                    cc_model: None,
                    llm_model: None,
                    output_format: None,
                },
            )
            .unwrap();
            save_thread(
                &conn,
                json!({"id":"one","title":"Stale","updatedAt":1,"messages":[]}),
            )
            .unwrap();
            append_message(&conn, "one", "user", &[json!({"type":"text","text":"Q1"})]).unwrap();
            append_message(
                &conn,
                "one",
                "assistant",
                &[json!({"type":"text","text":"A1"})],
            )
            .unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            init(&conn).unwrap();
            let threads = load_threads(&conn).unwrap();
            assert_eq!(threads.len(), 3);
            let legacy = threads
                .iter()
                .find(|thread| thread["source"] == "legacy")
                .unwrap();
            assert_eq!(legacy["title"], "Legacy ChatDrawer");
            let tao = threads.iter().find(|thread| thread["id"] == "one").unwrap();
            assert_eq!(tao["title"], "New");
            assert_eq!(tao["preferences"]["model"], "pro");
            let history = messages(&conn, "one").unwrap();
            assert_eq!(
                history.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
                vec!["user", "assistant"]
            );
            delete_thread(&conn, "one").unwrap();
            assert_eq!(load_threads(&conn).unwrap().len(), 2);
        }
        std::fs::remove_file(path).unwrap();
    }
}
