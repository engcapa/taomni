//! Exercise the stdio request and its authenticated byte stream in a real host.
use super::{ACCOUNT, MailHost, WAIT};
use serde_json::json;
use taomni_mail_api::{
    DECODE_ARCHIVE_ORIGINAL, ENCODE_ARCHIVE_ORIGINAL,
    archive::{ARCHIVE_FRAME_BYTES, ArchiveDecoding, ArchiveEncoding, receive_encoding},
    imap_exchange::{read_body_frame, write_body_frame},
    message::MailMessageBody,
};
use taomni_mail_engine::archive::verify_message;
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::AsyncWriteExt;

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
}
