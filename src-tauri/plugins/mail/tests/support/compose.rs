use serde_json::{Value, json};
use taomni_mail_api::{
    COMPOSE_MESSAGE,
    compose::ComposeEnvelope,
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{io::AsyncReadExt, sync::oneshot};

use super::{MailHost, WAIT};

const ORIGINAL: &[u8] = b"\x00disposable attachment\x80\xff";

pub(super) fn check_composition(host: &mut MailHost) {
    for keep_bcc in [false, true] {
        let (envelope, body) = prepare(host, "reader@example.test", keep_bcc).unwrap();
        assert_eq!(envelope.sender.as_deref(), Some("sender@example.test"));
        assert_eq!(
            envelope.recipients,
            ["reader@example.test", "bcc@example.test"]
        );
        let original = taomni_mail_engine::extract_attachment(&body, 0).unwrap();
        assert_eq!(original.name.as_deref(), Some("binary.dat"));
        assert_eq!(original.bytes, ORIGINAL);
        let message = String::from_utf8(body).unwrap();
        assert!(message.contains("Message-ID: <signed-compose@example.test>"));
        assert!(message.contains("Reply-To: reply@example.test"));
        assert_eq!(message.contains("Bcc: bcc@example.test"), keep_bcc);
    }
    match prepare(host, "invalid", false) {
        Err(error) => assert!(error.contains("invalid email address"), "{error}"),
        Ok(_) => panic!("Invalid recipient unexpectedly accepted"),
    }
}

fn prepare(
    host: &mut MailHost,
    recipient: &str,
    keep_bcc: bool,
) -> Result<(ComposeEnvelope, Vec<u8>), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        runtime.block_on(async {
            let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
            let (resolved, called) = oneshot::channel();
            scope.spawn(move || {
                let params = serde_json::to_value(endpoint).unwrap();
                let result = host.call(COMPOSE_MESSAGE, params);
                resolved.send(result).unwrap();
            });
            tokio::time::timeout(WAIT, async move {
                let request = json!({
                    "emailAddress": "sender@example.test",
                    "replyTo": "reply@example.test",
                    "message": {
                        "to": [recipient], "bcc": ["bcc@example.test"],
                        "subject": "Hosted composition", "textBody": "Draft and delivery body",
                    },
                    "options": {
                        "messageId": "<signed-compose@example.test>", "keepBcc": keep_bcc,
                        "selfEnvelope": false,
                    },
                    "attachments": [{
                        "name": "binary.dat", "contentType": "application/octet-stream", "inline": false,
                    }],
                });
                write_body_frame(&mut peer, &serde_json::to_vec(&request).unwrap())
                    .await.unwrap();
                let wants_bytes = peer.read_u8().await.unwrap();
                assert_eq!(wants_bytes, u8::from(recipient != "invalid"));
                if wants_bytes == 1 {
                    write_body_frame(&mut peer, ORIGINAL).await.unwrap();
                }
                let result = serde_json::from_slice::<Result<ComposeEnvelope, String>>(
                    &read_body_frame(&mut peer).await.unwrap(),
                )
                .unwrap();
                let reply = match result {
                    Ok(envelope) => Ok((envelope, read_body_frame(&mut peer).await.unwrap())),
                    Err(error) => Err(error),
                };
                let raw: Value = called.await.unwrap();
                serde_json::from_value::<Result<(), String>>(raw).unwrap().unwrap();
                reply
            })
            .await
            .expect("Mail compose exchange completed within its deadline")
        })
    })
}
