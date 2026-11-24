use std::path::Path;

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::json;
use taomni_mail_api::{
    archive_index::ArchiveEntry,
    archive_original::{
        ArchiveOriginalRequest, ImapArchiveAction, ImapArchiveRequest, OPEN_ARCHIVE_ORIGINAL,
        READ_IMAP_ARCHIVE,
    },
    calendar::{DECODE_INVITE, MailInvite},
    imap_exchange::{AttachmentReceipt, read_body_frame, write_body_frame},
    message::MailMessageBody,
    pop3_store::{LocalArchiveAction, Pop3AttachmentRequest, READ_POP3_ATTACHMENT},
};
use taomni_mail_engine::{
    cache::init_mail_tables, database::mail_db_file_stem, pop3::local_store::migrate_local_tables,
};
use taomni_plugin_api::ErrorCode;
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::{AsyncReadExt, DuplexStream};

use super::{ACCOUNT, ARCHIVED_AT, MailHost, WAIT};

pub(super) const ORIGINAL: &str = concat!(
    "Subject: Original\r\nMIME-Version: 1.0\r\n",
    "Content-Type: multipart/mixed; boundary=migrated\r\n\r\n",
    "--migrated\r\nContent-Type: text/plain\r\n\r\nComplete migrated message\r\n",
    "--migrated\r\nContent-Type: application/octet-stream\r\n",
    "Content-Disposition: attachment; filename=original.bin\r\n",
    "Content-Transfer-Encoding: base64\r\n\r\nAH+A/w==\r\n",
    "--migrated--\r\n",
);
const ATTACHMENT: &[u8] = &[0x00, 0x7f, 0x80, 0xff];

pub(super) fn check(host: &mut MailHost, database: &Path) {
    let entry = ArchiveEntry {
        folder: "INBOX".into(),
        uid: 9,
        uid_validity: 1,
        subject: "Original".into(),
        raw_size: ORIGINAL.len() as u64,
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
    let body: MailMessageBody = serde_json::from_slice(&reply).unwrap();
    assert_eq!(body.account_id, ACCOUNT);
    assert_eq!(body.folder, "INBOX");
    assert_eq!(body.uid, 9);
    assert_eq!(body.source, "archive");
    assert_eq!(
        body.text.as_deref().map(str::trim),
        Some("Complete migrated message")
    );
    assert_eq!(body.attachments.len(), 1);
    assert_eq!(body.attachments[0].name.as_deref(), Some("original.bin"));
    let exported = transfer(
        host,
        database,
        LocalArchiveAction::Export {
            entry: entry.clone(),
            attachment_index: None,
        },
    );
    assert_eq!(exported, ORIGINAL.as_bytes());
    let attachment = transfer(
        host,
        database,
        LocalArchiveAction::Export {
            entry,
            attachment_index: Some(0),
        },
    );
    assert_eq!(attachment, ATTACHMENT);

    for (index, section) in [(0, None), (42, Some("2".into()))] {
        exchange(
            host,
            READ_IMAP_ARCHIVE,
            ImapArchiveRequest {
                account_id: ACCOUNT.into(),
                database: database.into(),
                folder: "INBOX".into(),
                uid: 9,
                action: ImapArchiveAction::Attachment { index, section },
            },
            async |mut peer| {
                let header = read_body_frame(&mut peer).await.unwrap();
                let receipt: Option<AttachmentReceipt> = serde_json::from_slice(&header).unwrap();
                let receipt = receipt.unwrap();
                assert_eq!(receipt.name.as_deref(), Some("original.bin"));
                assert_eq!(
                    receipt.content_type.as_deref(),
                    Some("application/octet-stream")
                );
                assert_eq!(receipt.size, ATTACHMENT.len());
                let mut bytes = Vec::new();
                peer.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, ATTACHMENT);
            },
        );
    }
}

fn transfer(host: &mut MailHost, database: &Path, action: LocalArchiveAction) -> Vec<u8> {
    exchange(
        host,
        OPEN_ARCHIVE_ORIGINAL,
        ArchiveOriginalRequest {
            account_id: ACCOUNT.into(),
            database: database.into(),
            action,
        },
        async |mut peer| read_body_frame(&mut peer).await.unwrap(),
    )
}

pub(super) fn check_invitation(host: &mut MailHost) {
    let invitation = concat!(
        "Subject: Review meeting\r\nMIME-Version: 1.0\r\n",
        "Content-Type: text/calendar; method=REQUEST; charset=utf-8\r\n",
        "Content-Transfer-Encoding: quoted-printable\r\n\r\n",
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:review-fixture\r\n",
        "SUMMARY:R=C3=A9union de revue\r\nDTSTART:20261124T090000Z\r\n",
        "ORGANIZER:mailto:organizer@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    );
    let decode = |host: &mut MailHost, raw: &str| {
        exchange_bytes(host, DECODE_INVITE, raw.as_bytes(), async |mut peer| {
            let frame = read_body_frame(&mut peer).await.unwrap();
            serde_json::from_slice::<Option<MailInvite>>(&frame).unwrap()
        })
    };
    let invite = decode(host, invitation).unwrap();
    assert_eq!(invite.method, "REQUEST");
    assert_eq!(invite.uid, "review-fixture");
    assert_eq!(invite.summary, "Réunion de revue");
    assert_eq!(invite.start.unwrap().tzid.as_deref(), Some("UTC"));
    assert_eq!(invite.organizer.unwrap().email, "organizer@example.test");
    assert!(decode(host, ORIGINAL).is_none());
}

pub(super) fn check_pop3_attachment(host: &mut MailHost, owned_legacy_source: &Path) {
    let read_part = |host: &mut MailHost, account_id: &str, legacy_database| {
        exchange(
            host,
            READ_POP3_ATTACHMENT,
            Pop3AttachmentRequest {
                account_id: account_id.into(),
                legacy_database,
                folder: "Sent".into(),
                uid: 4,
                index: 0,
            },
            async |mut peer| {
                let header = read_body_frame(&mut peer).await.unwrap();
                let receipt = serde_json::from_slice::<Option<AttachmentReceipt>>(&header)
                    .unwrap()
                    .unwrap();
                assert_eq!(receipt.name.as_deref(), Some("original.bin"));
                assert_eq!(
                    receipt.content_type.as_deref(),
                    Some("application/octet-stream")
                );
                assert_eq!(receipt.size, ATTACHMENT.len());
                let mut bytes = Vec::new();
                peer.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, ATTACHMENT);
            },
        );
    };

    // 1. Owned mailbox reads from the module database.
    read_part(host, ACCOUNT, None);

    // 2. Stale legacy path for an already-owned account is rejected.
    check_stale_pop3_attachment(host, owned_legacy_source);

    // 3. Unowned legacy mailbox path decodes directly from the retained database.
    let temp = tempfile::tempdir().unwrap();
    let legacy_account = "legacy-pop3-attachment";
    let unowned_db = temp
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(legacy_account)));
    {
        let db = Connection::open(&unowned_db).unwrap();
        init_mail_tables(&db).unwrap();
        migrate_local_tables(&db).unwrap();
        db.execute(
            "INSERT INTO mail_local_raw(account_id, folder, uid, raw) VALUES (?1, 'Sent', 4, ?2)",
            params![legacy_account, ORIGINAL.as_bytes()],
        )
        .unwrap();
    }
    read_part(host, legacy_account, Some(unowned_db));
}

fn exchange<T>(
    host: &mut MailHost,
    method: &str,
    request: impl Serialize,
    read: impl AsyncFnOnce(DuplexStream) -> T,
) -> T {
    let request = serde_json::to_vec(&request).unwrap();
    exchange_bytes(host, method, &request, read)
}

fn exchange_bytes<T>(
    host: &mut MailHost,
    method: &str,
    request: &[u8],
    read: impl AsyncFnOnce(DuplexStream) -> T,
) -> T {
    let io = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        io.block_on(async {
            let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
            let call =
                scope.spawn(move || host.call(method, serde_json::to_value(endpoint).unwrap()));
            let reply = tokio::time::timeout(WAIT, async {
                write_body_frame(&mut peer, request).await.unwrap();
                read(peer).await
            })
            .await
            .unwrap();
            assert_eq!(call.join().unwrap(), json!({"Ok": null}));
            reply
        })
    })
}

fn check_stale_pop3_attachment(host: &mut MailHost, owned_legacy_source: &Path) {
    let io = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let stale = serde_json::to_vec(&Pop3AttachmentRequest {
        account_id: ACCOUNT.into(),
        legacy_database: Some(owned_legacy_source.to_path_buf()),
        folder: "Sent".into(),
        uid: 4,
        index: 0,
    })
    .unwrap();
    std::thread::scope(|scope| {
        io.block_on(async {
            let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
            let call = scope.spawn(move || {
                host.send(READ_POP3_ATTACHMENT, serde_json::to_value(endpoint).unwrap())
            });
            tokio::time::timeout(WAIT, write_body_frame(&mut peer, &stale))
                .await
                .unwrap()
                .unwrap();
            let response = call.join().unwrap();
            let err = response.error.expect("stale legacy path must fail");
            assert_eq!(err.code, ErrorCode::InvalidState as i32);
            assert!(err.message.contains("POP3 mailbox ownership has changed"));
        });
    });
}
