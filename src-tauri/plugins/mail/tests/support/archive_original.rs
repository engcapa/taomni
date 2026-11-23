use std::path::Path;

use serde_json::{Value, json};
use taomni_mail_api::{
    archive_index::ArchiveEntry,
    archive_original::{ArchiveOriginalRequest, OPEN_ARCHIVE_ORIGINAL},
    imap_exchange::{read_body_frame, write_body_frame},
    pop3_store::LocalArchiveAction,
};
use taomni_plugin_stream::routed_tcp::Route;

use super::{ACCOUNT, ARCHIVED_AT, MailHost, WAIT};

pub(super) fn check(host: &mut MailHost, database: &Path) {
    let raw = b"Subject: Original\r\n\r\nComplete migrated message\r\n";
    let entry = ArchiveEntry {
        folder: "INBOX".into(),
        uid: 9,
        uid_validity: 1,
        subject: "Original".into(),
        raw_size: raw.len() as u64,
        stored_size: 0,
        stored_at: ARCHIVED_AT,
    };
    let reply = transfer(
        host,
        database,
        LocalArchiveAction::Read {
            entry: entry.clone(),
        },
    );
    let body: Value = serde_json::from_slice(&reply).unwrap();
    assert_eq!(body["accountId"], ACCOUNT);
    assert_eq!(body["folder"], "INBOX");
    assert_eq!(body["uid"], 9);
    assert_eq!(body["source"], "archive");
    assert!(
        body["text"]
            .as_str()
            .unwrap()
            .contains("Complete migrated message")
    );
    let exported = transfer(
        host,
        database,
        LocalArchiveAction::Export {
            entry,
            attachment_index: None,
        },
    );
    assert_eq!(exported, raw);
}

fn transfer(host: &mut MailHost, database: &Path, action: LocalArchiveAction) -> Vec<u8> {
    let request = serde_json::to_vec(&ArchiveOriginalRequest {
        account_id: ACCOUNT.into(),
        database: database.into(),
        action,
    })
    .unwrap();
    let io = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        io.block_on(async {
            let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
            let call = scope.spawn(move || {
                host.call(
                    OPEN_ARCHIVE_ORIGINAL,
                    serde_json::to_value(endpoint).unwrap(),
                )
            });
            let bytes = tokio::time::timeout(WAIT, async {
                write_body_frame(&mut peer, &request).await.unwrap();
                read_body_frame(&mut peer).await.unwrap()
            })
            .await
            .unwrap();
            assert_eq!(call.join().unwrap(), json!({"Ok": null}));
            bytes
        })
    })
}
