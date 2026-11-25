use std::io;

use taomni_mail_api::{
    OPEN_IMAP_IDLE,
    imap_exchange::{ImapIdleNotice, OpenImapIdle, read_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::oneshot,
};

use super::{MailHost, WAIT, imap::routed_mailbox};

pub(super) fn check_routed_idle(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        runtime.block_on(async {
            let (listener, _route, connection) = routed_mailbox().await;
            let (_exchange, exchange, mut peer) = Route::pair().await.unwrap();
            let request = OpenImapIdle {
                connection,
                exchange,
                folder: "INBOX".into(),
            };
            let (publish, response) = oneshot::channel();
            scope.spawn(move || {
                let result = host.call(OPEN_IMAP_IDLE, serde_json::to_value(request).unwrap());
                publish.send(result).unwrap();
            });
            let (entered, idle) = oneshot::channel();
            let exchange = async {
                let ready =
                    serde_json::from_slice::<ImapIdleNotice>(&read_frame(&mut peer).await.unwrap())
                        .unwrap();
                assert!(matches!(ready, ImapIdleNotice::Ready));
                let changed =
                    serde_json::from_slice::<ImapIdleNotice>(&read_frame(&mut peer).await.unwrap())
                        .unwrap();
                assert!(matches!(changed, ImapIdleNotice::Changed));
                idle.await.unwrap();
                drop(peer);
            };
            let (response, (), ()) = tokio::time::timeout(WAIT, async {
                tokio::join!(response, exchange, serve(listener, entered))
            })
            .await
            .expect("Mail host must release the server connection on tab close");
            serde_json::from_value::<Result<(), String>>(response.unwrap())
                .unwrap()
                .unwrap();
        });
    });
}

async fn serve(listener: TcpListener, entered: oneshot::Sender<()>) {
    let (socket, _) = listener.accept().await.unwrap();
    let mut socket = BufReader::new(socket);
    socket
        .write_all(b"* OK IMAP IDLE fixture\r\n")
        .await
        .unwrap();
    let mut idled = false;
    loop {
        let mut line = String::new();
        assert_ne!(socket.read_line(&mut line).await.unwrap(), 0);
        let (tag, request) = line.trim_end().split_once(' ').unwrap();
        let data = match request.split_whitespace().next().unwrap() {
            "LOGIN" => "",
            "CAPABILITY" => "* CAPABILITY IMAP4rev1 IDLE\r\n",
            "EXAMINE" => "* 1 EXISTS\r\n* OK [UIDVALIDITY 2] UIDs valid\r\n",
            "IDLE" if !idled => {
                socket
                    .write_all(b"+ idling\r\n* 2 EXISTS\r\n")
                    .await
                    .unwrap();
                let mut done = String::new();
                socket.read_line(&mut done).await.unwrap();
                assert_eq!(done.trim_end(), "DONE");
                idled = true;
                ""
            }
            "IDLE" => {
                socket.write_all(b"+ idling\r\n").await.unwrap();
                entered.send(()).unwrap();
                let mut input = String::new();
                match socket.read_line(&mut input).await {
                    Ok(0) => {}
                    Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
                    other => panic!("expected the real IMAP socket to close, got {other:?}"),
                }
                return;
            }
            other => panic!("unexpected IMAP command {other}"),
        };
        socket
            .write_all(format!("{data}{tag} OK done\r\n").as_bytes())
            .await
            .unwrap();
    }
}
