use taomni_mail_api::{
    SYNC_IMAP_BODIES,
    imap_exchange::{
        ImapExchange,
        sync::{SyncFrame, read_sync_frame, write_save_result},
        write_frame,
    },
};
use taomni_mail_engine::{
    MailFolder,
    imap_sync::{
        BodySyncOutcome, BodySyncRequest, BodySyncTask, FolderRoundRequest, FolderSyncState,
        HeaderPageRequest, HeaderStepRequest, MailSyncRequestMode,
    },
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::sync::oneshot;

use super::{
    MailHost, WAIT,
    imap::{FixtureFetch, HEADER, TEXT, routed_mailbox, serve},
};

const ACCOUNT: &str = "routed-mail";
const FOLDER: &str = "INBOX";

pub(super) fn check_routed_body_sync(host: &mut MailHost) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let cases = [
        (
            BodySyncTask::Page(HeaderPageRequest {
                account_id: ACCOUNT.into(),
                folder: FOLDER.into(),
                offset: 0,
                limit: 1,
                list_folders: false,
            }),
            true,
            Ok(()),
            vec![24, 24],
        ),
        (
            BodySyncTask::Step(HeaderStepRequest {
                account_id: ACCOUNT.into(),
                folder: FOLDER.into(),
                state: FolderSyncState::default(),
                mode: MailSyncRequestMode::Auto,
                limit: 1,
            }),
            true,
            Err("fixture destination failed".to_owned()),
            vec![24, 24],
        ),
        (
            BodySyncTask::Round(FolderRoundRequest {
                folder: MailFolder {
                    account_id: ACCOUNT.into(),
                    name: FOLDER.into(),
                    ..MailFolder::default()
                },
                state: FolderSyncState::default(),
                limit: 1,
                reconcile: MailSyncRequestMode::Reconcile,
                skip_unchanged: false,
            }),
            false,
            Ok(()),
            vec![24, 24, 24],
        ),
    ];
    for (task, save_original, saved, uids) in cases {
        std::thread::scope(|scope| {
            runtime.block_on(async {
                let (listener, _route, connection) = routed_mailbox().await;
                let (_exchange, exchange, mut peer) = Route::pair().await.unwrap();
                let request = ImapExchange {
                    connection,
                    exchange,
                };
                let (publish, response) = oneshot::channel();
                let host = &mut *host;
                scope.spawn(move || {
                    let result =
                        host.call(SYNC_IMAP_BODIES, serde_json::to_value(request).unwrap());
                    publish.send(result).unwrap();
                });
                let request = BodySyncRequest {
                    task,
                    recent_limit: 1,
                    max_bytes: 1024,
                    save_original,
                };
                let exchange = async {
                    write_frame(&mut peer, &serde_json::to_vec(&request).unwrap())
                        .await
                        .unwrap();
                    if save_original {
                        let SyncFrame::Original { uid, bytes } =
                            read_sync_frame(&mut peer).await.unwrap()
                        else {
                            panic!("expected one original before sync result");
                        };
                        assert_eq!(uid, 24);
                        assert_eq!(bytes, format!("{HEADER}{TEXT}").as_bytes());
                        write_save_result(&mut peer, saved.clone()).await.unwrap();
                    }
                    let SyncFrame::Reply(frame) = read_sync_frame(&mut peer).await.unwrap() else {
                        panic!("expected one final sync result");
                    };
                    let result: Result<BodySyncOutcome, String> =
                        serde_json::from_slice(&frame).unwrap();
                    match (&request.task, result) {
                        (BodySyncTask::Step(_), Err(error)) => {
                            assert_eq!(error, saved.unwrap_err())
                        }
                        (BodySyncTask::Page(_), Ok(BodySyncOutcome::Page(page))) => {
                            assert!(page.has_more);
                            assert_body(&page.messages);
                        }
                        (BodySyncTask::Round(_), Ok(BodySyncOutcome::Round(round))) => {
                            assert!(round.error.is_none());
                            assert_eq!(round.steps.len(), 2);
                            assert_body(&round.steps[0].messages);
                            assert_eq!(round.steps[1].flag_updates, [(24, Vec::new())]);
                        }
                        _ => panic!("unexpected Mail sync result"),
                    }
                };
                let fixture = FixtureFetch::Page {
                    uids,
                    list_folders: false,
                };
                let (reply, (), ()) = tokio::time::timeout(WAIT, async {
                    tokio::join!(response, exchange, serve(listener, fixture))
                })
                .await
                .unwrap();
                serde_json::from_value::<Result<(), String>>(reply.unwrap())
                    .unwrap()
                    .unwrap();
            });
        });
    }
}

fn assert_body(messages: &[taomni_mail_engine::MailMessageCached]) {
    assert_eq!(messages.len(), 1);
    let message = &messages[0];
    assert_eq!(message.header.uid, 24);
    assert_eq!(message.header.folder, FOLDER);
    assert_eq!(message.header.account_id, ACCOUNT);
    assert!(message.body_cached_at.is_some());
    assert!(message.body_text.as_deref().unwrap().contains(TEXT.trim()));
}
