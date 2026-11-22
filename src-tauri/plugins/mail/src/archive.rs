//! Keep one cancellable IMAP connection for a full-message storage scan.

use std::net::{Shutdown, TcpStream};

use serde::Serialize;
use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, IncomingTest, MailIncomingProtocol,
    imap_exchange::{ImapExchange, read_frame, write_frame},
};
use taomni_mail_engine::{
    archive::{ArchiveChunk, ArchiveQuery},
    imap_transport::{ImapSession, imap_catch_result},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::tcp::OwnedReadHalf,
    runtime::Runtime,
    task::JoinHandle,
};

use super::incoming::{configure, open_imap, while_current};

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Imap
        || request.connection.server_name.trim().is_empty()
        || request.connection.username.trim().is_empty()
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let (exchange, _) =
        match runtime.block_on(while_current(operation, request.exchange.connect()))? {
            Ok(pair) => pair,
            Err(error) => return Ok(Err(error)),
        };
    operation.check_current()?;
    runtime.spawn(async move {
        let _ = serve(exchange, request.connection).await;
    });
    Ok(Ok(()))
}

async fn serve(exchange: tokio::net::TcpStream, connection: IncomingTest) -> std::io::Result<()> {
    let (mut read, mut write) = exchange.into_split();
    let stream = tokio::select! {
        _ = read.read_u8() => return Ok(()),
        result = connection.route.connect() => result
    };
    let (stream, _) = match stream {
        Ok(pair) => pair,
        Err(error) => return write_frame(&mut write, &encode::<()>(Err(error))?).await,
    };
    let stream = stream.into_std()?;
    configure(&stream, MailIncomingProtocol::Imap)
        .map_err(|_| std::io::Error::other("Mail archive socket setup failed"))?;
    let interrupt = stream.try_clone()?;
    let opening =
        tokio::task::spawn_blocking(move || imap_catch_result(|| open_imap(stream, &connection)));
    let Some(result) = while_connected(&mut read, &interrupt, opening).await else {
        return Ok(());
    };
    let mut session = match result {
        Ok(session) => session,
        Err(error) => return write_frame(&mut write, &encode::<()>(Err(error))?).await,
    };
    write_frame(&mut write, &encode(Ok(()))?).await?;

    loop {
        let frame = read_frame(&mut read).await?;
        let query =
            serde_json::from_slice::<ArchiveQuery>(&frame).map_err(std::io::Error::other)?;
        let worker = tokio::task::spawn_blocking(move || {
            let result = reply(&mut session, query);
            (session, result)
        });
        let Some((saved_session, response)) = while_connected(&mut read, &interrupt, worker).await
        else {
            return Ok(());
        };
        session = saved_session;
        let (header, chunk) = response?;
        write_frame(&mut write, &header).await?;
        if let Some(chunk) = chunk {
            write_frame(&mut write, &chunk).await?;
        }
        write.flush().await?;
    }
}

async fn while_connected<T>(
    peer: &mut OwnedReadHalf,
    interrupt: &TcpStream,
    mut worker: JoinHandle<T>,
) -> Option<T> {
    tokio::select! {
        result = &mut worker => return result.ok(),
        _ = peer.read_u8() => {},
        _ = tokio::time::sleep(HOST_REQUEST_TIMEOUT) => {},
    }
    let _ = interrupt.shutdown(Shutdown::Both);
    let _ = worker.await;
    None
}

fn encode<T: Serialize>(result: Result<T, String>) -> std::io::Result<Vec<u8>> {
    serde_json::to_vec(&result).map_err(std::io::Error::other)
}

fn reply(
    session: &mut ImapSession,
    query: ArchiveQuery,
) -> std::io::Result<(Vec<u8>, Option<Vec<u8>>)> {
    match query {
        ArchiveQuery::Folders { account_id } => Ok((
            encode(imap_catch_result(|| session.list_folders(&account_id)))?,
            None,
        )),
        ArchiveQuery::Headers(request) => Ok((
            encode(imap_catch_result(|| session.sync_headers(&request)))?,
            None,
        )),
        ArchiveQuery::Chunk {
            folder,
            uid,
            offset,
        } => match imap_catch_result(|| session.archive_chunk(&folder, uid, offset)) {
            Ok((uid_validity, reported_size, bytes)) => {
                let receipt = ArchiveChunk {
                    uid_validity,
                    reported_size,
                    length: bytes.len(),
                };
                Ok((encode(Ok(receipt))?, Some(bytes)))
            }
            Err(error) => Ok((encode::<ArchiveChunk>(Err(error))?, None)),
        },
    }
}
