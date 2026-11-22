use super::{ACCOUNT, MailHost, WAIT};
use serde_json::{Value, json};
use std::path::Path;
use taomni_mail_api::{
    ATTACHMENT_CACHE,
    attachment_cache::{AttachmentCacheRequest, AttachmentKey},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) fn check(host: &mut MailHost, module: &Path, legacy: &Path, relative: &str) {
    let original = std::fs::read(legacy.join(relative)).unwrap();
    let (receipt, bytes) = transfer(host, "1", None);
    assert_eq!(receipt, json!({"Ok":original.len()}));
    assert_eq!(bytes, original);
    assert_eq!(transfer(host, "i2", None), (json!({"Ok":null}), Vec::new()));
    let bytes = vec![0x92; 192 * 1024 + 1];
    let new_file = module.join(relative).with_file_name("9-i2.bin");
    assert_eq!(
        transfer(host, "i2", Some((&bytes, bytes.len()))).0,
        json!({"Ok":bytes.len()})
    );
    assert_eq!(std::fs::read(&new_file).unwrap(), bytes);
    assert!(
        transfer(host, "i2", Some((b"incomplete", 1024)))
            .0
            .get("Err")
            .is_some()
    );
    assert_eq!(
        transfer(host, "i2", None),
        (json!({"Ok":bytes.len()}), bytes)
    );
    assert!(!legacy.join(relative).with_file_name("9-i2.bin").exists());
    assert_eq!(std::fs::read(legacy.join(relative)).unwrap(), original);
}

fn transfer(host: &mut MailHost, part: &str, write: Option<(&[u8], usize)>) -> (Value, Vec<u8>) {
    let io = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        io.block_on(async {
            let (_route, exchange, mut peer) = Route::pair().await.unwrap();
            let request = AttachmentCacheRequest {
                key: AttachmentKey {
                    account_id: ACCOUNT.into(),
                    folder: "INBOX".into(),
                    uid: 9,
                    part: part.into(),
                },
                exchange,
                write_size: write.map(|(_, size)| size as u64),
            };
            let call = scope
                .spawn(move || host.call(ATTACHMENT_CACHE, serde_json::to_value(request).unwrap()));
            let mut bytes = Vec::new();
            tokio::time::timeout(WAIT, async {
                if let Some((payload, _)) = write {
                    peer.write_all(payload).await.unwrap();
                    peer.shutdown().await.unwrap();
                } else {
                    peer.read_to_end(&mut bytes).await.unwrap();
                }
            })
            .await
            .unwrap();
            (call.join().unwrap(), bytes)
        })
    })
}
