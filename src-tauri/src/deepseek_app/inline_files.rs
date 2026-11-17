//! LLM attachments stay local until send. Persist only authorized paths and
//! hashes, never base64 images, document bodies or provider credentials.
use crate::state::AppState;
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Read},
    path::Path,
};

mod storage;
pub(super) use storage::{forget_thread, inherit};

fn digest(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub async fn attach(
    state: &AppState,
    thread: &str,
    provider: &str,
    path: &Path,
) -> Result<Value, String> {
    if super::search::sensitive_path(&path.to_string_lossy()) {
        return Err("file: secret/configuration files cannot be attached".into());
    }
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| "file: selected file cannot be read")?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "file: selected file cannot be read")?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 {
        return Err("file: choose a file no larger than 32 MiB".into());
    }
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("file: invalid filename")?
        .to_string();
    let (mime, _) = super::files::file_type(&filename)?;
    let data = tokio::fs::read(&path)
        .await
        .map_err(|_| "file: selected file cannot be read")?;
    // Reject corrupt/unsupported documents at selection, before a paid request.
    let name = filename.clone();
    let validation_data = data.clone();
    tokio::task::spawn_blocking(move || part(&name, mime, &validation_data))
        .await
        .map_err(|_| "file: document preparation interrupted")??;
    let hash = digest(&data);
    let id = format!(
        "inline-{}",
        digest(format!("{thread}:{provider}:{hash}").as_bytes())
    );
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    let reused = storage::remember(
        &db,
        &id,
        thread,
        provider,
        &storage::StoredFile {
            path: path.to_string_lossy().into_owned(),
            hash,
            filename: filename.clone(),
            mime: mime.into(),
        },
        data.len(),
    )?;
    Ok(
        json!({"fileId":id,"filename":filename,"mime":mime,"sizeBytes":data.len(),"reused":reused,"threadId":thread,"provider":provider}),
    )
}

pub async fn resolve(
    state: &AppState,
    thread: &str,
    provider: &str,
    id: &str,
) -> Result<Value, String> {
    let file = {
        let db = state.core.db.lock().map_err(|_| "database unavailable")?;
        storage::lookup(&db, thread, provider, id)?
    };
    read_part(file).await
}

async fn read_part(file: storage::StoredFile) -> Result<Value, String> {
    let bytes = tokio::fs::read(&file.path)
        .await
        .map_err(|_| "file: attachment is unavailable; select it again")?;
    if bytes.len() > 32 * 1024 * 1024 || digest(&bytes) != file.hash {
        return Err("file: attachment changed; select it again before sending".into());
    }
    tokio::task::spawn_blocking(move || part(&file.filename, &file.mime, &bytes))
        .await
        .map_err(|_| "file: document preparation interrupted")?
}

pub fn remove(state: &AppState, id: &str) -> Result<(), String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    storage::remove(&db, id)
}

fn part(filename: &str, mime: &str, bytes: &[u8]) -> Result<Value, String> {
    if mime.starts_with("image/") {
        // The provider receives actual image bytes, rather than filenames or a
        // generated caption. Supported codecs are validated by the API.
        return Ok(
            json!({"type":"image_url","image_url":{"url":format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))}}),
        );
    }
    let raw = if mime == "application/pdf" {
        pdf_extract::extract_text_from_mem(bytes)
            .map_err(|_| "file: PDF text extraction failed; use a readable document or images")?
    } else if filename.ends_with(".docx") || filename.ends_with(".pptx") {
        office_text(bytes)?
    } else {
        String::from_utf8(bytes.to_vec()).map_err(|_| "file: document must contain UTF-8 text")?
    };
    if raw.trim().is_empty() {
        return Err("file: document has no extractable text; attach page images instead".into());
    }
    if raw.chars().count() > 120_000 {
        return Err("file: document exceeds 120,000 characters; split it before attaching".into());
    }
    let (text, _) = super::local_data::safe_excerpt(&raw, 120_000)
        .ok_or("file: document contains untrusted instructions")?;
    Ok(
        json!({"type":"text","text":format!("<untrusted_attachment name={}>\n{}\n</untrusted_attachment>",json!(filename),text)}),
    )
}

fn office_text(bytes: &[u8]) -> Result<String, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "file: invalid Office document")?;
    let mut result = String::new();
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "file: Office document cannot be read")?;
        if !(entry.name() == "word/document.xml"
            || entry.name().starts_with("ppt/slides/slide") && entry.name().ends_with(".xml"))
        {
            continue;
        }
        expanded += entry.size();
        if expanded > 16 * 1024 * 1024 {
            return Err("file: expanded Office document is too large".into());
        }
        let mut xml = String::new();
        entry
            .take(16 * 1024 * 1024 + 1)
            .read_to_string(&mut xml)
            .map_err(|_| "file: Office document cannot be read")?;
        let mut reader = quick_xml::Reader::from_str(&xml);
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Text(text)) => {
                    result.push_str(&text.decode().map_err(|_| "file: invalid Office text")?);
                    result.push(' ');
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Err(_) => return Err("file: invalid Office XML".into()),
                _ => (),
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_is_redacted_images_carry_bytes_and_invalid_documents_fail_before_send() {
        let text = part(
            "script.py",
            "text/plain",
            b"print('hello')\napi_key=synthetic-secret",
        )
        .unwrap();
        assert!(text["text"].as_str().unwrap().contains("print('hello')"));
        assert!(!text.to_string().contains("synthetic-secret"));
        let image = part("image.png", "image/png", b"actual-image-bytes").unwrap();
        assert!(
            image["image_url"]["url"]
                .as_str()
                .unwrap()
                .ends_with("YWN0dWFsLWltYWdlLWJ5dGVz")
        );
        assert!(part("broken.pdf", "application/pdf", b"invalid").is_err());
        assert!(part("broken.docx", "application/zip", b"invalid").is_err());
        assert!(part("empty.txt", "text/plain", b"  ").is_err());
    }
}

#[cfg(test)]
mod migration_tests {
    use super::storage::init;
    use rusqlite::Connection;
    #[test]
    fn legacy_file_ownership_migrates_idempotently_and_new_providers_stay_scoped() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE tao_inline_files(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL); INSERT INTO tao_inline_files VALUES('old','thread','/qa/file','hash','doc.txt','text/plain',3)").unwrap();
        init(&db).unwrap();
        init(&db).unwrap();
        let provider: String = db
            .query_row(
                "SELECT provider FROM tao_inline_files WHERE id='old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(provider, "opencode-go");
        let available: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM tao_inline_files WHERE id='old' AND thread_id='thread' AND provider='other')", [], |row| row.get(0)).unwrap();
        assert!(!available);
    }
}
