//! Confirmed Tao action execution. Every completed result comes from the real
//! executor; an approval alone never marks an action successful.
use super::{
    actions::{self, ActionKind, ActionProposal},
    runtime::RunGuard,
    store,
};
use crate::{
    agent::{capture, capture::exec_b},
    state::AppState,
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tauri::State;
use tokio::sync::Notify;

fn init_undo(db: &rusqlite::Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS tao_action_undo(action_id TEXT PRIMARY KEY,kind TEXT NOT NULL,path TEXT,old_content BLOB,new_hash TEXT,note_id TEXT,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS tao_action_results(action_id TEXT PRIMARY KEY,status TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL);")
        .map_err(|e| e.to_string())
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub thread_id: String,
    pub action: ActionProposal,
    pub confirmed: bool,
    #[serde(default)]
    pub confirmed_level: Option<String>,
}

fn workspace(action: &ActionProposal) -> Option<PathBuf> {
    action
        .target
        .as_ref()
        .and_then(|t| t.workspace_path.clone())
        .map(PathBuf::from)
}
fn safe_path(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|_| "action: workspace is unavailable")?;
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let mut parent = if candidate.exists() {
        candidate.clone()
    } else {
        candidate.parent().unwrap_or(&candidate).to_path_buf()
    };
    while !parent.exists() {
        let next = parent
            .parent()
            .ok_or("action: target parent is unavailable")?;
        parent = next.to_path_buf();
    }
    let canonical_parent =
        std::fs::canonicalize(parent).map_err(|_| "action: target parent is unavailable")?;
    if !canonical_parent.starts_with(&root) {
        return Err("action: target escapes workspace".into());
    }
    Ok(candidate)
}
fn output_value(
    id: &str,
    status: &str,
    started: Instant,
    output: String,
    exit: Option<i32>,
) -> Value {
    json!({"actionId":id,"status":status,"durationMs":started.elapsed().as_millis(),"output":output,"exitCode":exit})
}

#[tauri::command]
pub async fn deepseek_app_execute_action(
    request: ActionRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !request.confirmed {
        return Err("confirmation: action requires explicit approval".into());
    }
    let bound_workspace = workspace(&request.action);
    let level = actions::validate_action(
        &request.action,
        None,
        bound_workspace.as_deref().and_then(|path| path.to_str()),
    )?;
    if level == "L2" && request.confirmed_level.as_deref() != Some("L2") {
        return Err("confirmation: dangerous action requires L2 approval".into());
    }
    let started = Instant::now();
    let id = request.action.id.clone();
    {
        let db = state.db.lock().map_err(|_| "database unavailable")?;
        init_undo(&db)?;
        let prior: Option<String> = db
            .query_row(
                "SELECT result FROM tao_action_results WHERE action_id=?1 AND status='completed'",
                [&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(prior) = prior {
            return serde_json::from_str(&prior).map_err(|e| e.to_string());
        }
    }
    let run = RunGuard::begin(&format!("action:{}:{}", request.thread_id, id))?;
    let result = match request.action.kind {
        ActionKind::WriteFile => {
            let (path, old, hash) = write_file(&request.action)?;
            let db = state.db.lock().map_err(|_| "database unavailable")?;
            init_undo(&db)?;
            db.execute("INSERT OR REPLACE INTO tao_action_undo(action_id,kind,path,old_content,new_hash,created_at) VALUES(?1,'file',?2,?3,?4,?5)", rusqlite::params![id,path.to_string_lossy(),old,hash,store::now()]).map_err(|e| e.to_string())?;
            Ok(output_value(&id, "completed", started, String::new(), Some(0)))
        }
        ActionKind::WriteNote => write_note(&request.action, &state)
            .map(|note| {
                if let Ok(db) = state.db.lock() {
                    let _ = init_undo(&db);
                    let _ = db.execute("INSERT OR REPLACE INTO tao_action_undo(action_id,kind,note_id,created_at) VALUES(?1,'note',?2,?3)", rusqlite::params![id,note,store::now()]);
                }
                output_value(&id, "completed", started, note, None)
            }),
        ActionKind::RunCommand => run_command(&request, &state, &run, started).await,
        ActionKind::RunSql => run_sql(&request, &state, started).await,
        ActionKind::OpenTab => {
            Err("action: OpenTab must be acknowledged by the active frontend tab".into())
        }
    };
    drop(run);
    if let Ok(ref value) = result {
        if let Ok(db) = state.db.lock() {
            let _ = db.execute("INSERT OR REPLACE INTO tao_action_results(action_id,status,result,created_at) VALUES(?1,'completed',?2,?3)", rusqlite::params![id, value.to_string(), store::now()]);
        }
    }
    result
}

#[tauri::command]
pub fn deepseek_app_undo_action(
    action_id: String,
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !confirmed {
        return Err("confirmation: undo requires explicit approval".into());
    }
    let db = state.db.lock().map_err(|_| "database unavailable")?;
    init_undo(&db)?;
    let row: (
        String,
        Option<String>,
        Option<Vec<u8>>,
        Option<String>,
        Option<String>,
    ) = db
        .query_row(
            "SELECT kind,path,old_content,new_hash,note_id FROM tao_action_undo WHERE action_id=?1",
            [&action_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|_| "action: undo record not found")?;
    match row.0.as_str() {
        "file" => {
            let path = PathBuf::from(row.1.ok_or("action: undo path missing")?);
            let expected = row.3.ok_or("action: undo hash missing")?;
            let current = std::fs::read(&path).map_err(|_| "action: target no longer exists")?;
            let hash = digest(&current);
            if hash != expected {
                return Err("action: file changed after action; undo refused".into());
            }
            match row.2 {
                Some(old) => std::fs::write(&path, old),
                None => std::fs::remove_file(&path),
            }
            .map_err(|_| "action: undo failed")?;
        }
        "note" => {
            let notes = state
                .notes_db
                .lock()
                .map_err(|_| "notes database unavailable")?;
            crate::notes::db::delete_note(&notes, &row.4.ok_or("action: note undo id missing")?)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err("action: unsupported undo record".into()),
    }
    db.execute(
        "DELETE FROM tao_action_undo WHERE action_id=?1",
        [&action_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"actionId":action_id,"status":"completed","undone":true}))
}

fn write_file(action: &ActionProposal) -> Result<(PathBuf, Option<Vec<u8>>, String), String> {
    let root = workspace(action).ok_or("action: workspace binding required")?;
    let raw = action
        .payload
        .get("path")
        .and_then(Value::as_str)
        .ok_or("action: path required")?;
    let path = safe_path(Path::new(raw), &root)?;
    let content = action
        .payload
        .get("content")
        .and_then(Value::as_str)
        .ok_or("action: content required")?;
    let old = if path.exists() {
        Some(std::fs::read(&path).map_err(|_| "action: cannot read backup")?)
    } else {
        None
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "action: cannot create target directory")?;
    }
    let tmp = path.with_extension(format!("tao-tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, content).map_err(|_| "action: cannot write target")?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("action: publish failed: {error}"));
    }
    let written = std::fs::read(&path).map_err(|_| "action: cannot verify target")?;
    Ok((path, old, digest(written)))
}
fn write_note(action: &ActionProposal, state: &AppState) -> Result<String, String> {
    let content = action
        .payload
        .get("content")
        .and_then(Value::as_str)
        .ok_or("action: note content required")?;
    let title = action
        .payload
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(&action.title);
    let db = state
        .notes_db
        .lock()
        .map_err(|_| "notes database unavailable")?;
    let note = crate::notes::db::create_note(
        &db,
        &crate::notes::db::CreateNoteInput {
            title: Some(title.to_string()),
            body: Some(content.to_string()),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(note.id)
}
async fn run_command(
    request: &ActionRequest,
    state: &AppState,
    run: &RunGuard,
    started: Instant,
) -> Result<Value, String> {
    let command = request
        .action
        .payload
        .get("command")
        .and_then(Value::as_str)
        .ok_or("action: command required")?;
    let root = workspace(&request.action).ok_or("action: workspace binding required")?;
    let cwd = request
        .action
        .target
        .as_ref()
        .and_then(|t| t.cwd.as_deref())
        .unwrap_or(root.to_str().unwrap_or("."));
    let dir = state.agent.captures.thread_dir(&request.thread_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "action: capture directory unavailable")?;
    let id = capture::new_capture_id();
    let writer =
        capture::CaptureWriter::create(&dir, &id).map_err(|_| "action: capture unavailable")?;
    let cancel = Arc::new(Notify::new());
    let cancel_forward = cancel.clone();
    let token = run.cancel.clone();
    let forward = tokio::spawn(async move {
        token.cancelled().await;
        cancel_forward.notify_waiters();
    });
    let outcome = exec_b::run_local(command, Some(cwd), &writer, cancel, |_, _| {}).await;
    forward.abort();
    let outcome = outcome?;
    let text = std::fs::read_to_string(writer.path()).unwrap_or_default();
    Ok(output_value(
        &request.action.id,
        if outcome.exit_code == Some(0) {
            "completed"
        } else {
            "failed"
        },
        started,
        text,
        outcome.exit_code,
    ))
}
async fn run_sql(
    request: &ActionRequest,
    state: &AppState,
    started: Instant,
) -> Result<Value, String> {
    let session = request
        .action
        .target
        .as_ref()
        .and_then(|t| t.database_id.clone())
        .ok_or("action: database binding required")?;
    let sql = request
        .action
        .payload
        .get("sql")
        .and_then(Value::as_str)
        .ok_or("action: sql required")?
        .to_string();
    let result = crate::database::query_commands::db_execute_inner(state, &session, &sql).await?;
    Ok(output_value(
        &request.action.id,
        "completed",
        started,
        serde_json::to_string(&result).unwrap_or_default(),
        Some(0),
    ))
}
