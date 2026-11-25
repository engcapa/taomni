//! Bounded ZIP v3 interchange. Import creates fresh identities transactionally.
use super::store;
use crate::state::AppState;
use serde_json::{Value, json};
use std::io::{Cursor, Read, Write};
use tauri::State;

const LIMIT: usize = 32 * 1024 * 1024;

#[tauri::command]
pub fn deepseek_app_export_archive(
    thread_ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    store::init(&db)?;
    let threads = store::load_threads(&db)?
        .into_iter()
        .filter(|thread| {
            thread_ids.as_ref().is_none_or(|ids| {
                thread["id"]
                    .as_str()
                    .is_some_and(|id| ids.iter().any(|value| value == id))
            })
        })
        .collect::<Vec<_>>();
    encode(&threads)
}

#[tauri::command]
pub fn deepseek_app_import_archive(
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let threads = decode(bytes)?;
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    store::init(&db)?;
    import(&db, threads)
}

fn encode(threads: &[Value]) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            "conversations.json",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|e| e.to_string())?;
    let content = serde_json::to_vec(&json!({"export_format_version":3,"conversations":threads}))
        .map_err(|e| e.to_string())?;
    if content.len() > LIMIT {
        return Err("archive: selected conversations exceed 32 MiB".into());
    }
    archive.write_all(&content).map_err(|e| e.to_string())?;
    Ok(archive.finish().map_err(|e| e.to_string())?.into_inner())
}

fn decode(bytes: Vec<u8>) -> Result<Vec<Value>, String> {
    if bytes.len() > LIMIT {
        return Err("archive: ZIP exceeds 32 MiB".into());
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "archive: invalid ZIP")?;
    if archive.len() > 1000 {
        return Err("archive: ZIP has too many entries".into());
    }
    let mut total = 0u64;
    let mut candidates = Vec::new();
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|_| "archive: unreadable ZIP entry")?;
        total = total.saturating_add(file.size());
        if total > LIMIT as u64 {
            return Err("archive: expanded ZIP exceeds 32 MiB".into());
        }
        if file.enclosed_name().is_none() {
            return Err("archive: unsafe ZIP entry path".into());
        }
        if file.name().ends_with(".json") {
            candidates.push(index);
        }
    }
    for index in candidates {
        let mut file = archive
            .by_index(index)
            .map_err(|_| "archive: unreadable JSON entry")?;
        let mut data = String::new();
        file.read_to_string(&mut data)
            .map_err(|_| "archive: invalid UTF-8 JSON")?;
        let value: Value = serde_json::from_str(&data).map_err(|_| "archive: invalid JSON")?;
        if let Some(version) = value.get("export_format_version") {
            if version.as_u64() != Some(3) {
                return Err("archive: only export format version 3 is supported".into());
            }
            let conversations = value
                .get("conversations")
                .or_else(|| value.get("threads"))
                .and_then(Value::as_array)
                .ok_or("archive: conversations missing")?;
            if conversations.len() > 1000 {
                return Err("archive: too many conversations".into());
            }
            return conversations.iter().map(normalize).collect();
        }
    }
    Err("archive: ZIP does not contain a version 3 conversation manifest".into())
}

fn normalize(value: &Value) -> Result<Value, String> {
    let mut thread = value.clone();
    let object = thread
        .as_object_mut()
        .ok_or("archive: conversation must be an object")?;
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Imported Tao conversation")
        .to_string();
    object.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
    object.insert("title".into(), json!(title));
    object.insert("source".into(), json!("imported"));
    object.insert("running".into(), json!(false));
    object.insert("updatedAt".into(), json!(store::now()));
    let messages = object
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .ok_or("archive: messages missing")?;
    for message in messages {
        let message = message.as_object_mut().ok_or("archive: invalid message")?;
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or("archive: message role missing")?;
        if !matches!(role, "user" | "assistant") {
            return Err("archive: unsupported message role".into());
        }
        message.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
        if !message.contains_key("text") {
            let text = message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            message.insert("text".into(), json!(text));
        }
        if !message.contains_key("blocks") {
            let text = message["text"].clone();
            message.insert("blocks".into(), json!([{"type":"text","text":text}]));
        }
        message
            .entry("createdAt")
            .or_insert_with(|| json!(store::now()));
    }
    store::redact_json(&mut thread);
    Ok(thread)
}

fn import(conn: &rusqlite::Connection, threads: Vec<Value>) -> Result<Value, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for thread in &threads {
        // save_thread owns its own transaction, so insert equivalent snapshot
        // rows here inside this single archive transaction.
        let id = thread["id"].as_str().ok_or("archive: thread id missing")?;
        tx.execute(
            "INSERT INTO ai_chat_threads(id,title,provider_id,created_at,updated_at,source)
            VALUES(?1,?2,'deepseek-app',?3,?3,'home')",
            rusqlite::params![id, thread["title"].as_str(), store::now() / 1000],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO ds_app_threads(id,snapshot,updated_at) VALUES(?1,?2,?3)",
            rusqlite::params![id, thread.to_string(), store::now()],
        )
        .map_err(|e| e.to_string())?;
        for message in thread["messages"]
            .as_array()
            .ok_or("archive: messages missing")?
        {
            let role = message["role"].as_str().unwrap_or("user");
            let blocks = message["blocks"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|block| {
                    block
                        .get("raw")
                        .cloned()
                        .unwrap_or_else(|| json!({"type":block["type"],"text":block["text"]}))
                })
                .collect::<Vec<_>>();
            let message_id = store::append_message(&tx, id, role, &blocks)?;
            store::settle(&tx, &message_id, &blocks, "complete", Some("end_turn"))?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"count":threads.len(),"threads":threads}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_import_creates_fresh_ids_and_preserves_existing_data() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        store::init(&conn).unwrap();
        store::ensure_thread(&conn, "existing").unwrap();
        let bytes=encode(&[json!({"id":"old","title":"Title","messages":[{"id":"u","role":"user","text":"Q","blocks":[]}]})]).unwrap();
        let decoded = decode(bytes).unwrap();
        assert_ne!(decoded[0]["id"], "old");
        assert_eq!(import(&conn, decoded).unwrap()["count"], 1);
        assert_eq!(store::load_threads(&conn).unwrap().len(), 2);
    }
}
