use std::path::{Path, PathBuf};

use rusqlite::Connection;
use taomni_mail_api::folder_cache::FolderCacheAction;
use taomni_mail_engine::{
    cache::{init_mail_tables, list_cached_folders},
    database::mail_db_file_stem,
};

use super::*;

const ACCOUNT: &str = "cache-fixture";

fn database(root: &Path) -> PathBuf {
    let path = root.join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    path
}

fn folder(name: &str, subscribed: bool) -> MailFolder {
    MailFolder {
        account_id: ACCOUNT.into(),
        name: name.into(),
        uid_next: Some(15),
        flags: subscribed
            .then_some("\\Subscribed".to_string())
            .into_iter()
            .collect(),
        ..MailFolder::default()
    }
}

fn request(db: &Path, action: FolderCacheAction, folders: Vec<MailFolder>) -> FolderCacheUpdate {
    FolderCacheUpdate {
        account_id: ACCOUNT.into(),
        database: db.to_owned(),
        action,
        folders,
    }
}

#[test]
fn folder_updates_keep_cached_watermarks_and_remove_the_previous_folder() {
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory.path().canonicalize().unwrap());

    let listed = vec![folder("INBOX", true), folder("Projects", true)];
    let updated = apply(request(&path, FolderCacheAction::List, listed), &|| Ok(())).unwrap();
    assert_eq!(updated.len(), 2);

    let mut unsubscribed = folder("Projects", false);
    unsubscribed.uid_next = None;
    let updated = apply(
        request(&path, FolderCacheAction::Subscription, vec![unsubscribed]),
        &|| Ok(()),
    )
    .unwrap();
    let previous = updated.iter().find(|row| row.name == "Projects").unwrap();
    assert!(previous.flags.is_empty());
    assert_eq!(previous.uid_next, Some(15));

    let current = vec![folder("INBOX", true), folder("Renamed", false)];
    apply(
        request(
            &path,
            FolderCacheAction::Change {
                previous: Some("Projects".into()),
            },
            current,
        ),
        &|| Ok(()),
    )
    .unwrap();
    let stored = Connection::open(&path).unwrap();
    let folders = list_cached_folders(&stored, ACCOUNT).unwrap();
    assert_eq!(
        folders
            .iter()
            .map(|folder| folder.name.as_str())
            .collect::<Vec<_>>(),
        ["INBOX", "Renamed"]
    );
}

#[test]
fn mismatched_account_and_cancelled_publication_preserve_the_previous_tree() {
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory.path().canonicalize().unwrap());
    apply(
        request(&path, FolderCacheAction::List, vec![folder("INBOX", true)]),
        &|| Ok(()),
    )
    .unwrap();

    let mut wrong_account = folder("Other", true);
    wrong_account.account_id = "different-account".into();
    assert!(
        apply(
            request(&path, FolderCacheAction::List, vec![wrong_account]),
            &|| Ok(())
        )
        .is_err()
    );
    let calls = std::cell::Cell::new(0);
    let cancelled = apply(
        request(
            &path,
            FolderCacheAction::List,
            vec![folder("Cancelled", true)],
        ),
        &|| {
            calls.set(calls.get() + 1);
            // The fourth check runs after applying the rows, just before commit.
            if calls.get() == 4 {
                Err(RpcError::new(ErrorCode::InvalidState, "cancelled"))
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(cancelled.err().unwrap().message, "cancelled");
    let db = Connection::open(&path).unwrap();
    let folders = list_cached_folders(&db, ACCOUNT).unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].name, "INBOX");
}
