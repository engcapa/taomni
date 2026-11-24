//! Hand an account's desktop drafts to its signed host exactly once. Keep the
//! SQLite JSON columns opaque so older attachment and composer metadata survive.
use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct StoredDraft {
    id: String,
    to_json: String,
    cc_json: String,
    bcc_json: String,
    subject: String,
    text_body: String,
    html_body: String,
    attachments_json: String,
    reply_context_json: Option<String>,
    remote_draft_folder: Option<String>,
    remote_draft_uid: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct DraftImport {
    /// A previously staged copy can still contain mail sent from the desktop
    /// after staging. An existing desktop database is authoritative in that case.
    pub replace_staged: bool,
    pub rows: Vec<StoredDraft>,
}

pub fn read_account(db: &Connection, account: &str) -> Result<Vec<StoredDraft>> {
    let mut columns = db.prepare("SELECT name FROM pragma_table_info('mail_drafts')")?;
    let columns = columns
        .query_map([], |row| row.get(0))?
        .collect::<Result<std::collections::BTreeSet<String>>>()?;
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let optional = |name| if columns.contains(name) { name } else { "NULL" };
    let sql = format!(
        "SELECT id,to_json,cc_json,bcc_json,subject,text_body,html_body,attachments_json,
         {},{},{},created_at,updated_at FROM mail_drafts WHERE account_id=?1 ORDER BY id",
        optional("reply_context_json"),
        optional("remote_draft_folder"),
        optional("remote_draft_uid")
    );
    db.prepare(&sql)?
        .query_map([account], |row| {
            Ok(StoredDraft {
                id: row.get(0)?,
                to_json: row.get(1)?,
                cc_json: row.get(2)?,
                bcc_json: row.get(3)?,
                subject: row.get(4)?,
                text_body: row.get(5)?,
                html_body: row.get(6)?,
                attachments_json: row.get(7)?,
                reply_context_json: row.get(8)?,
                remote_draft_folder: row.get(9)?,
                remote_draft_uid: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })?
        .collect()
}

pub fn is_owned(db: &Connection, account: &str) -> Result<bool> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_draft_owners')",
        [], |row| row.get(0)
    )?;
    if !exists {
        return Ok(false);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_draft_owners WHERE account_id=?1)",
        [account],
        |row| row.get(0),
    )
}

pub fn mark_owned(db: &Connection, account: &str) -> Result<()> {
    db.execute(
        "CREATE TABLE IF NOT EXISTS mail_draft_owners(account_id TEXT PRIMARY KEY NOT NULL)",
        [],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO mail_draft_owners(account_id) VALUES (?1)",
        [account],
    )?;
    Ok(())
}

/// The host calls this inside its immediate writer transaction. A concurrent
/// first request or a retry must never bring a sent or deleted draft back.
pub fn adopt(db: &Connection, account: &str, source: DraftImport) -> Result<()> {
    if is_owned(db, account)? {
        return Ok(());
    }
    if source.replace_staged {
        db.execute("DELETE FROM mail_drafts WHERE account_id=?1", [account])?;
    }
    let mut upsert = db.prepare(
        "INSERT INTO mail_drafts (account_id,id,to_json,cc_json,bcc_json,subject,text_body,html_body,
         attachments_json,reply_context_json,remote_draft_folder,remote_draft_uid,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
         ON CONFLICT(account_id,id) DO UPDATE SET
         to_json=excluded.to_json,cc_json=excluded.cc_json,bcc_json=excluded.bcc_json,
         subject=excluded.subject,text_body=excluded.text_body,html_body=excluded.html_body,
         attachments_json=excluded.attachments_json,reply_context_json=excluded.reply_context_json,
         remote_draft_folder=excluded.remote_draft_folder,remote_draft_uid=excluded.remote_draft_uid,
         created_at=excluded.created_at,updated_at=excluded.updated_at
         WHERE excluded.updated_at>=mail_drafts.updated_at"
    )?;
    for draft in source.rows {
        upsert.execute(params![
            account,
            draft.id,
            draft.to_json,
            draft.cc_json,
            draft.bcc_json,
            draft.subject,
            draft.text_body,
            draft.html_body,
            draft.attachments_json,
            draft.reply_context_json,
            draft.remote_draft_folder,
            draft.remote_draft_uid,
            draft.created_at,
            draft.updated_at
        ])?;
    }
    mark_owned(db, account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drafts::{delete_mail_draft, get_mail_draft, list_mail_drafts, save_mail_draft};
    use serde_json::json;

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::cache::init_mail_tables(&db).unwrap();
        db
    }

    fn queue(db: &Connection, account: &str, id: &str) {
        let draft = serde_json::from_value(json!({
            "id":id, "to":["to@example.com"], "textBody":"message", "remoteDraftFolder":"Drafts",
            "remoteDraftUid":14, "replyContext":{"outbox":{"sendAt":4102444800_i64,"attempts":2}}
        }))
        .unwrap();
        save_mail_draft(db, account, draft).unwrap();
    }

    #[test]
    fn adoption_keeps_desktop_identity_and_does_not_requeue_a_sent_message_on_retry() {
        let source = database();
        let mut dest = database();
        queue(&source, "a", "pending");
        queue(&dest, "a", "sent-before-handoff");
        queue(&dest, "b", "other-account");
        let snapshot = || DraftImport {
            replace_staged: true,
            rows: read_account(&source, "a").unwrap(),
        };
        let old = get_mail_draft(&source, "a", "pending").unwrap().unwrap();
        // Cancelling the transaction must leave both the old copy and owner marker intact.
        let cancelled = dest.transaction().unwrap();
        adopt(&cancelled, "a", snapshot()).unwrap();
        cancelled.rollback().unwrap();
        assert!(!is_owned(&dest, "a").unwrap());
        assert!(
            get_mail_draft(&dest, "a", "sent-before-handoff")
                .unwrap()
                .is_some()
        );

        let tx = dest.transaction().unwrap();
        adopt(&tx, "a", snapshot()).unwrap();
        tx.commit().unwrap();
        assert!(is_owned(&dest, "a").unwrap());
        assert!(!is_owned(&dest, "b").unwrap());
        assert_eq!(list_mail_drafts(&dest, "a").unwrap(), [old]);
        assert_eq!(list_mail_drafts(&dest, "b").unwrap().len(), 1);
        delete_mail_draft(&dest, "a", "pending").unwrap();
        adopt(&dest, "a", snapshot()).unwrap();
        assert!(list_mail_drafts(&dest, "a").unwrap().is_empty());
        assert_eq!(list_mail_drafts(&source, "a").unwrap().len(), 1);
    }

    #[test]
    fn explicit_install_merges_preserved_rows_without_overwriting_a_newer_module_edit() {
        let source = database();
        let dest = database();
        queue(&source, "a", "edited");
        queue(&source, "a", "desktop-only");
        queue(&dest, "a", "edited");
        queue(&dest, "a", "module-only");
        dest.execute(
            "UPDATE mail_drafts SET updated_at=updated_at+10,subject='latest' WHERE id='edited'",
            [],
        )
        .unwrap();
        source
            .execute(
                "UPDATE mail_drafts SET reply_context_json=? WHERE id='desktop-only'",
                [r#"{"futureMetadata":"preserved"}"#],
            )
            .unwrap();
        adopt(
            &dest,
            "a",
            DraftImport {
                replace_staged: false,
                rows: read_account(&source, "a").unwrap(),
            },
        )
        .unwrap();
        assert_eq!(list_mail_drafts(&dest, "a").unwrap().len(), 3);
        assert_eq!(
            get_mail_draft(&dest, "a", "edited")
                .unwrap()
                .unwrap()
                .subject,
            "latest"
        );
        let context: String = dest
            .query_row(
                "SELECT reply_context_json FROM mail_drafts WHERE id='desktop-only'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(context, r#"{"futureMetadata":"preserved"}"#);
    }
}
