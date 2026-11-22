use std::collections::{HashMap, HashSet};

use taomni_mail_api::{
    FILTER_IMAP_BODIES,
    imap_exchange::{ImapExchange, read_frame, write_frame},
};
use taomni_mail_engine::filters::imap::{BodyHits, FilterBodyQuery};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::sync::oneshot;

use super::imap::{FixtureFetch, routed_mailbox, serve};
use super::{MailHost, WAIT};

pub(super) fn check_routed_body_filter(host: &mut MailHost) {
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
                let result = host.call(FILTER_IMAP_BODIES, serde_json::to_value(request).unwrap());
                publish.send(result).unwrap();
            });
            let verify = async {
                let query = FilterBodyQuery {
                    folder: "INBOX".into(),
                    uids: vec![23, 24],
                    needles: vec!["invoice".into(), "发票".into()],
                };
                write_frame(&mut peer, &serde_json::to_vec(&query).unwrap())
                    .await
                    .unwrap();
                let reply: Result<BodyHits, String> =
                    serde_json::from_slice(&read_frame(&mut peer).await.unwrap()).unwrap();
                assert_eq!(
                    reply.unwrap(),
                    HashMap::from([(23, HashSet::from(["invoice".to_owned()]))])
                );
            };
            let (response, (), ()) = tokio::time::timeout(WAIT, async {
                tokio::join!(response, verify, serve(listener, FixtureFetch::BodyFilter))
            })
            .await
            .unwrap();
            serde_json::from_value::<Result<(), String>>(response.unwrap())
                .unwrap()
                .unwrap();
        });
    });
}
