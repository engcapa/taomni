use std::net::Ipv4Addr;

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    IncomingTest, MailAuthMode, MailConnectionSecurity, MailIncomingProtocol, MailProvider,
    OPEN_POP3_SYNC,
    imap_exchange::{read_body_frame, write_frame},
    pop3_exchange::{Pop3Command, Pop3Exchange},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

use super::{MailHost, WAIT};

const ORIGINAL: &[u8] = b"Subject: Routed POP3\r\n\r\n.Binary line \xff\r\n";

pub(super) fn check_routed_sync(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for commit in [false, true] {
        std::thread::scope(|scope| {
            runtime.block_on(async {
                let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                let address = listener.local_addr().unwrap();
                let (_route, route) = Route::bind(move || async move {
                    let stream = TcpStream::connect(address)
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok((stream, address))
                })
                .await
                .unwrap();
                let (_exchange, exchange, mut peer) = Route::pair().await.unwrap();
                let envelope = Pop3Exchange {
                    connection: IncomingTest {
                        route,
                        server_name: "pop3.test".into(),
                        security: MailConnectionSecurity::None,
                        trusted_certificate: None,
                        protocol: MailIncomingProtocol::Pop3,
                        provider: MailProvider::Custom,
                        authentication: MailAuthMode::Password,
                        username: "qa".into(),
                        secret: "fixture-password".to_owned().into(),
                    },
                    exchange,
                };
                let (complete, invoked) = oneshot::channel();
                let host = &mut *host;
                scope.spawn(move || {
                    let result = host.call(OPEN_POP3_SYNC, serde_json::to_value(envelope).unwrap());
                    complete.send(result).unwrap();
                });
                tokio::time::timeout(WAIT, async move {
                    let synchronize = async move {
                        serde_json::from_value::<Result<(), String>>(invoked.await.unwrap())
                            .unwrap()
                            .unwrap();
                        reply::<()>(&mut peer).await;
                        let ids: Vec<(u32, String)> = request(&mut peer, Pop3Command::Uidl).await;
                        assert_eq!(ids, vec![(7, "routed-uidl".into())]);
                        request::<()>(&mut peer, Pop3Command::Retrieve { number: 7 }).await;
                        assert_eq!(read_body_frame(&mut peer).await.unwrap(), ORIGINAL);
                        request::<()>(&mut peer, Pop3Command::Delete { number: 7 }).await;
                        if commit {
                            request::<()>(&mut peer, Pop3Command::Quit).await;
                        }
                    };
                    tokio::join!(synchronize, serve(listener, commit));
                })
                .await
                .expect("POP3 fixture completed before its deadline");
            });
        });
    }
}

async fn request<T: DeserializeOwned>(peer: &mut DuplexStream, command: Pop3Command) -> T {
    write_frame(peer, &serde_json::to_vec(&command).unwrap())
        .await
        .unwrap();
    reply(peer).await
}

async fn reply<T: DeserializeOwned>(peer: &mut DuplexStream) -> T {
    serde_json::from_slice::<Result<T, String>>(&read_body_frame(peer).await.unwrap())
        .unwrap()
        .unwrap()
}

async fn serve(listener: TcpListener, commit: bool) {
    let (socket, _) = listener.accept().await.unwrap();
    let mut socket = BufReader::new(socket);
    socket
        .get_mut()
        .write_all(b"+OK POP3 fixture\r\n")
        .await
        .unwrap();
    let mut line = String::new();
    for (command, response) in [
        ("USER qa", &b"+OK\r\n"[..]),
        ("PASS fixture-password", &b"+OK\r\n"[..]),
        ("STAT", &b"+OK 1 42\r\n"[..]),
        ("UIDL", &b"+OK\r\n7 routed-uidl\r\n.\r\n"[..]),
        (
            "RETR 7",
            &b"+OK\r\nSubject: Routed POP3\r\n\r\n..Binary line \xff\r\n.\r\n"[..],
        ),
        ("DELE 7", &b"+OK\r\n"[..]),
    ] {
        line.clear();
        socket.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim_end(), command);
        socket.get_mut().write_all(response).await.unwrap();
    }
    line.clear();
    let bytes = socket.read_line(&mut line).await.unwrap();
    if commit {
        assert_eq!(line, "QUIT\r\n");
        socket
            .get_mut()
            .write_all(b"+OK committed\r\n")
            .await
            .unwrap();
    } else {
        assert_eq!(bytes, 0, "An interrupted transfer must close without QUIT");
    }
}
