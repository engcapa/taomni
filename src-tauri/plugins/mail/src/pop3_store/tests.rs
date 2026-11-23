use super::*;
use taomni_mail_api::archive_index::ArchiveSelection;
use taomni_mail_api::pop3_store::LocalArchiveAction;
use taomni_mail_engine::{MailFolder, MailMessageBody, storage};

const ACCOUNT: &str = "pop3-unit-test";

fn call<T: serde::de::DeserializeOwned>(store: &Store, action: LocalMailboxAction) -> T {
    let request = MailboxRequest {
        account_id: ACCOUNT.into(),
        action,
    };
    serde_json::from_slice(&execute(store, request, &|| Ok(())).unwrap()).unwrap()
}

#[test]
fn mailbox_keeps_original_identity_across_move_and_archive_cleanup() {
    use LocalMailboxAction::*;

    let directory = tempfile::tempdir().unwrap();
    let store = Store::new(directory.path());
    let _: () = call(&store, Initialize);
    let raw = b"Subject: Local message\r\n\r\nPop3 body \x80\xff\r\n";
    let count: usize = call(
        &store,
        Append {
            folder: "INBOX".into(),
            originals: vec![raw.to_vec()],
            sent_recipients: Vec::new(),
        },
    );
    assert_eq!(count, 1);
    let moved: usize = call(
        &store,
        MoveOrCopy {
            folder: "INBOX".into(),
            target: "Sent".into(),
            uids: vec![1],
            copy: false,
        },
    );
    assert_eq!(moved, 1);
    let folders: Vec<MailFolder> = call(
        &store,
        RenameFolder {
            from: "Sent".into(),
            to: "Saved".into(),
        },
    );
    assert!(
        folders
            .iter()
            .any(|folder| folder.name == "Saved" && folder.total == Some(1))
    );
    let targets: Vec<storage::query::ArchiveKey> =
        call(&store, Archive(LocalArchiveAction::Pending));
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].folder, "Saved");
    let stored: bool = call(
        &store,
        Archive(LocalArchiveAction::Store {
            key: targets[0].clone(),
        }),
    );
    assert!(stored);
    let db = store.open_writable_mailbox(ACCOUNT).unwrap();
    let entry = storage::list(&db, ACCOUNT, 0).unwrap().pop().unwrap();
    let archived: MailMessageBody = call(&store, Archive(LocalArchiveAction::Read { entry }));
    assert!(archived.text.as_deref().unwrap().contains("Pop3 body"));
    let preview: storage::query::CleanupPreview = call(
        &store,
        Archive(LocalArchiveAction::Preview {
            selection: ArchiveSelection {
                keys: targets,
                query: None,
                excluded: Vec::new(),
            },
        }),
    );
    let removed: u64 = call(
        &store,
        Archive(LocalArchiveAction::Cleanup {
            token: preview.token,
        }),
    );
    assert_eq!(removed, 1);
    assert!(storage::list(&db, ACCOUNT, 0).unwrap().is_empty());
    let remaining: Option<Vec<u8>> = call(
        &store,
        Raw {
            folder: "Saved".into(),
            uid: 1,
        },
    );
    assert_eq!(remaining.as_deref(), Some(raw.as_slice()));
}
