use super::*;
use rusqlite::Connection;
use taomni_mail_api::pop3_store::LocalArchiveAction;
use taomni_mail_engine::{MailFolder, MailMessageBody, cache::init_mail_tables, storage};

const ACCOUNT: &str = "pop3-legacy-test";

fn legacy_db(root: &Path) -> PathBuf {
    let path = root.join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    local_store::ensure_local_folders(&db, ACCOUNT).unwrap();
    path
}

fn call<T: serde::de::DeserializeOwned>(
    store: &Store,
    database: &Path,
    action: LocalMailboxAction,
) -> T {
    let request = LegacyMailboxRequest {
        account_id: ACCOUNT.into(),
        database: database.to_owned(),
        action,
    };
    serde_json::from_slice(&execute(store, request, &|| Ok(())).unwrap()).unwrap()
}

#[test]
fn legacy_mailbox_executes_body_move_delete_and_folder_mutations() {
    use LocalMailboxAction::*;

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let store = Store::new(&root);
    let database = legacy_db(&root);
    let raw = b"Subject: Legacy POP3 message\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nLegacy body\r\n--b\r\nContent-Disposition: attachment; filename=a.bin\r\n\r\nbytes\r\n--b--\r\n";
    let count: usize = call(
        &store,
        &database,
        Append {
            folder: "INBOX".into(),
            originals: vec![raw.to_vec()],
            sent_recipients: Vec::new(),
        },
    );
    assert_eq!(count, 1);

    let body: Option<MailMessageBody> = call(
        &store,
        &database,
        Body {
            folder: "INBOX".into(),
            uid: 1,
        },
    );
    assert!(body.unwrap().text.unwrap().contains("Legacy body"));

    let folders: Vec<MailFolder> = call(
        &store,
        &database,
        CreateFolder {
            name: "Receipts".into(),
        },
    );
    assert!(folders.iter().any(|folder| folder.name == "Receipts"));
    let moved: usize = call(
        &store,
        &database,
        MoveOrCopy {
            folder: "INBOX".into(),
            uids: vec![1],
            target: "Receipts".into(),
            copy: false,
        },
    );
    assert_eq!(moved, 1);

    let originals: Vec<(u32, Vec<u8>)> = call(
        &store,
        &database,
        Originals {
            folder: "Receipts".into(),
        },
    );
    assert_eq!(originals.len(), 1);

    let folders_after_delete: Vec<MailFolder> = call(
        &store,
        &database,
        DeleteFolder {
            name: "Receipts".into(),
        },
    );
    assert!(!folders_after_delete.iter().any(|f| f.name == "Receipts"));
    let db = Connection::open(&database).unwrap();
    assert_eq!(storage::list(&db, ACCOUNT, 0).unwrap().len(), 1);
}

#[test]
fn rejects_owned_account_wrong_database_name_and_disallowed_actions() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let store = Store::new(&root);
    let database = legacy_db(&root);

    for bad_action in [
        LocalMailboxAction::Initialize,
        LocalMailboxAction::Archive(LocalArchiveAction::Paused),
    ] {
        let error = execute(
            &store,
            LegacyMailboxRequest {
                account_id: ACCOUNT.into(),
                database: database.clone(),
                action: bad_action,
            },
            &|| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams as i32);
    }

    let wrong_name = execute(
        &store,
        LegacyMailboxRequest {
            account_id: ACCOUNT.into(),
            database: root.join("other-account.db"),
            action: LocalMailboxAction::Folders,
        },
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(wrong_name.code, ErrorCode::InvalidParams as i32);

    let owned_dir = store.data_root(true).unwrap().unwrap();
    taomni_mail_engine::pop3::ownership::mark_owned(&owned_dir, ACCOUNT).unwrap();
    let rejected = execute(
        &store,
        LegacyMailboxRequest {
            account_id: ACCOUNT.into(),
            database: database.clone(),
            action: LocalMailboxAction::Folders,
        },
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(rejected.code, ErrorCode::InvalidState as i32);
    assert_eq!(rejected.message, OWNERSHIP_CHANGED);

    let step_error = match LockedDatabase::open(&store, &database, ACCOUNT) {
        Ok(_) => panic!("mid-sync ledger open must reject owned account"),
        Err(error) => error,
    };
    assert_eq!(step_error, OWNERSHIP_CHANGED);
}
