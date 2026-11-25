use std::{net::Ipv4Addr, path::Path};

use rusqlite::Connection;
use taomni_mail_api::{
    IncomingTest, MailAuthMode, MailConnectionSecurity, MailIncomingProtocol, MailProvider,
    MailboxRequest, SYNC_POP3_ROUND,
    imap_exchange::read_body_frame,
    pop3_exchange::{
        Pop3LedgerRequest, Pop3Round, Pop3SyncOutcome, read_ledger_message, write_ledger_message,
    },
    pop3_store::{LOCAL_MAILBOX, LocalMailboxAction, OwnedPop3Round, SYNC_OWNED_MAILBOX},
};
use taomni_mail_engine::{
    database::mail_db_file_stem,
    pop3::{Pop3Ledger, local_store::list_local_originals, sqlite_ledger},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream},
    net::{TcpListener, TcpStream},
};

use super::{MailHost, WAIT};

const ORIGINAL: &[u8] = b"Subject: Hosted receipt\r\n\r\nOriginal bytes \x80\xff\r\n";

pub(super) fn check_owned_sync_round(host: &mut MailHost, profile: &Path) {
    const ACCOUNT: &str = "host-owned-pop3";
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    local_mailbox_call::<()>(&runtime, host, ACCOUNT, LocalMailboxAction::Initialize);
    for accepted in [false, true] {
        let outcome = std::thread::scope(|scope| {
            runtime.block_on(async {
                let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                let address = listener.local_addr().unwrap();
                let (_network, route) = Route::bind(move || async move {
                    let stream = TcpStream::connect(address)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok((stream, address))
                })
                .await
                .unwrap();
                let (_reply, endpoint, mut peer) = Route::pair().await.unwrap();
                let request = OwnedPop3Round {
                    account_id: ACCOUNT.into(),
                    connection: incoming(route),
                    reply: endpoint,
                    leave_days: Some(0),
                };
                let host = &mut *host;
                scope.spawn(move || {
                    let result =
                        host.call(SYNC_OWNED_MAILBOX, serde_json::to_value(request).unwrap());
                    serde_json::from_value::<Result<(), String>>(result)
                        .unwrap()
                        .unwrap();
                });
                let ((), outcome) = tokio::time::timeout(WAIT, async {
                    tokio::join!(
                        serve(listener, accepted),
                        read_ledger_message::<Result<Pop3SyncOutcome, String>>(&mut peer)
                    )
                })
                .await
                .expect("host-owned round completed before its deadline");
                outcome.unwrap()
            })
        });
        if accepted {
            let outcome = outcome.unwrap();
            assert_eq!(outcome.deleted_on_server, 1);
            assert!(outcome.messages.is_empty());
            assert_eq!(outcome.remaining, 0);
        } else {
            let error = outcome.err().expect("rejected QUIT");
            assert!(error.contains("deletion refused"), "{error}");
        }
        let stem = mail_db_file_stem(ACCOUNT);
        let db = Connection::open(profile.join(format!("plugins/mail/data/{stem}.db"))).unwrap();
        assert_eq!(
            list_local_originals(&db, ACCOUNT, "INBOX").unwrap(),
            [(1, ORIGINAL.to_vec())]
        );
        let deleted: bool = db
            .query_row(
                "SELECT deleted FROM mail_pop3_uidl WHERE uidl='routed-uidl'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(deleted, accepted);
        assert!(!profile.join(format!("mail-cache/{stem}.db")).exists());
    }
    let raw: Option<Vec<u8>> = local_mailbox_call(
        &runtime,
        host,
        ACCOUNT,
        LocalMailboxAction::Raw {
            folder: "INBOX".into(),
            uid: 1,
        },
    );
    assert_eq!(raw.as_deref(), Some(ORIGINAL));
}

fn local_mailbox_call<T: serde::de::DeserializeOwned>(
    runtime: &tokio::runtime::Runtime,
    host: &mut MailHost,
    account: &str,
    action: LocalMailboxAction,
) -> T {
    std::thread::scope(|scope| {
        runtime.block_on(async {
            let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
            scope.spawn(move || {
                let result = host.call(LOCAL_MAILBOX, serde_json::to_value(endpoint).unwrap());
                serde_json::from_value::<Result<(), String>>(result)
                    .unwrap()
                    .unwrap();
            });
            write_ledger_message(
                &mut peer,
                &MailboxRequest {
                    account_id: account.into(),
                    action,
                },
            )
            .await
            .unwrap();
            read_ledger_message(&mut peer).await.unwrap()
        })
    })
}

pub(super) fn check_sync_round(host: &mut MailHost) {
    let db = Connection::open_in_memory().unwrap();
    taomni_mail_engine::cache::init_mail_tables(&db).unwrap();
    let ledger = sqlite_ledger(|| Ok(&db), "pop3");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for accepted in [false, true] {
        std::thread::scope(|scope| {
            runtime.block_on(async {
                let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                let address = listener.local_addr().unwrap();
                let (_network, route) = Route::bind(move || async move {
                    let stream = TcpStream::connect(address)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok((stream, address))
                })
                .await
                .unwrap();
                let (_ledger, endpoint, mut peer) = Route::pair().await.unwrap();
                let request = Pop3Round {
                    connection: incoming(route),
                    ledger: endpoint,
                    leave_days: Some(0),
                };
                let host = &mut *host;
                scope.spawn(move || {
                    let reply = host.call(SYNC_POP3_ROUND, serde_json::to_value(request).unwrap());
                    serde_json::from_value::<Result<(), String>>(reply)
                        .unwrap()
                        .unwrap();
                });
                tokio::time::timeout(WAIT, async {
                    tokio::join!(
                        serve_ledger(&mut peer, &ledger, accepted),
                        serve(listener, accepted)
                    );
                })
                .await
                .expect("POP3 round completed before its deadline");
            });
        });
        let originals = list_local_originals(&db, "pop3", "INBOX").unwrap();
        assert_eq!(originals.len(), 1);
        assert_eq!(originals[0].1, ORIGINAL);
        let deleted = db
            .query_row("SELECT deleted FROM mail_pop3_uidl", [], |row| {
                row.get::<_, bool>(0)
            })
            .unwrap();
        assert_eq!(deleted, accepted);
    }
}

fn incoming(route: taomni_plugin_stream::routed_tcp::Endpoint) -> IncomingTest {
    IncomingTest {
        route,
        server_name: "pop3.test".into(),
        security: MailConnectionSecurity::None,
        trusted_certificate: None,
        protocol: MailIncomingProtocol::Pop3,
        provider: MailProvider::Custom,
        authentication: MailAuthMode::Password,
        username: "qa".into(),
        secret: "fixture-password".to_owned().into(),
    }
}

async fn serve_ledger(peer: &mut DuplexStream, ledger: &impl Pop3Ledger, accepted: bool) {
    let mut observed = Vec::new();
    loop {
        match read_ledger_message(peer).await.unwrap() {
            Pop3LedgerRequest::Known => {
                observed.push("known");
                write_ledger_message(peer, &ledger.known_messages())
                    .await
                    .unwrap();
            }
            Pop3LedgerRequest::Save { uidl, fetched_at } => {
                observed.push("save");
                let original = read_body_frame(peer).await.unwrap();
                assert_eq!(original, ORIGINAL);
                let result = ledger.save_message(&uidl, fetched_at, &original);
                write_ledger_message(peer, &result).await.unwrap();
            }
            Pop3LedgerRequest::RefreshCounts => {
                observed.push("refresh");
                write_ledger_message(peer, &ledger.refresh_counts())
                    .await
                    .unwrap();
            }
            Pop3LedgerRequest::ConfirmDeletions { uidls } => {
                observed.push("confirm");
                assert_eq!(uidls, ["routed-uidl"]);
                write_ledger_message(peer, &ledger.confirm_deletions(&["routed-uidl"]))
                    .await
                    .unwrap();
            }
            Pop3LedgerRequest::Complete(result) => {
                if accepted {
                    assert_eq!(observed, ["known", "refresh", "confirm"]);
                    let result = result.unwrap();
                    assert!(result.messages.is_empty());
                    assert_eq!(result.remaining, 0);
                    assert_eq!(result.deleted_on_server, 1);
                } else {
                    assert_eq!(observed, ["known", "save", "refresh"]);
                    let error = result
                        .err()
                        .expect("Rejected QUIT cannot complete the round");
                    assert!(error.contains("deletion refused"), "{error}");
                }
                return;
            }
        }
    }
}

async fn serve(listener: TcpListener, accepted: bool) {
    let (socket, _) = listener.accept().await.unwrap();
    let mut socket = BufReader::new(socket);
    socket
        .get_mut()
        .write_all(b"+OK POP3 fixture\r\n")
        .await
        .unwrap();
    let mut transcript = vec![
        ("USER qa", &b"+OK\r\n"[..]),
        ("PASS fixture-password", &b"+OK\r\n"[..]),
        ("STAT", &b"+OK 1 42\r\n"[..]),
        ("UIDL", &b"+OK\r\n7 routed-uidl\r\n.\r\n"[..]),
    ];
    let mut retrieved = b"+OK\r\n".to_vec();
    retrieved.extend_from_slice(ORIGINAL);
    retrieved.extend_from_slice(b".\r\n");
    if !accepted {
        transcript.push(("RETR 7", &retrieved));
    }
    transcript.push(("DELE 7", b"+OK\r\n"));
    transcript.push((
        "QUIT",
        if accepted {
            b"+OK committed\r\n"
        } else {
            b"-ERR deletion refused\r\n"
        },
    ));
    let mut line = String::new();
    for (expected, response) in transcript {
        line.clear();
        socket.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim_end(), expected);
        socket.get_mut().write_all(response).await.unwrap();
    }
}
