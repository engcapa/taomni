//! Opt-in L2 stores. File snapshot metadata is L1; contents and mail stay off by default.
use super::connectors::{Entry, collect as rows};
use crate::state::AppState;
use rusqlite::{Connection, OpenFlags};
use std::{collections::BTreeMap, path::Path};
use taomni_mail_api::pop3_store::{LocalMailboxAction, SearchIndexRow};

pub async fn collect(
    state: &AppState,
    enabled: &BTreeMap<String, bool>,
) -> Result<Vec<Entry>, String> {
    let mut result = Vec::new();
    let on = |source: &str| enabled.get(source) == Some(&true);
    if on("snapshots") || on("file_contents") {
        result.extend(snapshot_entries(
            &state.core.paths.data.join("local-history"),
            on("snapshots"),
            on("file_contents"),
        )?);
    }
    if on("mail") || on("mail_bodies") {
        let accounts = {
            let db = state.core.db.lock().map_err(|_| "database unavailable")?;
            rows(
                &db,
                "mail",
                "SELECT id,name,'','',0,1 FROM sessions WHERE session_type='Mail'",
            )?
        };
        for account in accounts {
            let hosted = on("mail_bodies")
                && crate::mail::draft_store::is_hosted(state, &account.reference).await?;
            if hosted {
                let drafts =
                    crate::mail::draft_store::hosted_search_index(state, &account.reference)
                        .await?;
                result.extend(drafts.into_iter().map(|draft| Entry {
                    source: "mail_bodies".into(),
                    reference: format!("{}:draft:{}", account.reference, draft.id),
                    title: draft.subject,
                    body: draft.text,
                    host: String::new(),
                    ts: draft.updated_at,
                    uses: 1,
                }));
            }
            if crate::mail::pop3_store::is_hosted(state, &account.reference).await? {
                for (source, bodies) in [("mail", false), ("mail_bodies", true)] {
                    if on(source) {
                        let rows: Vec<SearchIndexRow> = crate::mail::pop3_store::hosted(
                            state,
                            &account.reference,
                            LocalMailboxAction::SearchIndex { bodies },
                        )
                        .await?;
                        result.extend(rows.into_iter().map(|row| Entry {
                            source: source.into(),
                            reference: row.reference,
                            title: row.subject,
                            body: row.text,
                            host: String::new(),
                            ts: row.timestamp,
                            uses: 1,
                        }));
                    }
                }
                continue;
            }
            let handle = state.mail_db(&account.reference)?;
            let db = handle.lock_for_snapshot(&tokio_util::sync::CancellationToken::new())?;
            if on("mail") {
                result.extend(rows(&db, "mail", "SELECT account_id||':'||folder||':'||uid,subject,'from:'||COALESCE(from_name,'')||' '||COALESCE(from_addr,'')||' folder:'||folder,'',COALESCE(date_ts,updated_at),1 FROM mail_messages ORDER BY COALESCE(date_ts,updated_at) DESC LIMIT 5000")?);
            }
            if on("mail_bodies") {
                result.extend(rows(&db, "mail_bodies", "SELECT account_id||':'||folder||':'||uid,subject,COALESCE(body_text,''),'',COALESCE(date_ts,updated_at),1 FROM mail_messages WHERE body_text IS NOT NULL ORDER BY COALESCE(date_ts,updated_at) DESC LIMIT 5000")?);
                if !hosted {
                    result.extend(rows(&db, "mail_bodies", "SELECT account_id||':draft:'||id,subject,text_body,'',updated_at,1 FROM mail_drafts")?);
                }
            }
        }
    }
    Ok(result)
}

pub fn snapshot_entries(root: &Path, metadata: bool, contents: bool) -> Result<Vec<Entry>, String> {
    let path = root.join("history.db");
    if !path.is_file() {
        return Ok(vec![]);
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "search: snapshot database unavailable")?;
    let entries = rows(
        &db,
        "snapshots",
        "SELECT CAST(id AS TEXT),path,reason||' bytes:'||byte_len,'',created_at,1 FROM local_history ORDER BY created_at DESC LIMIT 5000",
    )?;
    let mut result = Vec::new();
    for entry in entries {
        if contents && !sensitive_path(&entry.title) {
            let hash: String = db
                .query_row(
                    "SELECT content_hash FROM local_history WHERE id=?1",
                    [&entry.reference],
                    |r| r.get(0),
                )
                .map_err(|_| "search: snapshot missing")?;
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("search: invalid snapshot hash".into());
            }
            let blob = root.join("blobs").join(&hash[..2]).join(&hash);
            if let Ok(text) = std::fs::read_to_string(blob) {
                result.push(Entry {
                    source: "file_contents".into(),
                    reference: entry.reference.clone(),
                    title: entry.title.clone(),
                    body: text,
                    host: String::new(),
                    ts: entry.ts,
                    uses: 1,
                });
            }
        }
        if metadata {
            result.push(entry);
        }
    }
    Ok(result)
}

pub fn sensitive_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let name = normalized.rsplit('/').next().unwrap_or("");
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || ["id_rsa", "id_ed25519", "credentials", "vault.db"].contains(&name)
        || normalized.contains("/.ssh/")
        || normalized.contains("/.aws/")
}
