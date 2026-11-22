use serde_json::{Value, json};
use taomni_mail_api::{
    ADDRESS_BOOK, CALDAV_AGENDA, LOCAL_DRAFTS,
    imap_exchange::{read_body_frame, write_body_frame},
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::io::AsyncReadExt;

use super::{MailHost, WAIT};

/// Run the same one-use transfer as the desktop and prove an already owned
/// mailbox can be read even when its original cache is no longer available.
pub(super) fn list(host: &mut MailHost, account: &str, import: Option<Value>) -> Value {
    transfer(
        host,
        LOCAL_DRAFTS,
        account,
        json!({"operation":"list"}),
        import,
    )
}

pub(super) fn book(
    host: &mut MailHost,
    account: &str,
    action: Value,
    import: Option<Value>,
) -> Value {
    let reply = transfer(host, ADDRESS_BOOK, account, action, import);
    serde_json::from_value::<Result<Value, String>>(reply)
        .unwrap()
        .unwrap()
}

pub(super) fn check_agenda(host: &mut MailHost) {
    let account = "caldav-qa-account";
    let legacy = rusqlite::Connection::open_in_memory().unwrap();
    taomni_mail_engine::cache::init_mail_tables(&legacy).unwrap();
    legacy
        .execute(
            "INSERT INTO mail_calendar_events VALUES (?1,'/calendar/standup.ics','',?2,NULL,7)",
            rusqlite::params![account, json!({
            "uid":"standup","summary":"Legacy standup","startLocal":"2035-01-01","allDay":true
        }).to_string()],
        )
        .unwrap();
    use taomni_mail_engine::agenda::handoff::{AgendaImport, read_account};

    let import = AgendaImport {
        replace_staged: false,
        snapshot: read_account(&legacy, account).unwrap(),
    };
    let imported = transfer(
        host,
        CALDAV_AGENDA,
        account,
        json!({"type":"list","days":14}),
        Some(serde_json::to_value(import).unwrap()),
    );
    assert_eq!(imported[0]["summary"], "Legacy standup");

    let state = json!({"baseUrl":"https://example.invalid/dav/","collectionUrl":"https://example.invalid/calendar/","lastSync":11,"lastError":null});
    let updated = transfer(
        host,
        CALDAV_AGENDA,
        account,
        json!({
            "type":"commit","state":state,"events":{"replaceAll":true,"resources":[["/calendar/review.ics",[
                {"uid":"review","summary":"Hosted review","startLocal":"2035-01-02","allDay":true}
            ]]]}
        }),
        None,
    );
    assert_eq!(updated, 1);
    assert_eq!(
        transfer(
            host,
            CALDAV_AGENDA,
            account,
            json!({"type":"readState"}),
            None
        ),
        state
    );
    let listed = transfer(
        host,
        CALDAV_AGENDA,
        account,
        json!({"type":"list","days":14}),
        None,
    );
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["uid"], "review");
    let source = taomni_mail_engine::agenda::agenda(&legacy, account, 0, 14).unwrap();
    assert_eq!(source[0].uid, "standup");
}

fn transfer(
    host: &mut MailHost,
    method: &str,
    account: &str,
    action: Value,
    import: Option<Value>,
) -> Value {
    let io = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        io.block_on(async {
            let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
            let call =
                scope.spawn(move || host.call(method, serde_json::to_value(endpoint).unwrap()));
            let output = tokio::time::timeout(WAIT, async {
                let request = json!({"accountId":account,"action":action});
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
