//! Resolve and decode an attachment inside its POP3 mailbox owner.

use taomni_mail_api::{
    archive_original::MAX_ARCHIVE_ORIGINAL_REQUEST,
    imap_exchange::{AttachmentReceipt, read_bounded_body_frame},
    message::DownloadedMailAttachment,
    pop3_store::Pop3AttachmentRequest,
};
use taomni_mail_engine::{extract_attachment, pop3::local_store::read_local_raw};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::runtime::Runtime;

use super::{
    account_cache::lock_account_cache,
    imap_archive_original::send,
    store::{Store, open_database, unavailable, validate_account},
};

pub(super) fn serve(
    runtime: &Runtime,
    store: &Store,
    operation: &Operation,
    endpoint: Endpoint,
) -> Result<Result<(), String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(operation.while_current(endpoint.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    let input = runtime
        .block_on(operation.while_current(read_bounded_body_frame(
            &mut peer,
            MAX_ARCHIVE_ORIGINAL_REQUEST,
        )))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let request: Pop3AttachmentRequest = serde_json::from_slice(&input)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let attachment = load(store, &request, &|| operation.check_current())?;
    send(
        runtime,
        operation,
        &mut peer,
        Some(AttachmentReceipt {
            name: attachment.name,
            content_type: attachment.content_type,
            size: attachment.bytes.len(),
        }),
        attachment.bytes.as_slice(),
    )
}

fn load(
    store: &Store,
    request: &Pop3AttachmentRequest,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<DownloadedMailAttachment, RpcError> {
    let account = &request.account_id;
    let folder = &request.folder;
    let uid = request.uid;
    validate_account(account)?;
    if folder.trim().is_empty() || uid == 0 {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    check()?;
    let read = |db: &rusqlite::Connection| read_local_raw(db, account, folder, uid);
    let raw = match &request.legacy_database {
        Some(database) => {
            if store.owns_pop3_cache(account)? {
                return Err(RpcError::new(
                    ErrorCode::InvalidState,
                    "POP3 mailbox ownership has changed. Retry from the current account",
                ));
            }
            let _access = lock_account_cache(database, account)
                .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
            read(&open_database(database)?).map_err(|_| unavailable())?
        }
        None => {
            store.require_pop3_owner(account)?;
            store.query(account, read)?
        }
    };
    let raw = raw.ok_or_else(|| {
        RpcError::new(
            ErrorCode::InvalidState,
            format!("message {uid} is not in the local {folder} folder"),
        )
    })?;
    check()?;
    let attachment = extract_attachment(&raw, request.index)
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error))?;
    check()?;
    Ok(attachment)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        io::{BufRead, BufReader, Write},
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };

    use rusqlite::{Connection, params};
    use serde_json::{Value, json};
    use taomni_mail_api::{
        HOST_REQUEST_TIMEOUT,
        imap_exchange::{read_body_frame, write_body_frame},
        pop3_store::READ_POP3_ATTACHMENT,
    };
    use taomni_mail_engine::{
        cache::init_mail_tables,
        database::mail_db_file_stem,
        pop3::{
            local_store::{ensure_local_folders, migrate_local_tables},
            ownership::mark_owned,
        },
    };
    use taomni_plugin_api::{HandshakeRequest, HandshakeResponse, RpcMessage, RpcRequest};
    use taomni_plugin_sdk::{HostConfig, PluginHandler, serve as serve_sdk};
    use taomni_plugin_stream::routed_tcp::Route;
    use tokio::io::AsyncReadExt;

    use super::*;

    const ACCOUNT: &str = "pop3-attach@example.test";
    const BINARY: &[u8] = &[0x00, 0x7f, 0x80, 0xff];
    const MIME: &[u8] = concat!(
        "Subject: POP3 attachment test\r\nMIME-Version: 1.0\r\n",
        "Content-Type: multipart/mixed; boundary=pop3part\r\n\r\n",
        "--pop3part\r\nContent-Type: text/plain\r\n\r\nBody text\r\n",
        "--pop3part\r\nContent-Type: application/octet-stream\r\n",
        "Content-Disposition: attachment; filename=part.bin\r\n",
        "Content-Transfer-Encoding: base64\r\n\r\nAH+A/w==\r\n",
        "--pop3part--\r\n",
    )
    .as_bytes();

    fn insert_raw(db: &Connection, account: &str, folder: &str, uid: u32, raw: &[u8]) {
        db.execute(
            "INSERT INTO mail_local_raw (account_id, folder, uid, raw) VALUES (?1, ?2, ?3, ?4)",
            params![account, folder, uid, raw],
        )
        .unwrap();
    }

    fn seed_owned_store(profile: &Path, account: &str, folder: &str, uid: u32) -> Store {
        std::fs::create_dir_all(profile).unwrap();
        let store = Store::new(profile);
        store
            .mutate(account, true, &|| Ok(()), |db| {
                ensure_local_folders(db, account).map_err(|_| unavailable())?;
                insert_raw(db, account, folder, uid, MIME);
                Ok(())
            })
            .unwrap();
        mark_owned(&store.pop3_data(account).unwrap(), account).unwrap();
        store
    }

    fn seed_legacy_db(dir: &Path, account: &str, folder: &str, uid: u32) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let db_path = dir.join(format!("{}.db", mail_db_file_stem(account)));
        let db = Connection::open(&db_path).unwrap();
        init_mail_tables(&db).unwrap();
        migrate_local_tables(&db).unwrap();
        insert_raw(&db, account, folder, uid, MIME);
        db_path
    }

    fn test_request(
        legacy_database: Option<PathBuf>,
        folder: &str,
        uid: u32,
        index: usize,
    ) -> Pop3AttachmentRequest {
        Pop3AttachmentRequest {
            account_id: ACCOUNT.into(),
            legacy_database,
            folder: folder.into(),
            uid,
            index,
        }
    }

    fn call_in_process_handler(
        handler: Arc<dyn PluginHandler>,
        config: HostConfig,
        method: &str,
        params: Value,
    ) -> Value {
        let (client_rx, host_tx) = std::io::pipe().unwrap();
        let (host_rx, mut client_tx) = std::io::pipe().unwrap();
        let server_config = HostConfig {
            plugin_id: config.plugin_id.clone(),
            plugin_version: config.plugin_version.clone(),
            commands: config.commands.clone(),
            permissions: config.permissions.clone(),
            required_services: Default::default(),
            optional_services: Default::default(),
            operation_timeout: HOST_REQUEST_TIMEOUT,
            snapshot_timeout: Duration::from_secs(30),
        };
        let server = std::thread::spawn(move || {
            serve_sdk(
                host_rx,
                host_tx,
                "unit-token".into(),
                server_config,
                handler,
            )
        });
        let mut lines = BufReader::new(client_rx).lines();
        let mut rpc = |id: i64, method: &str, params: Value| -> taomni_plugin_api::RpcResponse {
            let req = RpcRequest::new(id, method, Some(params));
            serde_json::to_writer(&mut client_tx, &RpcMessage::Request(req)).unwrap();
            client_tx.write_all(b"\n").unwrap();
            client_tx.flush().unwrap();
            let line = lines.next().unwrap().unwrap();
            let RpcMessage::Response(response) = serde_json::from_str(&line).unwrap() else {
                panic!("expected RPC response");
            };
            response
        };
        let hs = HandshakeRequest::new(
            config.plugin_id,
            config.plugin_version,
            "unit-token",
            config.commands.into_iter().collect(),
            config.permissions.into_iter().collect(),
        );
        let hs_res = rpc(1, "plugin/handshake", serde_json::to_value(hs).unwrap());
        let hs_ok: HandshakeResponse = serde_json::from_value(hs_res.result.unwrap()).unwrap();
        assert!(hs_ok.accepted);
        let response = rpc(2, method, params);
        drop(client_tx);
        server.join().unwrap().unwrap();
        assert!(response.error.is_none(), "{:?}", response.error);
        response.result.unwrap()
    }

    #[test]
    fn reads_owned_and_legacy_databases_and_rejects_stale_or_invalid_requests() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let unowned_profile = root.join("unowned");
        std::fs::create_dir_all(&unowned_profile).unwrap();
        let unowned_store = Store::new(&unowned_profile);
        let legacy_db = seed_legacy_db(&root.join("legacy-unowned"), ACCOUNT, "INBOX", 5);

        // 1. Unowned store must reject legacy_database: None.
        assert!(
            load(&unowned_store, &test_request(None, "INBOX", 5, 0), &|| Ok(
                ()
            ))
            .is_err()
        );

        // 2. Unowned store reads a valid legacy_database.
        let legacy_part = load(
            &unowned_store,
            &test_request(Some(legacy_db.clone()), "INBOX", 5, 0),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(legacy_part.name.as_deref(), Some("part.bin"));
        assert_eq!(
            legacy_part.content_type.as_deref(),
            Some("application/octet-stream")
        );
        assert_eq!(legacy_part.bytes, BINARY);

        // 3. Owned store reads from plugins/mail/data when legacy_database is None.
        let owned_profile = root.join("owned");
        let owned_store = seed_owned_store(&owned_profile, ACCOUNT, "INBOX", 7);
        let owned_part =
            load(&owned_store, &test_request(None, "INBOX", 7, 0), &|| Ok(())).unwrap();
        assert_eq!(owned_part.name.as_deref(), Some("part.bin"));
        assert_eq!(owned_part.bytes, BINARY);

        // 4. Owned store rejects a stale legacy_database path.
        let owned_legacy_db = seed_legacy_db(&root.join("legacy-owned"), ACCOUNT, "INBOX", 7);
        let stale = load(
            &owned_store,
            &test_request(Some(owned_legacy_db), "INBOX", 7, 0),
            &|| Ok(()),
        )
        .unwrap_err();
        assert_eq!(stale.code, ErrorCode::InvalidState as i32);
        assert!(stale.message.contains("POP3 mailbox ownership has changed"));

        // 5. Invalid params, missing UID, out-of-range index, and cancellation.
        assert_eq!(
            load(&owned_store, &test_request(None, "   ", 7, 0), &|| Ok(()))
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams as i32
        );
        assert_eq!(
            load(&owned_store, &test_request(None, "INBOX", 0, 0), &|| Ok(()))
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams as i32
        );
        assert_eq!(
            load(
                &owned_store,
                &test_request(None, "INBOX", 99, 0),
                &|| Ok(())
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidState as i32
        );
        assert_eq!(
            load(&owned_store, &test_request(None, "INBOX", 7, 9), &|| Ok(()))
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams as i32
        );
        let cancelled = load(&owned_store, &test_request(None, "INBOX", 7, 0), &|| {
            Err(RpcError::from_code(ErrorCode::RequestCancelled))
        })
        .unwrap_err();
        assert_eq!(cancelled.code, ErrorCode::RequestCancelled as i32);
    }

    #[test]
    fn serve_transfers_attachment_and_rejects_truncated_requests_and_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().canonicalize().unwrap();
        let store = Arc::new(seed_owned_store(&profile, ACCOUNT, "Sent", 4));
        let handler = Arc::new(crate::Handler {
            store,
            io: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap(),
            encoders: Arc::new(tokio::sync::Semaphore::new(1)),
            prefetch: Arc::new(tokio::sync::Semaphore::new(1)),
        });

        let io = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        // Valid wire transfer over routed_tcp::Route.
        std::thread::scope(|scope| {
            io.block_on(async {
                let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
                let params = serde_json::to_value(endpoint).unwrap();
                let rpc = scope.spawn({
                    let handler = handler.clone();
                    move || {
                        call_in_process_handler(
                            handler,
                            crate::host_config(),
                            READ_POP3_ATTACHMENT,
                            params,
                        )
                    }
                });
                let request = serde_json::to_vec(&test_request(None, "Sent", 4, 0)).unwrap();
                write_body_frame(&mut peer, &request).await.unwrap();
                let header = read_body_frame(&mut peer).await.unwrap();
                let receipt = serde_json::from_slice::<Option<AttachmentReceipt>>(&header)
                    .unwrap()
                    .unwrap();
                assert_eq!(receipt.name.as_deref(), Some("part.bin"));
                assert_eq!(
                    receipt.content_type.as_deref(),
                    Some("application/octet-stream")
                );
                assert_eq!(receipt.size, BINARY.len());
                let mut bytes = Vec::new();
                peer.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, BINARY);
                assert_eq!(rpc.join().unwrap(), json!({"Ok": null}));
            });
        });

        // Truncated request frame returns InvalidParams from serve.
        struct TruncatedServe(Arc<crate::Handler>);
        impl PluginHandler for TruncatedServe {
            fn invoke(
                &self,
                operation: &Operation,
                _: &str,
                params: Option<Value>,
            ) -> Result<Value, RpcError> {
                let endpoint: Endpoint = serde_json::from_value(params.unwrap()).unwrap();
                match serve(&self.0.io, &self.0.store, operation, endpoint) {
                    Ok(inner) => Ok(serde_json::to_value(inner).unwrap()),
                    Err(err) => Ok(json!({"rpcErrorCode": err.code})),
                }
            }
        }
        let cfg = HostConfig {
            plugin_id: "truncated-test".into(),
            plugin_version: "1.0.0".into(),
            commands: BTreeSet::from(["test/serve".into()]),
            permissions: BTreeSet::new(),
            required_services: Default::default(),
            optional_services: Default::default(),
            operation_timeout: HOST_REQUEST_TIMEOUT,
            snapshot_timeout: Duration::from_secs(30),
        };
        std::thread::scope(|scope| {
            io.block_on(async {
                let (_route, endpoint, peer) = Route::pair().await.unwrap();
                let params = serde_json::to_value(endpoint).unwrap();
                let rpc = scope.spawn(move || {
                    call_in_process_handler(
                        Arc::new(TruncatedServe(handler)),
                        cfg,
                        "test/serve",
                        params,
                    )
                });
                drop(peer);
                assert_eq!(
                    rpc.join().unwrap(),
                    json!({"rpcErrorCode": ErrorCode::InvalidParams as i32})
                );
            });
        });

        // Truncated attachment payload returned by send reports Incomplete Mail archive read.
        struct ShortSend(Runtime);
        impl PluginHandler for ShortSend {
            fn invoke(
                &self,
                operation: &Operation,
                _: &str,
                params: Option<Value>,
            ) -> Result<Value, RpcError> {
                let endpoint: Endpoint = serde_json::from_value(params.unwrap()).unwrap();
                let (mut peer, _) = self
                    .0
                    .block_on(operation.while_current(endpoint.connect()))?
                    .map_err(|_| unavailable())?;
                let receipt = AttachmentReceipt {
                    name: Some("part.bin".into()),
                    content_type: Some("application/octet-stream".into()),
                    size: 10,
                };
                Ok(serde_json::to_value(send(
                    &self.0,
                    operation,
                    &mut peer,
                    Some(receipt),
                    &b"abc"[..],
                )?)
                .unwrap())
            }
        }
        let send_cfg = HostConfig {
            plugin_id: "short-send-test".into(),
            plugin_version: "1.0.0".into(),
            commands: BTreeSet::from(["test/send".into()]),
            permissions: BTreeSet::new(),
            required_services: Default::default(),
            optional_services: Default::default(),
            operation_timeout: HOST_REQUEST_TIMEOUT,
            snapshot_timeout: Duration::from_secs(30),
        };
        std::thread::scope(|scope| {
            io.block_on(async {
                let (_route, endpoint, mut peer) = Route::pair().await.unwrap();
                let params = serde_json::to_value(endpoint).unwrap();
                let rpc = scope.spawn(move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    call_in_process_handler(Arc::new(ShortSend(rt)), send_cfg, "test/send", params)
                });
                let _header = read_body_frame(&mut peer).await.unwrap();
                let mut rest = Vec::new();
                peer.read_to_end(&mut rest).await.unwrap();
                assert_eq!(rest, b"abc");
                let reply = rpc.join().unwrap();
                assert!(
                    reply["Err"]
                        .as_str()
                        .unwrap()
                        .contains("Incomplete Mail archive read"),
                    "{reply}"
                );
            });
        });
    }
}
