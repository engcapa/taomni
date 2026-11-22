use serde_json::{Value, json};
use taomni_mail_api::{
    LOCAL_DRAFTS,
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::AsyncReadExt;

use super::{MailHost, WAIT};

/// Run the same one-use transfer as the desktop and prove an already owned
/// mailbox can be read even when its original cache is no longer available.
pub(super) fn list(host: &mut MailHost, account: &str, import: Option<Value>) -> Value {
    let io = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        io.block_on(async {
            let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
            let call = scope
                .spawn(move || host.call(LOCAL_DRAFTS, serde_json::to_value(endpoint).unwrap()));
            let output = tokio::time::timeout(WAIT, async {
                let request = json!({"accountId":account,"action":{"operation":"list"}});
                write_body_frame(&mut peer, &serde_json::to_vec(&request).unwrap())
                    .await
                    .unwrap();
                assert_eq!(peer.read_u8().await.unwrap(), u8::from(import.is_some()));
                if let Some(import) = import {
                    write_body_frame(&mut peer, &serde_json::to_vec(&import).unwrap())
                        .await
                        .unwrap();
                }
                read_body_frame(&mut peer).await.unwrap()
            })
            .await
            .unwrap();
            assert_eq!(call.join().unwrap(), json!({"Ok":null}));
            serde_json::from_slice(&output).unwrap()
        })
    })
}
