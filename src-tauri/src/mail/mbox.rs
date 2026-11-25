//! Folder export to mbox and import of mbox/.eml files (TASK-18).
//!
//! Export writes mboxrd (`>From ` quoting) with Thunderbird-style `From - `
//! separators, streaming 50 messages per FETCH. Import splits mbox (or takes
//! a single .eml) and stores each message with IMAP APPEND, so the server
//! and every other client see the imported mail.

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, OPEN_IMAP_IMPORT,
    imap_exchange::{ImportMessage, MAX_IMPORT_FILE_BYTES},
};
#[cfg(any(test, feature = "legacy-mail-imap"))]
use taomni_mail_engine::mbox::imap_export_folder;
use taomni_mail_storage::mbox::{
    is_mbox, mbox_separator, mboxrd_escape, normalize_crlf, split_mbox,
};
use tauri::State;

#[cfg(any(test, feature = "legacy-mail-imap"))]
use super::{ActiveImapSession, ImapSessionOpts, with_imap_session};
use super::{
    MailAccountConfig, ResolvedMailAccount,
    module_host::{HostedImap, export_imap_mbox, exports_imap_mbox, imports_imap},
    resolve_config,
};
use crate::plugin::PluginRegistry;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailExportResult {
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailImportResult {
    pub imported: usize,
    pub failed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_error: Option<String>,
}

impl MailImportResult {
    fn record(&mut self, appended: Result<(), String>) {
        match appended {
            Ok(()) => self.imported += 1,
            Err(error) => {
                self.failed += 1;
                self.first_error.get_or_insert(error);
            }
        }
    }
}

#[cfg(any(test, feature = "legacy-mail-imap"))]
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
        let raws = super::local_cmds::folder_raw(&state, &config.session_id, folder.trim()).await?;
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
    if exports_imap_mbox(&state.plugins) {
        let count = export_imap_mbox(state.plugins.clone(), &account, folder, &target).await?;
        return Ok(MailExportResult {
            path: target.display().to_string(),
            count,
        });
    }
    legacy_imap!({
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
    let messages = tokio::task::spawn_blocking(move || read_import_file(&source))
        .await
        .map_err(|error| format!("mail import file task failed: {error}"))??;
    if messages.is_empty() {
        return Ok(MailImportResult::default());
    }
    if super::pop3::is_pop3(&config) {
        let imported =
            super::local_cmds::import(&state, &config.session_id, folder.trim(), messages).await?;
        return Ok(MailImportResult {
            imported,
            failed: 0,
            first_error: None,
        });
    }
    let account = resolve_config(&state, config)?;
    if imports_imap(&state.plugins) {
        return Ok(import_hosted(state.plugins.clone(), &account, folder, messages).await);
    }
    legacy_imap!({
        let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let mut result = MailImportResult::default();
            for message in &messages {
                let appended = with_imap_session(
                    &pool,
                    &account,
                    &handle,
                    ImapSessionOpts::default(),
                    |imap| imap.append(&folder, message, &["\\Seen"]),
                );
                result.record(appended);
            }
            result
        })
        .await
        .map_err(|e| format!("mail import task failed: {e}"))
    })
}

fn read_import_file(source: &Path) -> Result<Vec<Vec<u8>>, String> {
    let read_error = |error| format!("cannot read {}: {error}", source.display());
    let file = File::open(source).map_err(read_error)?;
    if file.metadata().map_err(read_error)?.len() > MAX_IMPORT_FILE_BYTES {
        return Err("import file is larger than 1 GiB".into());
    }
    let mut data = Vec::new();
    file.take(MAX_IMPORT_FILE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(read_error)?;
    if data.len() as u64 > MAX_IMPORT_FILE_BYTES {
        return Err("import file is larger than 1 GiB".into());
    }
    Ok(if is_mbox(&data) {
        split_mbox(&data)
    } else {
        vec![normalize_crlf(&data)]
    })
}

async fn import_hosted(
    registry: Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    folder: String,
    messages: Vec<Vec<u8>>,
) -> MailImportResult {
    let mut connection = None::<HostedImap>;
    let mut result = MailImportResult::default();
    for message in messages {
        let request = ImportMessage {
            folder: folder.clone(),
        };
        let append = async {
            if connection.is_none() {
                connection =
                    Some(HostedImap::open(registry.clone(), account, OPEN_IMAP_IMPORT).await?);
            }
            connection
                .as_mut()
                .expect("open Mail import session")
                .exchange(request, Some(message))
                .await
        };
        let appended = tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), append)
            .await
            .unwrap_or_else(|_| Err("Mail import APPEND timed out".into()));
        if appended.is_err() {
            // A lost APPEND receipt is ambiguous. Open a fresh session only
            // for the next message so the current one is never copied twice.
            connection = None;
        }
        result.record(appended);
    }
    result
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
