use std::{
    cell::Cell,
    path::{Path, PathBuf},
};

use rusqlite::Connection;
use taomni_mail_api::{
    imap_index::ImapIndexRetention,
    imap_sync::{MailSyncMode, Watermark},
    message::MailFolder,
};
use taomni_mail_engine::{
    cache::{init_mail_tables, load_folder_sync_state},
    database::mail_db_file_stem,
    parse_body_message,
};

use super::*;

const ACCOUNT: &str = "imap-index-account";

fn cache() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    (root, path)
}

fn outcome(uid: u32) -> FolderStepOutcome {
    let raw = b"Subject: New header\r\n\r\nDelivered body";
    FolderStepOutcome {
        folder: MailFolder {
            account_id: ACCOUNT.into(),
            name: "INBOX".into(),
            uid_validity: Some(71),
            ..MailFolder::default()
        },
        mode: MailSyncMode::Initial,
        messages: vec![parse_body_message(
            ACCOUNT,
            "INBOX",
            uid,
            None,
            raw,
            raw.len(),
        )],
        vanished: Vec::new(),
        flag_updates: Vec::new(),
        watermark: Watermark {
            low: Some(uid),
            high: Some(uid),
            complete: true,
            needs_repair: false,
        },
        highest_modseq: Some(u64::from(uid)),
        reconciled: true,
        uid_validity_reset: false,
        remaining: 0,
        more: false,
        new_unseen: 1,
    }
}

fn publication(path: &Path, action: ImapIndexAction) -> ImapIndexPublication<ImapIndexAction> {
    ImapIndexPublication {
        account_id: ACCOUNT.into(),
        database: path.to_owned(),
        retention: ImapIndexRetention {
            header_limit_per_folder: 100,
            header_retention_days: 0,
            body_recent_limit: 20,
        },
        started_at_ms: 100,
        action,
    }
}

#[test]
fn folder_step_returns_the_persisted_watermark() {
    let (_root, path) = cache();
    let applied = apply(
        publication(
            &path,
            ImapIndexAction::Step {
                outcome: outcome(3),
            },
        ),
        &|| Ok(()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(applied.folder.unwrap().uid_validity, Some(71));
    let db = Connection::open(&path).unwrap();
    let state = load_folder_sync_state(&db, ACCOUNT, "INBOX").unwrap();
    assert_eq!(state.high, Some(3));
    assert_eq!(state.cached_uids, [3]);
}

#[test]
fn a_cancelled_round_keeps_the_prior_index_and_a_completed_round_keeps_its_error() {
    let (_root, path) = cache();
    apply(
        publication(
            &path,
            ImapIndexAction::Step {
                outcome: outcome(3),
            },
        ),
        &|| Ok(()),
    )
    .unwrap();
    let round = || {
        let mut update = outcome(4);
        update.vanished.push(3);
        ImapIndexAction::Round {
            folder: update.folder.clone(),
            steps: vec![update],
            error: Some("IMAP disconnected after one step".into()),
        }
    };
    let count = Cell::new(0);
    let result = apply(publication(&path, round()), &|| {
        count.set(count.get() + 1);
        if count.get() == 4 {
            Err(RpcError::from_code(ErrorCode::RequestCancelled))
        } else {
            Ok(())
        }
    });
    assert_eq!(
        result.err().unwrap().code,
        ErrorCode::RequestCancelled.as_i32()
    );

    let db = Connection::open(&path).unwrap();
    let cached_error = || -> Option<String> {
        db.query_row("SELECT last_error FROM mail_folders", [], |row| row.get(0))
            .unwrap()
    };
    assert_eq!(
        load_folder_sync_state(&db, ACCOUNT, "INBOX")
            .unwrap()
            .cached_uids,
        [3]
    );
    assert!(cached_error().is_none());
    assert!(
        apply(publication(&path, round()), &|| Ok(()))
            .unwrap()
            .is_none()
    );
    let state = load_folder_sync_state(&db, ACCOUNT, "INBOX").unwrap();
    assert_eq!(state.cached_uids, [4]);
    assert_eq!(state.high, Some(4));
    assert_eq!(
        cached_error().as_deref(),
        Some("IMAP disconnected after one step")
    );
}

#[test]
fn a_quiet_page_caches_the_selected_folder_without_replacing_the_tree() {
    let (_root, path) = cache();
    let previous = outcome(3);
    apply(
        publication(&path, ImapIndexAction::Step { outcome: previous }),
        &|| Ok(()),
    )
    .unwrap();
    let index = outcome(4);
    let mut unlisted = index.folder.clone();
    unlisted.name = "Unlisted".into();
    let page = publication(
        &path,
        ImapIndexAction::Page {
            folders: vec![index.folder, unlisted],
            messages: index.messages,
            selected: "INBOX".into(),
            listed: false,
        },
    );
    assert!(apply(page, &|| Ok(())).unwrap().is_none());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        load_folder_sync_state(&db, ACCOUNT, "INBOX")
            .unwrap()
            .cached_uids,
        [3, 4]
    );
    assert_eq!(
        taomni_mail_engine::cache::list_cached_folders(&db, ACCOUNT)
            .unwrap()
            .len(),
        1
    );
}
