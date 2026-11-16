//! Explicitly approved local memory, identity and skill ownership.
use super::store;
use crate::state::AppState;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tauri::State;

pub fn init(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS tao_memory_entries (
        id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,
        enabled INTEGER NOT NULL,updated_at INTEGER NOT NULL);",
    )
    .map_err(|error| error.to_string())
}

pub fn list(db: &Connection) -> Result<Vec<Value>, String> {
    init(db)?;
    let mut stmt = db.prepare("SELECT id,kind,title,content,enabled,updated_at FROM tao_memory_entries ORDER BY kind,title,id")
        .map_err(|error| error.to_string())?;
    stmt.query_map([], |row| {
        Ok(
            json!({"id":row.get::<_,String>(0)?,"kind":row.get::<_,String>(1)?,
        "title":row.get::<_,String>(2)?,"content":row.get::<_,String>(3)?,
        "enabled":row.get::<_,bool>(4)?,"updatedAt":row.get::<_,i64>(5)?}),
        )
    })
    .map_err(|error| error.to_string())?
    .collect::<Result<_, _>>()
    .map_err(|error| error.to_string())
}

pub fn save(db: &Connection, mut entry: Value, confirmed: bool) -> Result<Value, String> {
    if !confirmed {
        return Err("confirmation: memory changes require explicit approval".into());
    }
    let kind = entry["kind"]
        .as_str()
        .ok_or("memory: kind required")?
        .to_string();
    if !matches!(kind.as_str(), "memory" | "soul" | "skill") {
        return Err("memory: unsupported kind".into());
    }
    let title = entry["title"].as_str().unwrap_or("").trim().to_string();
    let content = entry["content"]
        .as_str()
        .ok_or("memory: content required")?;
    if title.is_empty() || title.len() > 256 || content.len() > 64 * 1024 {
        return Err("memory: invalid title or content length".into());
    }
    store::redact_json(&mut entry);
    let id = entry["id"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let enabled = entry["enabled"].as_bool().unwrap_or(true);
    init(db)?;
    // An identity is a single slot; changing it does not modify files in HOME.
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if kind == "soul" {
        tx.execute(
            "DELETE FROM tao_memory_entries WHERE kind='soul' AND id<>?1",
            [&id],
        )
        .map_err(|error| error.to_string())?;
    }
    let updated = store::now();
    tx.execute("INSERT INTO tao_memory_entries(id,kind,title,content,enabled,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,enabled=excluded.enabled,updated_at=excluded.updated_at",
        params![id,kind,entry["title"].as_str(),entry["content"].as_str(),enabled,updated]).map_err(|error|error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(
        json!({"id":id,"kind":kind,"title":entry["title"],"content":entry["content"],"enabled":enabled,"updatedAt":updated}),
    )
}

pub fn prompt(db: &Connection, question: &str) -> Result<String, String> {
    let entries = list(db)?;
    let mut output = String::new();
    for entry in entries.iter().filter(|entry| entry["enabled"] == true) {
        let kind = entry["kind"].as_str().unwrap_or("");
        let title = entry["title"].as_str().unwrap_or("");
        if kind == "skill" && !question.split_whitespace().any(|word| word == title) {
            continue;
        }
        let content = entry["content"].as_str().unwrap_or("");
        if output.len() + content.len() > 32 * 1024 {
            continue;
        }
        output.push_str(&format!(
            "\n<approved_local_{kind}>\n{content}\n</approved_local_{kind}>\n"
        ));
    }
    Ok(output)
}

#[tauri::command]
pub fn deepseek_app_memory_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    list(&db)
}
#[tauri::command]
pub fn deepseek_app_memory_save(
    entry: Value,
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    save(&db, entry, confirmed)
}
#[tauri::command]
pub fn deepseek_app_memory_delete(
    id: String,
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !confirmed {
        return Err("confirmation: deleting memory requires approval".into());
    }
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    init(&db)?;
    db.execute("DELETE FROM tao_memory_entries WHERE id=?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn deepseek_app_memory_export(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    list(&db)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_identity_and_skill_trigger_are_enforced() {
        let db = Connection::open_in_memory().unwrap();
        let entry = json!({"kind":"soul","title":"Identity","content":"Say hello"});
        assert!(save(&db, entry.clone(), false).is_err());
        save(&db, entry.clone(), true).unwrap();
        save(&db, entry, true).unwrap();
        assert_eq!(list(&db).unwrap().len(), 1);
        save(
            &db,
            json!({"kind":"skill","title":"/review","content":"Review carefully"}),
            true,
        )
        .unwrap();
        assert!(!prompt(&db, "hello").unwrap().contains("Review carefully"));
        assert!(
            prompt(&db, "/review file")
                .unwrap()
                .contains("Review carefully")
        );
    }
}
