//! A bounded background IMAP connection for recently observed message bodies.

use std::{net::Shutdown, sync::Arc, time::Duration};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, IncomingTest, MailIncomingProtocol,
    imap_exchange::{ImapExchange, PrefetchBodies, read_frame, write_body_frame, write_frame},
};
use taomni_mail_engine::imap_transport::{ImapBodyReply, ImapBodyRequest, imap_catch_result};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    runtime::Runtime,
    sync::{Semaphore, mpsc},
    time::timeout,
};

use super::incoming::{configure, open_imap, while_current};

type Item = (Result<ImapBodyReply, String>, Option<Vec<u8>>);

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
    pool: &Arc<Semaphore>,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Imap
        || request.connection.server_name.trim().is_empty()
        || request.connection.username.trim().is_empty()
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let Ok(lease) = pool.clone().try_acquire_owned() else {
        return Ok(Err("Mail background transfers are busy".into()));
    };
    let (exchange, _) =
        match runtime.block_on(while_current(operation, request.exchange.connect()))? {
            Ok(pair) => pair,
            Err(error) => return Ok(Err(error)),
        };
    operation.check_current()?;
    runtime.spawn(async move {
        let _lease = lease;
        serve(exchange, request.connection).await;
    });
    Ok(Ok(()))
}

async fn serve(mut exchange: TcpStream, connection: IncomingTest) {
    let Ok(Ok(input)) = timeout(Duration::from_secs(5), read_frame(&mut exchange)).await else {
        return;
    };
    let Ok(batch) = serde_json::from_slice::<PrefetchBodies>(&input) else {
        return;
    };
    if !batch.is_valid() {
        return;
    }
    let (mut read, mut write) = exchange.into_split();
    let imap = tokio::select! {
        _ = read.read_u8() => return,
        result = connection.route.connect() => result,
    };
    let Ok((stream, _)) = imap else { return };
    let Ok(stream) = stream.into_std() else {
        return;
    };
    if configure(&stream, MailIncomingProtocol::Imap).is_err() {
        return;
    }
    let Ok(interrupt) = stream.try_clone() else {
        return;
    };
    let (output, mut received) = mpsc::channel(1);
    let worker = tokio::task::spawn_blocking(move || {
        let established = imap_catch_result(|| open_imap(stream, &connection));
        let mut session = match established {
            Ok(session) => session,
            Err(error) => {
                for _ in batch.uids {
                    if output.blocking_send((Err(error.clone()), None)).is_err() {
                        break;
                    }
                }
                return;
            }
        };
        for uid in batch.uids {
            let request = ImapBodyRequest {
                account_id: batch.account_id.clone(),
                folder: batch.folder.clone(),
                uid,
                body_max_bytes: batch.body_max_bytes,
                save_original: batch.save_original,
            };
            let item = match imap_catch_result(|| session.fetch_body(&request)) {
                Ok((message, bytes)) => (
                    Ok(ImapBodyReply {
                        message,
                        original_size: bytes.as_ref().map(Vec::len),
                    }),
                    bytes,
                ),
                Err(error) => (Err(error), None),
            };
            if output.blocking_send(item).is_err() {
                break;
            }
        }
    });
    let _ = timeout(HOST_REQUEST_TIMEOUT, async {
        tokio::select! {
            _ = read.read_u8() => {}
            _ = send_bodies(&mut write, &mut received) => {}
        }
    })
    .await;
    let _ = interrupt.shutdown(Shutdown::Both);
    drop(received);
    let _ = worker.await;
}

async fn send_bodies(
    writer: &mut (impl AsyncWrite + Unpin),
    input: &mut mpsc::Receiver<Item>,
) -> std::io::Result<()> {
    while let Some((reply, original)) = input.recv().await {
        let frame = serde_json::to_vec(&reply).map_err(std::io::Error::other)?;
        write_body_frame(writer, &frame).await?;
        if let Some(original) = original {
            write_frame(writer, &original).await?;
        }
        writer.flush().await?;
    }
    writer.shutdown().await
}
