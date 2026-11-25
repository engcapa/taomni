use std::net::Ipv4Addr;

use taomni_mail_api::{
    DISCARD_IMAP_DRAFT, FETCH_IMAP_ATTACHMENT, FETCH_IMAP_BODY, ImapDraftDiscard, ImapDraftStore,
    ImapSentCopy, IncomingTest, MailAuthMode, MailConnectionSecurity, MailIncomingProtocol,
    MailProvider, MimeUpload, PREFETCH_IMAP_BODIES, RemoteDraftLocation, STORE_IMAP_DRAFT,
    STORE_IMAP_SENT, SYNC_IMAP_PAGE,
    imap_exchange::{
        AttachmentReceipt, AttachmentRequest, ImapExchange, PrefetchBodies, read_body_frame,
        read_frame, write_frame,
    },
};
use taomni_mail_engine::{
    archive::{ArchiveChunk, ArchiveQuery, CHUNK},
    imap_sync::{HeaderPageOutcome, HeaderPageRequest},
    imap_transport::{ImapBodyReply, ImapBodyRequest},
};
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

use super::{MailHost, WAIT};

pub(super) const HEADER: &str =
    "From: sender@example.test\r\nSubject: Routed body\r\nContent-Type: text/plain\r\n\r\n";
pub(super) const TEXT: &str = "Body from the routed IMAP connection\r\n";

pub(super) fn check_routed_header_pages(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for (offset, uid) in [(0, 24), (1, 23)] {
        std::thread::scope(|scope| {
            runtime.block_on(async {
                let (listener, _route, connection) = routed_mailbox().await;
                let (_exchange, exchange, mut peer) = Route::pair().await.unwrap();
                let request = ImapExchange {
                    connection,
                    exchange,
                };
                let (publish, response) = oneshot::channel();
                let host = &mut *host;
                scope.spawn(move || {
                    let result = host.call(SYNC_IMAP_PAGE, serde_json::to_value(request).unwrap());
                    publish.send(result).unwrap();
                });
                let list_folders = offset == 0;
                let page = HeaderPageRequest {
                    account_id: "routed-mail".into(),
                    folder: "INBOX".into(),
                    offset,
                    limit: 1,
                    list_folders,
                };
                let read = async {
                    write_frame(&mut peer, &serde_json::to_vec(&page).unwrap())
                        .await
                        .unwrap();
                    let reply: Result<HeaderPageOutcome, String> =
                        serde_json::from_slice(&read_frame(&mut peer).await.unwrap()).unwrap();
                    let reply = reply.unwrap();
                    assert_eq!(reply.has_more, offset == 0);
                    assert_eq!(reply.selected.name, page.folder);
                    assert_eq!(reply.selected.account_id, page.account_id);
                    assert_eq!(reply.selected.total, Some(2));
                    assert_eq!(reply.messages.len(), 1);
                    assert_eq!(reply.messages[0].header.uid, uid);
                    assert!(reply.messages[0].body_cached_at.is_none());
                    if list_folders {
                        assert_eq!(reply.folders.unwrap()[0].name, "INBOX");
                    } else {
                        assert!(reply.folders.is_none());
                    }
                };
                let fixture = FixtureFetch::Page {
                    uids: vec![uid],
                    list_folders,
                };
                let (response, (), ()) = tokio::time::timeout(WAIT, async {
                    tokio::join!(response, read, serve(listener, fixture))
                })
                .await
                .unwrap();
                serde_json::from_value::<Result<(), String>>(response.unwrap())
                    .unwrap()
                    .unwrap();
            });
        });
    }
}

pub(super) fn check_routed_body(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        runtime.block_on(async {
            let (listener, _route, connection) = routed_mailbox().await;
            let (_exchange, exchange, mut peer) = Route::pair().await.unwrap();
            let request = ImapExchange {
                connection,
                exchange,
            };
            let (publish, response) = oneshot::channel();
            scope.spawn(move || {
                let result = host.call(FETCH_IMAP_BODY, serde_json::to_value(request).unwrap());
                publish.send(result).unwrap();
            });
            tokio::time::timeout(WAIT, async {
                let read = async {
                    let step = ImapBodyRequest {
                        account_id: "routed-mail".into(),
                        folder: "INBOX".into(),
                        uid: 23,
                        body_max_bytes: 1024,
                        save_original: true,
                    };
                    write_frame(&mut peer, &serde_json::to_vec(&step).unwrap())
                        .await
                        .unwrap();
                    let reply: Result<ImapBodyReply, String> =
                        serde_json::from_slice(&read_body_frame(&mut peer).await.unwrap()).unwrap();
                    let original = read_frame(&mut peer).await.unwrap();
                    let reply = reply.unwrap();
                    assert_eq!(reply.message.header.account_id, step.account_id);
                    assert_eq!(reply.message.header.folder, step.folder);
                    assert_eq!(reply.message.header.uid, step.uid);
                    assert_eq!(reply.message.header.subject, "Routed body");
                    assert!(
                        reply
                            .message
                            .body_text
                            .as_deref()
                            .unwrap()
                            .contains(TEXT.trim())
                    );
                    assert_eq!(reply.original_size, Some(original.len()));
                    assert_eq!(original, format!("{HEADER}{TEXT}").as_bytes());
                };
                let (response, (), ()) =
                    tokio::join!(response, read, serve(listener, FixtureFetch::Body));
                serde_json::from_value::<Result<(), String>>(response.unwrap())
                    .unwrap()
                    .unwrap();
            })
            .await
            .expect("IMAP request bounded by the host fixture");
        });
    });
}

pub(super) fn check_routed_attachment(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for section in [None, Some("2")] {
        std::thread::scope(|scope| {
            runtime.block_on(async {
                let (listener, _route, connection) = routed_mailbox().await;
                let (_exchange, exchange, mut peer) = Route::pair().await.unwrap();
                let request = AttachmentRequest {
                    connection,
                    exchange,
                    folder: "INBOX".into(),
                    uid: 23,
                    index: 0,
                    section: section.map(str::to_owned),
                };
                let (publish, response) = oneshot::channel();
                let host = &mut *host;
                scope.spawn(move || {
                    let value = host.call(
                        FETCH_IMAP_ATTACHMENT,
                        serde_json::to_value(request).unwrap(),
                    );
                    publish.send(value).unwrap();
                });
                let fixture = if section.is_some() {
                    FixtureFetch::Section
                } else {
                    FixtureFetch::Attachment
                };
                let (value, bytes, ()) = tokio::time::timeout(WAIT, async {
                    let read = async {
                        let mut bytes = Vec::new();
                        peer.read_to_end(&mut bytes).await.unwrap();
                        bytes
                    };
                    tokio::join!(response, read, serve(listener, fixture))
                })
                .await
                .expect("the attachment transfer terminates within the fixture timeout");
                let receipt: Result<AttachmentReceipt, String> =
                    serde_json::from_value(value.unwrap()).unwrap();
                let receipt = receipt.unwrap();
                assert_eq!(receipt.size, bytes.len());
                assert_eq!(bytes, b"%QA\xff\0");
                if section.is_some() {
                    assert!(receipt.name.is_none());
                } else {
                    assert_eq!(receipt.name.as_deref(), Some("fixture.bin"));
                    assert_eq!(
                        receipt.content_type.as_deref(),
                        Some("application/octet-stream")
                    );
                }
            });
        });
    }
}

pub(super) fn check_routed_prefetch(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        runtime.block_on(async {
            tokio::time::timeout(WAIT, async {
                let (listener, _route, connection) = routed_mailbox().await;
                let (_exchange, exchange, mut peer) = Route::pair().await.unwrap();
                let request = ImapExchange {
                    connection,
                    exchange,
                };
                let (publish, acknowledged) = oneshot::channel();
                scope.spawn(move || {
                    let result =
                        host.call(PREFETCH_IMAP_BODIES, serde_json::to_value(request).unwrap());
                    serde_json::from_value::<Result<(), String>>(result)
                        .unwrap()
                        .unwrap();
                    // A prefetch awaiting its data must leave the RPC worker available.
                    let folders = host.call(
                        "mail_list_cached_folders",
                        serde_json::json!({"accountId": "existing-mail"}),
                    );
                    assert_eq!(folders[0]["name"], "INBOX");
                    publish.send(()).unwrap();
                });
                let receive = async {
                    acknowledged.await.unwrap();
                    let batch = PrefetchBodies {
                        account_id: "existing-mail".into(),
                        folder: "INBOX".into(),
                        uids: vec![23, 24],
                        body_max_bytes: 1024,
                        save_original: true,
                    };
                    write_frame(&mut peer, &serde_json::to_vec(&batch).unwrap())
                        .await
                        .unwrap();
                    for uid in batch.uids {
                        let reply: Result<ImapBodyReply, String> =
                            serde_json::from_slice(&read_body_frame(&mut peer).await.unwrap())
                                .unwrap();
                        let original = read_frame(&mut peer).await.unwrap();
                        let reply = reply.unwrap();
                        assert_eq!(reply.message.header.account_id, batch.account_id);
                        assert_eq!(reply.message.header.folder, batch.folder);
                        assert_eq!(reply.message.header.uid, uid);
                        assert!(reply.message.body_text.unwrap().contains(TEXT.trim()));
                        assert_eq!(reply.original_size, Some(original.len()));
                        assert_eq!(original, format!("{HEADER}{TEXT}").as_bytes());
                    }
                    let mut tail = Vec::new();
                    peer.read_to_end(&mut tail).await.unwrap();
                    assert!(tail.is_empty());
                };
                tokio::join!(receive, serve(listener, FixtureFetch::Prefetch));
            })
            .await
            .expect("The background connection and its exchange must end");
        });
    });
}

pub(super) fn check_routed_archive(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        runtime.block_on(async {
            tokio::time::timeout(WAIT, async {
                let (listener, incoming, connection) = routed_mailbox().await;
                let (exchange_guard, exchange, mut peer) = Route::pair().await.unwrap();
                let request = ImapExchange {
                    connection,
                    exchange,
                };
                let (publish, response) = oneshot::channel();
                scope.spawn(move || {
                    publish
                        .send(host.call(
                            taomni_mail_api::OPEN_IMAP_ARCHIVE,
                            serde_json::to_value(request).unwrap(),
                        ))
                        .unwrap();
                });
                let read = async move {
                    serde_json::from_value::<Result<(), String>>(response.await.unwrap())
                        .unwrap()
                        .unwrap();
                    let frame = read_frame(&mut peer).await.unwrap();
                    serde_json::from_slice::<Result<(), String>>(&frame)
                        .unwrap()
                        .unwrap();
                    let original = format!("{HEADER}{TEXT}").into_bytes();
                    for (offset, expected) in
                        [(0, original.as_slice()), (original.len() as u64, &[])]
                    {
                        let query = ArchiveQuery::Chunk {
                            folder: "INBOX".into(),
                            uid: 23,
                            offset,
                        };
                        write_frame(&mut peer, &serde_json::to_vec(&query).unwrap())
                            .await
                            .unwrap();
                        let frame = read_frame(&mut peer).await.unwrap();
                        let reply = serde_json::from_slice::<Result<ArchiveChunk, String>>(&frame)
                            .unwrap()
                            .unwrap();
                        assert_eq!(reply.uid_validity, 2);
                        assert_eq!(reply.reported_size as usize, original.len());
                        assert_eq!(reply.length, expected.len());
                        assert_eq!(read_frame(&mut peer).await.unwrap(), expected);
                    }
                    drop(peer);
                    drop(exchange_guard);
                    drop(incoming);
                };
                tokio::join!(read, serve(listener, FixtureFetch::Archive));
            })
            .await
            .expect("The archive session must close when its controlling exchange ends");
        })
    });
}

pub(super) fn check_routed_sent_copy(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        runtime.block_on(async {
            let (listener, _route, connection) = routed_mailbox().await;
            let mime = format!("{HEADER}{TEXT}").into_bytes();
            let (_offer, source) = Route::offer_bytes(mime.clone()).await.unwrap();
            let request = ImapSentCopy {
                connection,
                account_id: "routed-mail".into(),
                folder_override: Some("Chosen Sent".into()),
                mime: Some(MimeUpload {
                    source,
                    length: mime.len() as u64,
                }),
                remote_draft: None,
            };
            let (publish, response) = oneshot::channel();
            scope.spawn(move || {
                let value = host.call(STORE_IMAP_SENT, serde_json::to_value(request).unwrap());
                publish.send(value).unwrap();
            });
            let (value, ()) = tokio::time::timeout(WAIT, async {
                tokio::join!(response, serve_outgoing(listener, Outgoing::Sent(&mime)))
            })
            .await
            .expect("Sent copy transfer completes within the fixture timeout");
            let folder: Result<Option<String>, String> =
                serde_json::from_value(value.unwrap()).unwrap();
            assert_eq!(folder.unwrap().as_deref(), Some("Chosen Sent"));
        });
    });
}

pub(super) fn check_routed_draft(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let location = std::thread::scope(|scope| {
        runtime.block_on(async {
            let (listener, _route, connection) = routed_mailbox().await;
            let mime = format!("Message-ID: <draft@example.test>\r\n{HEADER}{TEXT}").into_bytes();
            let (_offer, source) = Route::offer_bytes(mime.clone()).await.unwrap();
            let request = ImapDraftStore {
                connection,
                account_id: "routed-mail".into(),
                folder_override: None,
                message_id: "<draft@example.test>".into(),
                mime: MimeUpload {
                    source,
                    length: mime.len() as u64,
                },
                previous: Some(RemoteDraftLocation {
                    folder: "Drafts".into(),
                    uid: 41,
                }),
            };
            let (publish, response) = oneshot::channel();
            let host = &mut *host;
            scope.spawn(move || {
                let value = host.call(STORE_IMAP_DRAFT, serde_json::to_value(request).unwrap());
                publish.send(value).unwrap();
            });
            let (value, ()) = tokio::time::timeout(WAIT, async {
                tokio::join!(response, serve_outgoing(listener, Outgoing::Draft(&mime)))
            })
            .await
            .expect("Draft copy transfer completes within the fixture timeout");
            let location: Result<Option<RemoteDraftLocation>, String> =
                serde_json::from_value(value.unwrap()).unwrap();
            let location = location.unwrap().unwrap();
            assert_eq!(location.folder, "Drafts");
            assert_eq!(location.uid, 42);
            location
        })
    });
    std::thread::scope(|scope| {
        runtime.block_on(async {
            let (listener, _route, connection) = routed_mailbox().await;
            let request = ImapDraftDiscard {
                connection,
                location,
            };
            let (publish, response) = oneshot::channel();
            scope.spawn(move || {
                let value = host.call(DISCARD_IMAP_DRAFT, serde_json::to_value(request).unwrap());
                publish.send(value).unwrap();
            });
            let (value, ()) = tokio::time::timeout(WAIT, async {
                tokio::join!(response, serve_outgoing(listener, Outgoing::Discard))
            })
            .await
            .expect("Draft discard completes within the fixture timeout");
            serde_json::from_value::<Result<(), String>>(value.unwrap())
                .unwrap()
                .unwrap();
        });
    });
}

enum Outgoing<'a> {
    Sent(&'a [u8]),
    Draft(&'a [u8]),
    Discard,
}

async fn serve_outgoing(listener: TcpListener, fixture: Outgoing<'_>) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut stream = BufReader::new(stream);
    stream
        .write_all(b"* OK IMAP fixture ready\r\n")
        .await
        .unwrap();
    let mut line = String::new();
    let mut changes = Vec::new();
    while stream.read_line(&mut line).await.unwrap() != 0 {
        let (tag, input) = line.trim_end().split_once(' ').unwrap();
        let command = input.split_whitespace().next().unwrap();
        let data = match command {
            "LOGIN" | "LSUB" => "",
            "CAPABILITY" => "* CAPABILITY IMAP4rev1 UIDPLUS\r\n",
            "LIST" => concat!(
                "* LIST (\\Sent) \"/\" \"Sent\"\r\n",
                "* LIST () \"/\" \"Chosen Sent\"\r\n",
                "* LIST (\\Drafts) \"/\" \"Drafts\"\r\n"
            ),
            "SELECT" | "EXAMINE" => {
                assert!(input.ends_with("Drafts") || input.ends_with("\"Drafts\""));
                "* 2 EXISTS\r\n* OK [UIDVALIDITY 17] UIDs valid\r\n"
            }
            "APPEND" => {
                let (mime, prefix) = match fixture {
                    Outgoing::Sent(mime) => (mime, "APPEND \"Chosen Sent\" (\\Seen) "),
                    Outgoing::Draft(mime) => (mime, "APPEND \"Drafts\" (\\Draft \\Seen) "),
                    Outgoing::Discard => panic!("discard must not append messages"),
                };
                assert!(input.starts_with(prefix));
                assert!(input.ends_with(&format!("{{{}}}", mime.len())));
                stream.write_all(b"+ send the message\r\n").await.unwrap();
                let mut literal = vec![0; mime.len() + 2];
                stream.read_exact(&mut literal).await.unwrap();
                assert_eq!(&literal[..mime.len()], mime);
                assert_eq!(&literal[mime.len()..], b"\r\n");
                changes.push("append");
                ""
            }
            "UID" if input.starts_with("UID SEARCH ") => {
                assert!(matches!(fixture, Outgoing::Draft(_)));
                assert_eq!(
                    input,
                    "UID SEARCH HEADER Message-ID \"<draft@example.test>\""
                );
                changes.push("find");
                "* SEARCH 42\r\n"
            }
            "UID" => {
                let uid = match fixture {
                    Outgoing::Draft(_) => 41,
                    Outgoing::Discard => 42,
                    Outgoing::Sent(_) => panic!("no draft was supplied for cleanup"),
                };
                if input.starts_with("UID STORE ") {
                    assert_eq!(input, format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)"));
                    changes.push("mark deleted");
                } else {
                    assert_eq!(input, format!("UID EXPUNGE {uid}"));
                    changes.push("expunge");
                }
                ""
            }
            "LOGOUT" => "* BYE goodbye\r\n",
            _ => panic!("unexpected IMAP command {command}"),
        };
        stream
            .write_all(format!("{data}{tag} OK done\r\n").as_bytes())
            .await
            .unwrap();
        if command == "LOGOUT" {
            break;
        }
        line.clear();
    }
    let expected: &[&str] = match fixture {
        Outgoing::Sent(_) => &["append"],
        Outgoing::Draft(_) => &["append", "find", "mark deleted", "expunge"],
        Outgoing::Discard => &["mark deleted", "expunge"],
    };
    assert_eq!(changes, expected);
}

pub(super) async fn routed_mailbox() -> (TcpListener, Route, IncomingTest) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let (route, endpoint): (Route, Endpoint) = Route::bind(move || async move {
        let stream = TcpStream::connect(address)
            .await
            .map_err(|error| error.to_string())?;
        Ok((stream, address))
    })
    .await
    .unwrap();
    let connection = IncomingTest {
        route: endpoint,
        server_name: "imap.test".into(),
        security: MailConnectionSecurity::None,
        trusted_certificate: None,
        protocol: MailIncomingProtocol::Imap,
        provider: MailProvider::Custom,
        authentication: MailAuthMode::Password,
        username: "qa".into(),
        secret: "fixture-password".to_owned().into(),
    };
    (listener, route, connection)
}

pub(super) enum FixtureFetch {
    Page { uids: Vec<u32>, list_folders: bool },
    BodyFilter,
    Body,
    Prefetch,
    Archive,
    Attachment,
    Section,
}

impl FixtureFetch {
    fn uids(&self) -> &[u32] {
        match self {
            Self::Page { uids, .. } => uids,
            Self::BodyFilter => &[],
            Self::Prefetch => &[23, 24],
            Self::Archive => &[23, 23],
            _ => &[23],
        }
    }

    fn reply(&self, request: &str, uid: u32) -> String {
        const MIME: &str = concat!(
            "Content-Type: application/octet-stream\r\n",
            "Content-Disposition: attachment; filename=fixture.bin\r\n",
            "Content-Transfer-Encoding: base64\r\n\r\n",
        );
        const BINARY: &str = "JVFB/wA=\r\n";
        match self {
            Self::BodyFilter => unreachable!("body filters must use SEARCH without FETCH"),
            Self::Page { .. } => {
                if request.ends_with("(UID FLAGS)") {
                    return format!("* 1 FETCH (UID {uid} FLAGS ())\r\n");
                }
                if request.ends_with("(UID RFC822.SIZE BODY.PEEK[]<0.1024>)") {
                    let size = HEADER.len() + TEXT.len();
                    return format!(
                        "* 1 FETCH (UID {uid} RFC822.SIZE {size} BODY[]<0> {{{size}}}\r\n{HEADER}{TEXT})\r\n"
                    );
                }
                assert!(
                    request.ends_with("(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])")
                );
                format!(
                    "* 1 FETCH (UID {uid} FLAGS () RFC822.SIZE {} BODY[HEADER] {{{}}}\r\n{HEADER})\r\n",
                    HEADER.len() + TEXT.len(),
                    HEADER.len()
                )
            }
            Self::Archive => {
                let len = HEADER.len() + TEXT.len();
                let size = format!("RFC822.SIZE {len}");
                if request.contains(&format!("BODY.PEEK[]<0.{CHUNK}>")) {
                    format!(
                        "* 1 FETCH (UID {uid} {size} BODY[]<0> {{{len}}}\r\n{HEADER}{TEXT})\r\n"
                    )
                } else {
                    assert!(request.contains(&format!("BODY.PEEK[]<{len}.{CHUNK}>")));
                    format!("* 1 FETCH (UID {uid} {size} BODY[] NIL)\r\n")
                }
            }
            Self::Body | Self::Prefetch => {
                assert!(request.contains("BODY.PEEK[]<0.1024>"));
                format!(
                    "* 1 FETCH (UID {uid} FLAGS () RFC822.SIZE {} BODY[HEADER] {{{}}}\r\n{HEADER} BODY[]<0> {{{}}}\r\n{HEADER}{TEXT})\r\n",
                    HEADER.len() + TEXT.len(),
                    HEADER.len(),
                    HEADER.len() + TEXT.len()
                )
            }
            Self::Attachment => {
                assert!(request.ends_with("(UID BODY.PEEK[])"));
                let message = format!(
                    "From: sender@example.test\r\nSubject: Attachment fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=mail-qa\r\n\r\n--mail-qa\r\nContent-Type: text/plain\r\n\r\nOpen the attachment.\r\n--mail-qa\r\n{MIME}{BINARY}--mail-qa--\r\n"
                );
                format!(
                    "* 1 FETCH (UID 23 BODY[] {{{}}}\r\n{message})\r\n",
                    message.len()
                )
            }
            Self::Section => {
                assert!(request.ends_with("(UID BODY.PEEK[2.MIME] BODY.PEEK[2])"));
                format!(
                    "* 1 FETCH (UID 23 BODY[2.MIME] {{{}}}\r\n{MIME} BODY[2] {{{}}}\r\n{BINARY})\r\n",
                    MIME.len(),
                    BINARY.len()
                )
            }
        }
    }
}

pub(super) async fn serve(listener: TcpListener, fixture: FixtureFetch) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut stream = BufReader::new(stream);
    stream
        .write_all(b"* OK IMAP fixture ready\r\n")
        .await
        .unwrap();
    let mut fetches = 0;
    let mut body_searches = 0;
    let mut line = String::new();
    while stream.read_line(&mut line).await.unwrap() != 0 {
        let (tag, input) = line.trim_end().split_once(' ').unwrap();
        let input = input.to_ascii_uppercase();
        let command = input.split_whitespace().next().unwrap();
        let data = match command {
            "LOGIN" => String::new(),
            "CAPABILITY" => "* CAPABILITY IMAP4rev1\r\n".to_owned(),
            "LIST" | "LSUB"
                if matches!(
                    fixture,
                    FixtureFetch::Page {
                        list_folders: true,
                        ..
                    }
                ) =>
            {
                format!("* {command} () \"/\" \"INBOX\"\r\n")
            }
            "EXAMINE" => {
                assert!(input.ends_with("\"INBOX\"") || input.ends_with(" INBOX"));
                let count = if matches!(
                    fixture,
                    FixtureFetch::Page { .. } | FixtureFetch::BodyFilter
                ) {
                    2
                } else {
                    1
                };
                format!("* {count} EXISTS\r\n* OK [UIDVALIDITY 2] UIDs valid\r\n")
            }
            "UID"
                if matches!(fixture, FixtureFetch::Page { .. })
                    && input.starts_with("UID SEARCH ") =>
            {
                if input.contains("24:24") {
                    "* SEARCH 24\r\n".into()
                } else {
                    "* SEARCH 23 24\r\n".into()
                }
            }
            "UID" if matches!(fixture, FixtureFetch::BodyFilter) => {
                let (expected, reply) = [
                    ("UID SEARCH UID 23,24 BODY \"INVOICE\"", "* SEARCH 23\r\n"),
                    (
                        "UID SEARCH CHARSET UTF-8 UID 23,24 BODY \"发票\"",
                        "* SEARCH\r\n",
                    ),
                ][body_searches];
                assert_eq!(input, expected);
                body_searches += 1;
                reply.into()
            }
            "UID" => {
                let uid = fixture.uids()[fetches];
                assert!(input.starts_with(&format!("UID FETCH {uid} ")));
                fetches += 1;
                fixture.reply(&input, uid)
            }
            "LOGOUT" => "* BYE goodbye\r\n".to_owned(),
            _ => panic!("unexpected IMAP command {command}"),
        };
        stream
            .write_all(format!("{data}{tag} OK done\r\n").as_bytes())
            .await
            .unwrap();
        if command == "LOGOUT" {
            break;
        }
        line.clear();
    }
    assert_eq!(fetches, fixture.uids().len());
    if matches!(fixture, FixtureFetch::BodyFilter) {
        assert_eq!(body_searches, 2);
    }
}
