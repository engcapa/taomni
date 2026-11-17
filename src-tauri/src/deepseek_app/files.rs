//! Files API with content-addressed reuse and task state independent of a dialog.
use super::{client::MessagesClient, runtime::RunGuard, store};
use crate::state::AppState;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{State, ipc::Channel};

fn init(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ds_app_files(
        hash TEXT PRIMARY KEY,file_id TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ds_app_file_tasks(id TEXT PRIMARY KEY,state TEXT NOT NULL);")
        .map_err(|error|error.to_string())
}

fn progress(
    state: &AppState,
    id: &str,
    phase: &str,
    bytes: u64,
    total: u64,
    error: Option<&str>,
    event: &Channel<Value>,
) {
    let value = json!({"id":id,"phase":phase,"downloadedBytes":bytes,"totalBytes":total,
        "percent":if total>0 {bytes as f64/total as f64*100.0} else {0.0},"error":error});
    if let Ok(db) = state.core.db.lock() {
        let _ = db.execute(
            "INSERT OR REPLACE INTO ds_app_file_tasks(id,state) VALUES(?1,?2)",
            rusqlite::params![id, value.to_string()],
        );
    }
    let _ = event.send(value);
}

#[tauri::command]
pub async fn deepseek_app_upload_file(
    thread_id: String,
    local_path: String,
    on_event: Channel<Value>,
    provider: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let path = std::path::PathBuf::from(local_path);
    let provider_id = provider.as_deref().unwrap_or("deepseek-app");
    let config = state.legacy.ai_ctx.read().await.config.clone();
    let configured = super::client::provider_config(&config, provider_id)?;
    if configured.runtime != "deepseek-messages" {
        return super::inline_files::attach(&state, &thread_id, provider_id, &path).await;
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "file: selected file cannot be read")?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 {
        return Err("file: choose a file no larger than 32 MiB".into());
    }
    let filename = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("file: invalid filename")?
        .to_string();
    let (mime, purpose) = file_type(&filename)?;
    let data = tokio::fs::read(&path)
        .await
        .map_err(|_| "file: selected file cannot be read")?;
    let hash = Sha256::digest(&data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    {
        let db = state.core.db.lock().map_err(|_| "database unavailable")?;
        init(&db)?;
        let mut statement = db
            .prepare("SELECT file_id,filename,mime,size FROM ds_app_files WHERE hash=?1")
            .map_err(|e| e.to_string())?;
        let mut rows = statement.query([&hash]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            return Ok(
                json!({"fileId":row.get::<_,String>(0).map_err(|e|e.to_string())?,
                "filename":row.get::<_,String>(1).map_err(|e|e.to_string())?,"mime":row.get::<_,String>(2).map_err(|e|e.to_string())?,
                "sizeBytes":row.get::<_,i64>(3).map_err(|e|e.to_string())?,"reused":true}),
            );
        }
    }
    let task_id = format!("upload:{hash}");
    let run = RunGuard::begin(&task_id)?;
    let client = MessagesClient::resolve(&state).await?;
    progress(
        &state,
        &task_id,
        "connecting",
        0,
        metadata.len(),
        None,
        &on_event,
    );
    let result = tokio::select! {
        _=run.cancel.cancelled()=>Err(format!("{}: upload cancelled",run.reason())),
        result=async {
            let mut form=reqwest::multipart::Form::new();
            if let Some(purpose)=purpose {form=form.text("purpose",purpose);}
            let part=reqwest::multipart::Part::bytes(data).file_name(filename.clone()).mime_str(mime).map_err(|e|e.to_string())?;
            // purpose precedes file as required by the Files protocol.
            form=form.part("file",part);
            progress(&state,&task_id,"uploading",0,metadata.len(),None,&on_event);
            let response=client.post("/anthropic/v1/files").multipart(form).send().await.map_err(|_|"network: file upload failed")?;
            if !response.status().is_success(){return Err(format!("http: file upload returned HTTP {}",response.status().as_u16()));}
            let value:Value=response.json().await.map_err(|_|"protocol: invalid file response")?;
            let file_id=value["id"].as_str().ok_or("protocol: file id missing")?.to_string();
            let db=state.core.db.lock().map_err(|_|"database unavailable")?;
            db.execute("INSERT OR REPLACE INTO ds_app_files(hash,file_id,filename,mime,size) VALUES(?1,?2,?3,?4,?5)",
                rusqlite::params![hash,file_id,filename,mime,metadata.len() as i64]).map_err(|e|e.to_string())?;
            Ok(json!({"fileId":file_id,"filename":filename,"mime":mime,"sizeBytes":metadata.len(),"threadId":thread_id}))
        }=>result,
    };
    match &result {
        Ok(_) => progress(
            &state,
            &task_id,
            "completed",
            metadata.len(),
            metadata.len(),
            None,
            &on_event,
        ),
        Err(error) => progress(
            &state,
            &task_id,
            if run.cancel.is_cancelled() {
                "cancelled"
            } else {
                "failed"
            },
            0,
            metadata.len(),
            Some(error),
            &on_event,
        ),
    }
    result
}

#[tauri::command]
pub async fn deepseek_app_delete_file(
    file_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if file_id.starts_with("inline-") {
        return super::inline_files::remove(&state, &file_id);
    }
    if !file_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("protocol: invalid file id".into());
    }
    let client = MessagesClient::resolve(&state).await?;
    let response = client
        .http
        .delete(format!(
            "{}/anthropic/v1/files/{}",
            client.base_url, file_id
        ))
        .header("x-api-key", &client.api_key)
        .header("anthropic-beta", "files-api-2025-04-14")
        .send()
        .await
        .map_err(|_| "network: file delete failed")?;
    if !response.status().is_success() {
        return Err(format!(
            "http: file delete returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    init(&db)?;
    db.execute("DELETE FROM ds_app_files WHERE file_id=?1", [file_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn deepseek_app_file_tasks(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    init(&db)?;
    let mut stmt = db
        .prepare("SELECT state FROM ds_app_file_tasks ORDER BY rowid DESC")
        .map_err(|e| e.to_string())?;
    stmt.query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
}

pub(super) fn file_type(name: &str) -> Result<(&'static str, Option<&'static str>), String> {
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    Ok(match extension.as_str() {
        "png" => ("image/png", None),
        "jpg" | "jpeg" => ("image/jpeg", None),
        "webp" => ("image/webp", None),
        "gif" => ("image/gif", None),
        "pdf" => ("application/pdf", Some("rich_layout_recognition")),
        "docx" => (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Some("rich_layout_recognition"),
        ),
        "pptx" => (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            Some("rich_layout_recognition"),
        ),
        "txt" | "md" | "csv" | "json" | "xml" | "html" | "ts" | "tsx" | "js" | "rs" | "py"
        | "java" | "go" | "sql" | "yaml" | "yml" => ("text/plain", Some("user_data")),
        _ => return Err("file: this file type is not supported".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn purpose_is_selected_before_form_construction() {
        assert_eq!(file_type("diagram.png").unwrap(), ("image/png", None));
        assert_eq!(
            file_type("review.PDF").unwrap().1,
            Some("rich_layout_recognition")
        );
        assert_eq!(file_type("script.rs").unwrap().1, Some("user_data"));
        assert!(file_type("script.exe").is_err());
    }
}
