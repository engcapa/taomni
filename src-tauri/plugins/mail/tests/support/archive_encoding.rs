//! Exercise the stdio request and its authenticated byte stream in a real host.
use super::{ACCOUNT, ARCHIVED_AT, MailHost, WAIT};
use serde_json::json;
use taomni_mail_api::{
    DECODE_ARCHIVE_ATTACHMENT, DECODE_ARCHIVE_ORIGINAL, ENCODE_ARCHIVE_ORIGINAL,
    archive::{
        ARCHIVE_FRAME_BYTES, ArchiveAttachmentDecoding, ArchiveDecoding, ArchiveEncoding,
        PUBLISH_IMAP_ARCHIVE, PublishArchiveOriginal, receive_encoding,
    },
    archive_index::{
        ArchiveIndexAction, ArchiveIndexRequest, ArchiveIndexSource, ArchiveKey, ArchivePage,
        ArchiveQuery, ArchiveSelection, CLEANUP_ARCHIVE_INDEX, CleanupPreview, QUERY_ARCHIVE_INDEX,
        SearchField,
    },
    imap_exchange::{read_body_frame, read_frame, write_body_frame, write_frame},
    message::MailMessageBody,
};
use taomni_mail_engine::{
    archive::verify_message, cache::init_mail_tables, database::mail_db_file_stem, storage,
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) fn check(host: &mut MailHost) {
    let io = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let mut raw = b"Content-Disposition: attachment; filename=archive.bin\r\n\r\n".to_vec();
    let mut state = 17_u32;
    for _ in 0..5 * ARCHIVE_FRAME_BYTES {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        raw.push((state >> 24) as u8);
    }
    // The IO worker serves the route while the test thread awaits the stdio reply.
    for cancelled in [true, true, false] {
        let (_route, exchange, mut peer) = io.block_on(Route::pair()).unwrap();
        let request = ArchiveEncoding {
            exchange,
            raw_size: raw.len() as u64,
        };
        assert_eq!(
            host.call(
                ENCODE_ARCHIVE_ORIGINAL,
                serde_json::to_value(request).unwrap()
            ),
            json!({"Ok": null})
        );
        if cancelled {
            io.block_on(peer.write_all(&raw[..11])).unwrap();
            continue;
        }
        let mut gzip = Vec::new();
        let object = io.block_on(async {
            let (reader, mut writer) = tokio::io::split(peer);
            tokio::time::timeout(WAIT, async {
                let (sent, result) = tokio::join!(
                    writer.write_all(&raw),
                    receive_encoding(&mut gzip, raw.len() as u64, reader, WAIT)
                );
                sent.unwrap();
                result.unwrap()
            })
            .await
            .unwrap()
        });
        assert!(object.has_attachments);
        assert_eq!(object.raw_size, raw.len() as u64);
        assert!(gzip.len() > ARCHIVE_FRAME_BYTES);
        let mut decoded = Vec::new();
        verify_message(gzip.as_slice(), &object.hash, object.raw_size, &mut decoded).unwrap();
        assert_eq!(decoded, raw);
    }
    check_publication(host, &io);
}

pub(super) fn check_decoding(host: &mut MailHost) {
    let io = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let (_route, exchange, mut peer) = io.block_on(Route::pair()).unwrap();
    let request = ArchiveDecoding {
        exchange,
        account_id: ACCOUNT.into(),
        folder: "Archive".into(),
        uid: 71,
    };
    let raw = concat!(
        "Subject: Stored original\r\n",
        "Content-Type: multipart/mixed; boundary=mail-test\r\n\r\n",
        "--mail-test\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nOffline payload\r\n",
        "--mail-test\r\nContent-Type: application/octet-stream\r\n",
        "Content-Disposition: attachment; filename=file.bin\r\n\r\nbytes\r\n",
        "--mail-test--\r\n",
    );
    let sent = host.write_request(
        DECODE_ARCHIVE_ORIGINAL,
        serde_json::to_value(request).unwrap(),
    );
    let body: MailMessageBody = io.block_on(async {
        tokio::time::timeout(WAIT, async {
            write_body_frame(&mut peer, raw.as_bytes()).await.unwrap();
            serde_json::from_slice(&read_body_frame(&mut peer).await.unwrap()).unwrap()
        })
        .await
        .unwrap()
    });
    let response = host.read_response();
    assert_eq!(response.id, Some(sent));
    assert_eq!(response.result, Some(json!({"Ok": null})));
    assert_eq!(body.account_id, ACCOUNT);
    assert_eq!(body.folder, "Archive");
    assert_eq!(body.uid, 71);
    assert_eq!(body.source, "archive");
    assert_eq!(body.subject, "Stored original");
    assert_eq!(body.text.as_deref().map(str::trim), Some("Offline payload"));
    assert_eq!(body.attachments[0].name.as_deref(), Some("file.bin"));

    let (_route, exchange, mut peer) = io.block_on(Route::pair()).unwrap();
    let request = ArchiveAttachmentDecoding {
        exchange,
        attachment_index: 0,
    };
    let sent = host.write_request(
        DECODE_ARCHIVE_ATTACHMENT,
        serde_json::to_value(request).unwrap(),
    );
    let attachment = io.block_on(async {
        tokio::time::timeout(WAIT, async {
            write_body_frame(&mut peer, raw.as_bytes()).await.unwrap();
            read_body_frame(&mut peer).await.unwrap()
        })
        .await
        .unwrap()
    });
    let response = host.read_response();
    assert_eq!(response.id, Some(sent));
    assert_eq!(response.result, Some(json!({"Ok": null})));
    assert_eq!(attachment, b"bytes");

    let request = ArchiveIndexRequest {
        account_id: ACCOUNT.into(),
        source: ArchiveIndexSource::ModuleData,
        action: ArchiveIndexAction::Find {
            query: ArchiveQuery {
                text: "original".into(),
                field: SearchField::Subject,
                ..Default::default()
            },
            offset: 200,
        },
    };
    let page: ArchivePage = request_index(host, &io, QUERY_ARCHIVE_INDEX, request);
    assert_eq!(page.offset, 0);
    assert_eq!(page.total, 1);
    assert_eq!(page.folders, ["INBOX"]);
    assert_eq!(page.entries[0].entry.uid, 9);
    assert_eq!(page.entries[0].entry.stored_at, ARCHIVED_AT);
}

fn request_index<T: serde::de::DeserializeOwned>(
    host: &mut MailHost,
    io: &tokio::runtime::Runtime,
    method: &str,
    request: ArchiveIndexRequest,
) -> T {
    let (_route, exchange, mut peer) = io.block_on(Route::pair()).unwrap();
    let sent = host.write_request(method, serde_json::to_value(exchange).unwrap());
    let reply = io.block_on(async {
        tokio::time::timeout(WAIT, async {
            assert_eq!(peer.read_u8().await.unwrap(), 1);
            write_frame(&mut peer, &serde_json::to_vec(&request).unwrap())
                .await
                .unwrap();
            let reply = read_body_frame(&mut peer).await.unwrap();
            serde_json::from_slice::<Result<_, String>>(&reply)
                .unwrap()
                .unwrap()
        })
        .await
        .unwrap()
    });
    let response = host.read_response();
    assert_eq!(response.id, Some(sent));
    assert_eq!(response.result, Some(json!({"Ok": null})));
    reply
}

fn check_publication(host: &mut MailHost, io: &tokio::runtime::Runtime) {
    let cache = tempfile::tempdir().unwrap();
    let account = "signed-archive-fixture";
    let path = cache
        .path()
        .canonicalize()
        .unwrap()
        .join(format!("{}.db", mail_db_file_stem(account)));
    let db = rusqlite::Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    let root = storage::account_root(&db, account).unwrap();
    let raw = b"Subject: External cache archive\r\n\r\nComplete original";
    let key = ArchiveKey {
        folder: "Archive".into(),
        uid: 41,
        uid_validity: 23,
    };
    let (_temporary, staged) = storage::prepare(&root, &raw[..], || Ok(()))
        .unwrap()
        .stage()
        .unwrap();
    let (_route, endpoint, mut peer) = io.block_on(Route::pair()).unwrap();
    let sent = host.write_request(
        PUBLISH_IMAP_ARCHIVE,
        serde_json::to_value(endpoint).unwrap(),
    );
    let request = PublishArchiveOriginal {
        account_id: account.into(),
        cache_database: path.clone(),
        key: key.clone(),
        staged,
    };
    io.block_on(async {
        tokio::time::timeout(WAIT, async {
            assert_eq!(peer.read_u8().await.unwrap(), 1);
            write_frame(&mut peer, &serde_json::to_vec(&request).unwrap())
                .await
                .unwrap();
            let reply = read_frame(&mut peer).await.unwrap();
            serde_json::from_slice::<Result<(), String>>(&reply)
                .unwrap()
                .unwrap();
        })
        .await
        .unwrap();
    });
    let response = host.read_response();
    assert_eq!(response.id, Some(sent));
    assert_eq!(response.result, Some(json!({"Ok": null})));
    let file = storage::open(&db, account, "Archive", 41).unwrap().unwrap();
    assert_eq!(file.read().unwrap(), raw);
    let cleanup = |action| ArchiveIndexRequest {
        account_id: account.into(),
        source: ArchiveIndexSource::AccountCache {
            database: path.clone(),
        },
        action,
    };
    let preview: CleanupPreview = request_index(
        host,
        io,
        CLEANUP_ARCHIVE_INDEX,
        cleanup(ArchiveIndexAction::Preview {
            selection: ArchiveSelection {
                query: None,
                keys: vec![key],
                excluded: Vec::new(),
            },
        }),
    );
    assert_eq!(preview.count, 1);
    assert!(
        storage::open(&db, account, "Archive", 41)
            .unwrap()
            .is_some()
    );
    let removed: u64 = request_index(
        host,
        io,
        CLEANUP_ARCHIVE_INDEX,
        cleanup(ArchiveIndexAction::Cleanup {
            token: preview.token,
        }),
    );
    assert_eq!(removed, 1);
    assert!(
        storage::open(&db, account, "Archive", 41)
            .unwrap()
            .is_none()
    );
    assert!(storage::scan::is_paused(&db, account).unwrap());
}
