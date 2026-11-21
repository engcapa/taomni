use std::net::Ipv4Addr;

use taomni_mail_api::{
    FETCH_IMAP_ATTACHMENT, FETCH_IMAP_BODY, IncomingTest, MailAuthMode, MailConnectionSecurity,
    MailIncomingProtocol, MailProvider,
    imap_exchange::{
        AttachmentReceipt, AttachmentRequest, ImapExchange, read_body_frame, read_frame,
        write_frame,
    },
};
use taomni_mail_engine::imap_transport::{ImapBodyReply, ImapBodyRequest};
use taomni_plugin_stream::routed_tcp::{Endpoint, Route};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

use super::{MailHost, WAIT};

const HEADER: &str =
    "From: sender@example.test\r\nSubject: Routed body\r\nContent-Type: text/plain\r\n\r\n";
const TEXT: &str = "Body from the routed IMAP connection\r\n";

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

async fn routed_mailbox() -> (TcpListener, Route, IncomingTest) {
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

enum FixtureFetch {
    Body,
    Attachment,
    Section,
}

impl FixtureFetch {
    fn reply(&self, request: &str) -> String {
        const MIME: &str = concat!(
            "Content-Type: application/octet-stream\r\n",
            "Content-Disposition: attachment; filename=fixture.bin\r\n",
            "Content-Transfer-Encoding: base64\r\n\r\n",
        );
        const BINARY: &str = "JVFB/wA=\r\n";
        match self {
            Self::Body => {
                assert!(request.contains("BODY.PEEK[]<0.1024>"));
                format!(
                    "* 1 FETCH (UID 23 FLAGS () RFC822.SIZE {} BODY[HEADER] {{{}}}\r\n{HEADER} BODY[]<0> {{{}}}\r\n{HEADER}{TEXT})\r\n",
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

async fn serve(listener: TcpListener, fixture: FixtureFetch) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut stream = BufReader::new(stream);
    stream
        .write_all(b"* OK IMAP fixture ready\r\n")
        .await
        .unwrap();
    let mut fetches = 0;
    let mut line = String::new();
    while stream.read_line(&mut line).await.unwrap() != 0 {
        let (tag, input) = line.trim_end().split_once(' ').unwrap();
        let input = input.to_ascii_uppercase();
        let command = input.split_whitespace().next().unwrap();
        let data = match command {
            "LOGIN" => String::new(),
            "CAPABILITY" => "* CAPABILITY IMAP4rev1\r\n".to_owned(),
            "EXAMINE" => {
                assert!(input.ends_with("\"INBOX\"") || input.ends_with(" INBOX"));
                "* 1 EXISTS\r\n* OK [UIDVALIDITY 2] UIDs valid\r\n".to_owned()
            }
            "UID" => {
                assert!(input.starts_with("UID FETCH 23 "));
                fetches += 1;
                fixture.reply(&input)
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
    assert_eq!(fetches, 1);
}
