use std::net::Ipv4Addr;

use taomni_mail_api::{CHECK_OUTGOING, MailAuthMode, MailConnectionSecurity, OutgoingTest};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

use super::{MailHost, WAIT};

pub(super) fn check_routed_smtp(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for accept_auth in [false, true] {
        let (listener, route, request) = runtime.block_on(async {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let (route, endpoint) = Route::bind(move || async move {
                let socket = TcpStream::connect(address)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok((socket, address))
            })
            .await
            .unwrap();
            let request = OutgoingTest {
                route: endpoint,
                server_name: "smtp.test".into(),
                security: MailConnectionSecurity::None,
                trusted_certificate: None,
                username: "qa".into(),
                secret: "fixture-secret".to_owned().into(),
                authentication: MailAuthMode::Password,
            };
            (listener, route, serde_json::to_value(request).unwrap())
        });
        let (result, verbs) = std::thread::scope(|scope| {
            let (publish, response) = oneshot::channel();
            let client = &mut *host;
            scope.spawn(move || {
                let value = client.call(CHECK_OUTGOING, request);
                publish.send(value).unwrap();
            });
            runtime.block_on(async move {
                let _route = route;
                let (response, verbs) = tokio::join!(
                    response,
                    tokio::time::timeout(WAIT, serve(listener, accept_auth))
                );
                (response.unwrap(), verbs.unwrap())
            })
        });
        let result = serde_json::from_value::<Result<(), String>>(result).unwrap();
        if accept_auth {
            result.unwrap();
            assert_eq!(verbs, ["EHLO", "AUTH", "NOOP", "QUIT"]);
        } else {
            assert!(result.unwrap_err().starts_with("SMTP test failed:"));
            assert_eq!(verbs, ["EHLO", "AUTH"]);
        }
    }
}

async fn serve(listener: TcpListener, accept_auth: bool) -> Vec<String> {
    let (mut stream, _) = listener.accept().await.unwrap();
    let (reader, mut writer) = stream.split();
    writer.write_all(b"220 qa SMTP ready\r\n").await.unwrap();
    let mut lines = BufReader::new(reader).lines();
    let mut verbs = Vec::new();
    while let Some(line) = lines.next_line().await.unwrap() {
        let verb = line.split_whitespace().next().unwrap();
        verbs.push(verb.to_owned());
        let response = match verb {
            "EHLO" => "250-qa\r\n250 AUTH PLAIN LOGIN\r\n",
            "AUTH" if accept_auth => "235 authentication accepted\r\n",
            "AUTH" => "535 authentication rejected\r\n",
            "NOOP" => "250 ok\r\n",
            "QUIT" => "221 bye\r\n",
            _ => panic!("unexpected SMTP verb {verb}"),
        };
        writer.write_all(response.as_bytes()).await.unwrap();
        if verb == "QUIT" {
            break;
        }
    }
    verbs
}
