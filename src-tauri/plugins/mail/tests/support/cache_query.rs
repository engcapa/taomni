use std::path::Path;

use serde_json::{Value, json};
use taomni_mail_api::{
    cache_query::{CacheQuery, CacheQueryRequest, MAX_CACHE_REPLY_BYTES, QUERY_ACCOUNT_CACHE},
    imap_exchange::{read_bounded_body_frame, write_body_frame},
    search::{MailSearchField, MailSearchQuery},
};
use taomni_plugin_stream::routed_tcp::Route;

use super::{ACCOUNT, MailHost, WAIT};

pub(super) fn check_migrated_cache(host: &mut MailHost, database: &Path) {
    let folders = query(host, database, CacheQuery::Folders);
    assert_eq!(folders.as_array().unwrap().len(), 1);
    assert_eq!(folders[0]["name"], "INBOX");
    assert_eq!(folders[0]["cachedCount"], 1);

    let page = |offset| CacheQuery::Messages {
        folder: "INBOX".into(),
        limit: 1,
        offset,
    };
    let first = query(host, database, page(0));
    assert_eq!(first.as_array().unwrap().len(), 1);
    assert_eq!(first[0]["uid"], 9);
    assert_eq!(first[0]["subject"], "Original");
    assert_eq!(query(host, database, page(1)), json!([]));

    let mut search = MailSearchQuery {
        text: "Original".into(),
        field: MailSearchField::Subject,
        ..Default::default()
    };
    assert_eq!(
        query(host, database, CacheQuery::Search(search.clone())),
        first
    );
    search.folder = Some("Sent".into());
    assert_eq!(query(host, database, CacheQuery::Search(search)), json!([]));
}

fn query(host: &mut MailHost, database: &Path, query: CacheQuery) -> Value {
    let request = serde_json::to_vec(&CacheQueryRequest {
        account_id: ACCOUNT.into(),
        database: database.into(),
        query,
    })
    .unwrap();
    let io = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        io.block_on(async {
            let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
            let call = scope.spawn(move || {
                host.call(QUERY_ACCOUNT_CACHE, serde_json::to_value(endpoint).unwrap())
            });
            let reply = tokio::time::timeout(WAIT, async {
                write_body_frame(&mut peer, &request).await.unwrap();
                read_bounded_body_frame(&mut peer, MAX_CACHE_REPLY_BYTES)
                    .await
                    .unwrap()
            })
            .await
            .unwrap();
            assert_eq!(call.join().unwrap(), json!({"Ok": null}));
            serde_json::from_slice(&reply).unwrap()
        })
    })
}
