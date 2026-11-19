//! Folder export to mbox and import of mbox/.eml files (TASK-18).
//!
//! Export writes mboxrd (`>From ` quoting) with Thunderbird-style `From - `
//! separators, streaming 50 messages per FETCH. Import splits mbox (or takes
//! a single .eml) and stores each message with IMAP APPEND, so the server
//! and every other client see the imported mail.

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use taomni_mail_engine::mbox::{
    is_mbox, mbox_separator, mboxrd_escape, normalize_crlf, split_mbox,
};
use tauri::State;

use super::{
    ActiveImapSession, ImapSessionOpts, MailAccountConfig, resolve_config, with_imap_session,
};
use crate::state::AppState;

const EXPORT_CHUNK: usize = 50;
/// Refuse imports above this size (the file is read into memory).
const IMPORT_MAX_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailExportResult {
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailImportResult {
    pub imported: usize,
    pub failed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_error: Option<String>,
}

pub(super) fn imap_export_folder<T: Read + Write, W: Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    out: &mut W,
) -> Result<usize, String> {
    session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    let mut uids: Vec<u32> = session
        .uid_search("ALL")
        .map_err(|e| format!("IMAP UID SEARCH failed: {e}"))?
        .into_iter()
        .collect();
    uids.sort_unstable();
    let mut count = 0usize;
    for chunk in uids.chunks(EXPORT_CHUNK) {
        let set = chunk
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let fetches = session
            .uid_fetch(&set, "(UID INTERNALDATE BODY.PEEK[])")
            .map_err(|e| format!("IMAP FETCH failed: {e}"))?;
        let mut ordered: Vec<_> = fetches.iter().filter(|f| f.body().is_some()).collect();
        ordered.sort_by_key(|f| f.uid.unwrap_or(0));
        for fetch in ordered {
            let body = fetch.body().unwrap_or_default();
            let ts = fetch.internal_date().map(|d| d.timestamp());
            out.write_all(mbox_separator(ts).as_bytes())
                .and_then(|_| out.write_all(&mboxrd_escape(body)))
                .and_then(|_| {
                    if body.ends_with(b"\n") {
                        out.write_all(b"\n")
                    } else {
                        out.write_all(b"\n\n")
                    }
                })
                .map_err(|e| format!("writing mbox failed: {e}"))?;
            count += 1;
        }
    }
    Ok(count)
}

impl ActiveImapSession {
    fn export_folder<W: Write>(&mut self, folder: &str, out: &mut W) -> Result<usize, String> {
        match self {
            Self::Tls { session, .. } => imap_export_folder(session, folder, out),
            Self::Plain { session, .. } => imap_export_folder(session, folder, out),
        }
    }
}

/// Export `folder` to an mbox file at `path`.
#[tauri::command]
pub async fn mail_export_mbox(
    config: MailAccountConfig,
    folder: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<MailExportResult, String> {
    if super::pop3::is_pop3(&config) {
        let target = PathBuf::from(path.trim());
        let raws = super::local_cmds::folder_raw(&state, &config.session_id, folder.trim())?;
        let file = File::create(&target)
            .map_err(|e| format!("cannot create {}: {e}", target.display()))?;
        let mut out = BufWriter::new(file);
        for (_, raw) in &raws {
            out.write_all(mbox_separator(None).as_bytes())
                .and_then(|_| out.write_all(&mboxrd_escape(raw)))
                .and_then(|_| out.write_all(if raw.ends_with(b"\n") { b"\n" } else { b"\n\n" }))
                .map_err(|e| format!("writing mbox failed: {e}"))?;
        }
        out.flush()
            .map_err(|e| format!("writing mbox failed: {e}"))?;
        return Ok(MailExportResult {
            path: target.display().to_string(),
            count: raws.len(),
        });
    }
    let account = resolve_config(&state, config)?;
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("export path is required".into());
    }
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let target_for_task = target.clone();
    let count = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| {
                // Recreated on a pooled-session retry so a partial file never stays.
                let file = File::create(&target_for_task)
                    .map_err(|e| format!("cannot create {}: {e}", target_for_task.display()))?;
                let mut out = BufWriter::new(file);
                let count = imap.export_folder(&folder, &mut out)?;
                out.flush()
                    .map_err(|e| format!("writing mbox failed: {e}"))?;
                Ok(count)
            },
        )
    })
    .await
    .map_err(|e| format!("mail export task failed: {e}"))??;
    Ok(MailExportResult {
        path: target.display().to_string(),
        count,
    })
}

/// Import an mbox or .eml file into `folder` (IMAP APPEND, marked read).
#[tauri::command]
pub async fn mail_import_messages(
    config: MailAccountConfig,
    folder: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<MailImportResult, String> {
    let source = PathBuf::from(path.trim());
    let size = std::fs::metadata(&source)
        .map_err(|e| format!("cannot read {}: {e}", source.display()))?
        .len();
    if size > IMPORT_MAX_BYTES {
        return Err("import file is larger than 1 GiB".into());
    }
    let data =
        std::fs::read(&source).map_err(|e| format!("cannot read {}: {e}", source.display()))?;
    let messages = if is_mbox(&data) {
        split_mbox(&data)
    } else {
        vec![normalize_crlf(&data)]
    };
    if messages.is_empty() {
        return Ok(MailImportResult {
            imported: 0,
            failed: 0,
            first_error: None,
        });
    }
    if super::pop3::is_pop3(&config) {
        let imported =
            super::local_cmds::import(&state, &config.session_id, folder.trim(), &messages)?;
        return Ok(MailImportResult {
            imported,
            failed: 0,
            first_error: None,
        });
    }
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let mut imported = 0usize;
        let mut failed = 0usize;
        let mut first_error = None;
        for message in &messages {
            let appended = with_imap_session(
                &pool,
                &account,
                &handle,
                ImapSessionOpts::default(),
                |imap| imap.append(&folder, message, &["\\Seen"]),
            );
            match appended {
                Ok(()) => imported += 1,
                Err(e) => {
                    failed += 1;
                    first_error.get_or_insert(e);
                }
            }
        }
        MailImportResult {
            imported,
            failed,
            first_error,
        }
    })
    .await
    .map_err(|e| format!("mail import task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_then_import_on_fake_server() {
        let fake = super::super::fake_imap::FakeImap::start(false);
        fake.deliver("INBOX", 3, "export");
        fake.add_folder("Imported", 3000);
        let mut session = fake.session();
        let mut out = Vec::new();
        assert_eq!(
            imap_export_folder(&mut session, "INBOX", &mut out).unwrap(),
            3
        );
        let messages = split_mbox(&out);
        assert_eq!(messages.len(), 3);
        for message in &messages {
            super::super::outgoing::imap_append(&mut session, "Imported", message, &["\\Seen"])
                .unwrap();
        }
        let state = fake.state.lock().unwrap();
        let imported = &state.folders["Imported"].messages;
        assert_eq!(imported.len(), 3);
        let subjects: Vec<String> = imported
            .values()
            .map(|m| String::from_utf8_lossy(&m.raw).to_string())
            .collect();
        assert!(
            subjects
                .iter()
                .any(|raw| raw.contains("Subject: export 0002")),
            "{subjects:?}"
        );
    }
}
