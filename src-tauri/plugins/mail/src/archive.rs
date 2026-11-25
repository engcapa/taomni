//! Serve cancellable IMAP sessions across a series of Mail requests.

use serde::{Serialize, de::DeserializeOwned};
use taomni_mail_api::{
    IncomingTest, MailIncomingProtocol,
    imap_exchange::{
        ImapExchange, ImportMessage, MAX_IMPORT_MESSAGE_BYTES, read_bounded_body_frame, read_frame,
        write_frame,
    },
    imap_mutation::MutationRequest,
};
use taomni_mail_engine::{
    archive::{ArchiveChunk, ArchiveQuery},
    imap_transport::{ImapSession, imap_catch_result},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    runtime::Runtime,
};

use super::incoming::{configure, open_imap, while_connected, while_current};

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    start_session(runtime, operation, request, None, |session, query, _| {
        reply(session, query)
    })
}

pub(super) fn start_mutations(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    start_session(
        runtime,
        operation,
        request,
        None,
        |session, request: MutationRequest, _| {
            let result = imap_catch_result(|| Ok(session.mutate(request)));
            Ok((encode(result)?, None))
        },
    )
}

pub(super) fn start_import(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
) -> Result<Result<(), String>, RpcError> {
    start_session(
        runtime,
        operation,
        request,
        Some(MAX_IMPORT_MESSAGE_BYTES),
        |session, request: ImportMessage, message| {
            let result = imap_catch_result(|| session.append_imported(&request.folder, &message));
            Ok((encode(result)?, None))
        },
    )
}

type Reply = std::io::Result<(Vec<u8>, Option<Vec<u8>>)>;
type ImapWork<Query> = fn(&mut ImapSession, Query, Vec<u8>) -> Reply;

fn start_session<Query: DeserializeOwned + Send + 'static>(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapExchange,
    max_body: Option<u64>,
    reply: ImapWork<Query>,
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
        let _ = serve(exchange, request.connection, max_body, reply).await;
    });
    Ok(Ok(()))
}

async fn serve<Query: DeserializeOwned + Send + 'static>(
    exchange: tokio::net::TcpStream,
    connection: IncomingTest,
    max_body: Option<u64>,
    reply: ImapWork<Query>,
) -> std::io::Result<()> {
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
        .map_err(|_| std::io::Error::other("Mail IMAP session socket setup failed"))?;
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
        let query = serde_json::from_slice::<Query>(&frame).map_err(std::io::Error::other)?;
        let body = match max_body {
            Some(limit) => read_bounded_body_frame(&mut read, limit).await?,
            None => Vec::new(),
        };
        let worker = tokio::task::spawn_blocking(move || {
            let result = reply(&mut session, query, body);
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

fn encode<T: Serialize>(result: Result<T, String>) -> std::io::Result<Vec<u8>> {
    serde_json::to_vec(&result).map_err(std::io::Error::other)
}

fn reply(session: &mut ImapSession, query: ArchiveQuery) -> Reply {
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
