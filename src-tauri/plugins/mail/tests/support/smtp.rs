use std::net::Ipv4Addr;

use serde_json::Value;
use taomni_mail_api::{
    CHECK_OUTGOING, MailAuthMode, MailConnectionSecurity, SEND_SMTP, SMTP_DELIVERY_UNKNOWN,
    SmtpConnection, SmtpDelivery,
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    runtime::Runtime,
    sync::oneshot,
};

use super::{MailHost, WAIT};

#[derive(Clone, Copy)]
enum Scenario {
    RejectAuth,
    Probe,
    AcceptData,
    RejectData,
    LoseDataReply,
}

#[derive(Default)]
struct Transcript {
    commands: Vec<String>,
    data: Vec<u8>,
}

pub(super) fn check_routed_smtp(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for scenario in [Scenario::RejectAuth, Scenario::Probe] {
        let (listener, route, connection) = runtime.block_on(setup());
        let (result, transcript) = exchange(
            host,
            &runtime,
            CHECK_OUTGOING,
            serde_json::to_value(connection).unwrap(),
            listener,
            scenario,
        );
        drop(route);
        let result = serde_json::from_value::<Result<(), String>>(result).unwrap();
        match scenario {
            Scenario::RejectAuth => {
                assert!(result.unwrap_err().starts_with("SMTP test failed:"));
                assert_eq!(transcript.commands, ["EHLO", "AUTH"]);
            }
            _ => {
                result.unwrap();
                assert_eq!(transcript.commands, ["EHLO", "AUTH", "NOOP", "QUIT"]);
            }
        }
    }
    for scenario in [
        Scenario::AcceptData,
        Scenario::RejectData,
        Scenario::LoseDataReply,
    ] {
        check_delivery(host, &runtime, scenario);
    }
    for scenario in [
        Scenario::AcceptData,
        Scenario::RejectData,
        Scenario::LoseDataReply,
    ] {
        check_response(host, &runtime, scenario);
    }
}

fn check_delivery(host: &mut MailHost, runtime: &Runtime, scenario: Scenario) {
    let mime = b"From: sender@example.test\r\nTo: visible@example.test\r\n\r\n.example payload";
    let mime_length = mime.len() as u64;
    let (listener, _route, connection) = runtime.block_on(setup());
    let (_offer, mime_source) = runtime.block_on(Route::offer_bytes(mime.to_vec())).unwrap();
    let payload = serde_json::to_value(SmtpDelivery {
        connection,
        sender: Some("sender@example.test".into()),
        recipients: vec!["visible@example.test".into(), "blind@example.test".into()],
        mime_source,
        mime_length,
    })
    .unwrap();
    let (result, transcript) = exchange(host, runtime, SEND_SMTP, payload, listener, scenario);
    let result = serde_json::from_value::<Result<String, String>>(result).unwrap();
    assert_eq!(
        &transcript.commands[..6],
        [
            "EHLO",
            "AUTH",
            "MAIL FROM:<sender@example.test>",
            "RCPT TO:<visible@example.test>",
            "RCPT TO:<blind@example.test>",
            "DATA",
        ]
    );
    assert!(
        transcript
            .commands
            .iter()
            .filter(|cmd| **cmd == "DATA")
            .count()
            == 1
    );
    assert_eq!(transcript.data, [mime.as_slice(), b"\r\n"].concat());
    match scenario {
        Scenario::AcceptData => assert!(result.unwrap().contains("accepted")),
        Scenario::RejectData => assert!(result.unwrap_err().contains("SIZE limit")),
        Scenario::LoseDataReply => assert!(result.unwrap_err().starts_with(SMTP_DELIVERY_UNKNOWN)),
        _ => unreachable!(),
    }
}

fn check_response(host: &mut MailHost, runtime: &Runtime, scenario: Scenario) {
    use taomni_mail_api::{MimeUpload, SEND_RESPONSE, SmtpResponse};
    use taomni_mail_api::responses::{MailResponse, Receipt, ResponseRequest};

    let (listener, _route, connection) = runtime.block_on(setup());
    let bytes = serde_json::to_vec(&ResponseRequest {
        email_address: "sender@example.test".into(),
        display_name: Some("Reader".into()),
        stamp: 1_700_000_000,
        response: MailResponse::Receipt(Receipt {
            uid: 17,
            message_id: Some("original@example.test".into()),
            subject: "Quarterly report".into(),
            recipient: "writer@example.test".into(),
            automatic: false,
        }),
    })
    .unwrap();
    let length = bytes.len() as u64;
    let (_offer, source) = runtime.block_on(Route::offer_bytes(bytes)).unwrap();
    let request = SmtpResponse {
        connection,
        content: MimeUpload { source, length },
    };
    let (result, transcript) = exchange(
        host,
        runtime,
        SEND_RESPONSE,
        serde_json::to_value(request).unwrap(),
        listener,
        scenario,
    );
    assert!(
        transcript
            .commands
            .contains(&"MAIL FROM:<sender@example.test>".to_owned())
    );
    assert!(
        transcript
            .commands
            .contains(&"RCPT TO:<writer@example.test>".to_owned())
    );
    assert_eq!(
        transcript
            .commands
            .iter()
            .filter(|verb| *verb == "DATA")
            .count(),
        1
    );
    let body = String::from_utf8(transcript.data).unwrap();
    assert!(body.contains("Original-Message-ID: <original@example.test>"));
    assert!(body.contains("manual-action/MDN-sent-manually; displayed"));
    let result: Result<(), String> = serde_json::from_value(result).unwrap();
    match scenario {
        Scenario::AcceptData => result.unwrap(),
        Scenario::RejectData => assert!(result.unwrap_err().contains("SIZE limit")),
        Scenario::LoseDataReply => assert!(result.unwrap_err().starts_with(SMTP_DELIVERY_UNKNOWN)),
        _ => unreachable!(),
    }
}

async fn setup() -> (TcpListener, Route, SmtpConnection) {
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
    let connection = SmtpConnection {
        route: endpoint,
        server_name: "smtp.test".into(),
        security: MailConnectionSecurity::None,
        trusted_certificate: None,
        username: "qa".into(),
        secret: "fixture-secret".to_owned().into(),
        authentication: MailAuthMode::Password,
    };
    (listener, route, connection)
}

fn exchange(
    host: &mut MailHost,
    runtime: &Runtime,
    method: &str,
    request: Value,
    listener: TcpListener,
    scenario: Scenario,
) -> (Value, Transcript) {
    std::thread::scope(|scope| {
        let (publish, response) = oneshot::channel();
        scope.spawn(move || {
            let value = host.call(method, request);
            publish.send(value).unwrap();
        });
        runtime.block_on(async move {
            let (response, transcript) = tokio::join!(
                response,
                tokio::time::timeout(WAIT, serve(listener, scenario))
            );
            (response.unwrap(), transcript.unwrap())
        })
    })
}

async fn serve(listener: TcpListener, scenario: Scenario) -> Transcript {
    let (mut stream, _) = listener.accept().await.unwrap();
    let (reader, mut writer) = stream.split();
    writer.write_all(b"220 qa SMTP ready\r\n").await.unwrap();
    let mut reader = BufReader::new(reader);
    let mut transcript = Transcript::default();
    let mut line = String::new();
    while reader.read_line(&mut line).await.unwrap() > 0 {
        let verb = line.split_whitespace().next().unwrap();
        transcript.commands.push(match verb {
            "MAIL" | "RCPT" => line.trim_end().to_owned(),
            _ => verb.to_owned(),
        });
        let response = match verb {
            "EHLO" => "250-qa\r\n250 AUTH PLAIN LOGIN\r\n",
            "AUTH" if matches!(scenario, Scenario::RejectAuth) => "535 authentication rejected\r\n",
            "AUTH" => "235 authentication accepted\r\n",
            "MAIL" | "RCPT" | "NOOP" => "250 ok\r\n",
            "DATA" => {
                writer.write_all(b"354 send content\r\n").await.unwrap();
                transcript.data = read_data(&mut reader).await;
                match scenario {
                    Scenario::AcceptData => "250 accepted\r\n",
                    Scenario::RejectData => "552 message size exceeds fixed limit\r\n",
                    Scenario::LoseDataReply => break,
                    _ => panic!("unexpected DATA"),
                }
            }
            "QUIT" => "221 bye\r\n",
            _ => panic!("unexpected SMTP verb {verb}"),
        };
        writer.write_all(response.as_bytes()).await.unwrap();
        if verb == "QUIT" {
            break;
        }
        line.clear();
    }
    transcript
}

async fn read_data(reader: &mut (impl AsyncBufReadExt + Unpin)) -> Vec<u8> {
    let mut data = Vec::new();
    let mut line = Vec::new();
    loop {
        assert!(reader.read_until(b'\n', &mut line).await.unwrap() > 0);
        if line == b".\r\n" {
            return data;
        }
        data.extend_from_slice(if line.starts_with(b"..") {
            &line[1..]
        } else {
            &line
        });
        line.clear();
    }
}
