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

/// `From - Tue Sep 30 03:38:00 2026` (asctime, UTC).
pub(super) fn mbox_separator(internal_ts: Option<i64>) -> String {
    let when = internal_ts
        .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
        .unwrap_or_else(chrono::Utc::now);
    format!("From - {}\n", when.format("%a %b %e %H:%M:%S %Y"))
}

fn is_from_line(line: &[u8]) -> bool {
    let quoted = line.iter().take_while(|b| **b == b'>').count();
    line[quoted..].starts_with(b"From ")
}

/// mboxrd body: every line matching `^>*From ` gains one `>`; LF endings.
pub(super) fn mboxrd_escape(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 64);
    for line in raw.split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if is_from_line(line) {
            out.push(b'>');
        }
        out.extend_from_slice(line);
        out.push(b'\n');
    }
    // `split` yields a trailing empty piece for a final newline.
    if raw.ends_with(b"\n") {
        out.pop();
    }
    out
}

pub(super) fn is_mbox(data: &[u8]) -> bool {
    data.starts_with(b"From ")
}

/// Split an mbox into RFC 5322 messages (CRLF endings, `>From ` unquoted).
pub(super) fn split_mbox(data: &[u8]) -> Vec<Vec<u8>> {
    let mut messages: Vec<Vec<u8>> = Vec::new();
    let mut current: Option<Vec<Vec<u8>>> = None;
    let mut previous_blank = true;
    for line in data.split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if previous_blank && line.starts_with(b"From ") {
            if let Some(lines) = current.take() {
                messages.push(join_crlf(lines));
            }
            current = Some(Vec::new());
            previous_blank = false;
            continue;
        }
        previous_blank = line.is_empty();
        if let Some(lines) = current.as_mut() {
            let unquoted = if line.first() == Some(&b'>') && is_from_line(&line[1..]) {
                &line[1..]
            } else {
                line
            };
            lines.push(unquoted.to_vec());
        }
    }
    if let Some(lines) = current.take() {
        messages.push(join_crlf(lines));
    }
    messages.retain(|message| !message.iter().all(u8::is_ascii_whitespace));
    messages
}

fn join_crlf(mut lines: Vec<Vec<u8>>) -> Vec<u8> {
    // Drop the blank separator line(s) before the next `From `.
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let mut out = Vec::new();
    for line in lines {
        out.extend_from_slice(&line);
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// A single .eml with bare LF endings, normalised for IMAP APPEND.
pub(super) fn normalize_crlf(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + raw.len() / 32);
    for (index, byte) in raw.iter().enumerate() {
        if *byte == b'\n' && (index == 0 || raw[index - 1] != b'\r') {
            out.push(b'\r');
        }
        out.push(*byte);
    }
    out
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
    let account = resolve_config(&state, config)?;
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("export path is required".into());
    }
    let pool = Arc::clone(&state.mail_imap_pool);
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
    let account = resolve_config(&state, config)?;
    let pool = Arc::clone(&state.mail_imap_pool);
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
    fn mboxrd_round_trip_keeps_from_lines() {
        let one = b"Subject: one\r\n\r\nFrom the start\r\n>From quoted\r\nend\r\n".to_vec();
        let two = b"Subject: two\n\nsecond body\n".to_vec();
        let mut mbox = Vec::new();
        for (raw, ts) in [(&one, 1_700_000_000), (&two, 1_700_000_100)] {
            mbox.extend_from_slice(mbox_separator(Some(ts)).as_bytes());
            mbox.extend_from_slice(&mboxrd_escape(raw));
            mbox.extend_from_slice(b"\n");
        }
        let text = String::from_utf8_lossy(&mbox);
        assert!(
            text.starts_with("From - Tue Nov 14 22:13:20 2023\n"),
            "{text}"
        );
        assert!(
            text.contains("\n>From the start\n>>From quoted\n"),
            "{text}"
        );

        let split = split_mbox(&mbox);
        assert_eq!(split.len(), 2);
        assert_eq!(
            split[0],
            b"Subject: one\r\n\r\nFrom the start\r\n>From quoted\r\nend\r\n".to_vec()
        );
        assert_eq!(split[1], b"Subject: two\r\n\r\nsecond body\r\n".to_vec());
        assert!(is_mbox(&mbox));
    }

    #[test]
    fn eml_is_normalised_to_crlf() {
        assert_eq!(normalize_crlf(b"a\nb\r\nc\n"), b"a\r\nb\r\nc\r\n".to_vec());
        assert!(!is_mbox(b"Subject: x\r\n\r\nbody"));
    }

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
