use std::{
    future::Future,
    net::{Shutdown, TcpStream},
    time::Duration,
};

use taomni_mail_api::{HOST_REQUEST_TIMEOUT, ImapFolderTree, IncomingTest, MailIncomingProtocol};
use taomni_mail_engine::{
    MailFolder,
    imap_transport::{ImapConnection, ImapSession},
    pop3::{Pop3Connection, Pop3Session},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{io::AsyncReadExt, net::tcp::OwnedReadHalf, runtime::Runtime, task::JoinHandle};

pub(super) fn check(
    runtime: &Runtime,
    operation: &Operation,
    input: IncomingTest,
) -> Result<Result<usize, String>, RpcError> {
    with_socket(runtime, operation, input, probe)
}

pub(super) fn imap_folder_tree(
    runtime: &Runtime,
    operation: &Operation,
    request: ImapFolderTree,
) -> Result<Result<Vec<MailFolder>, String>, RpcError> {
    let ImapFolderTree {
        connection,
        account_id,
        subscription,
    } = request;
    if connection.protocol != MailIncomingProtocol::Imap || account_id.trim().is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    with_socket(runtime, operation, connection, move |stream, input| {
        let mut session = open_imap(stream, &input)?;
        if let Some(change) = subscription {
            session.set_subscription(&change.folder, change.subscribed)?;
        }
        session.list_folders(&account_id)
    })
}

pub(super) fn with_socket<T: Send + 'static>(
    runtime: &Runtime,
    operation: &Operation,
    input: IncomingTest,
    work: impl FnOnce(TcpStream, IncomingTest) -> Result<T, String> + Send + 'static,
) -> Result<Result<T, String>, RpcError> {
    with_socket_and_reply(runtime, operation, input, None, work)
}

pub(super) fn with_socket_and_reply<T: Send + 'static>(
    runtime: &Runtime,
    operation: &Operation,
    input: IncomingTest,
    reply: Option<TcpStream>,
    work: impl FnOnce(TcpStream, IncomingTest) -> Result<T, String> + Send + 'static,
) -> Result<Result<T, String>, RpcError> {
    if input.server_name.trim().is_empty() || input.username.trim().is_empty() {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let stream = match runtime.block_on(while_current(operation, input.route.connect()))? {
        Ok((stream, _)) => stream,
        Err(error) => return Ok(Err(error)),
    };
    let stream = stream.into_std().map_err(|_| socket_error())?;
    configure(&stream, input.protocol)?;
    let interrupt = stream.try_clone().map_err(|_| socket_error())?;
    let result = runtime.block_on(async {
        let mut worker = tokio::task::spawn_blocking(move || work(stream, input));
        let result = while_current(operation, &mut worker).await;
        if result.is_err() {
            // Closing both halves wakes native TLS and any blocked protocol read.
            let _ = interrupt.shutdown(Shutdown::Both);
            if let Some(reply) = reply {
                let _ = reply.shutdown(Shutdown::Both);
            }
            let _ = worker.await;
        }
        result
    })?;
    operation.check_current()?;
    result.map_err(|_| RpcError::from_code(ErrorCode::InternalError))
}

pub(super) async fn while_current<T>(
    operation: &Operation,
    work: impl Future<Output = T>,
) -> Result<T, RpcError> {
    tokio::pin!(work);
    let mut poll = tokio::time::interval(Duration::from_millis(20));
    loop {
        tokio::select! {
            biased;
            _ = poll.tick() => operation.check_current()?,
            result = &mut work => return Ok(result),
        }
    }
}

pub(super) async fn while_connected<T>(
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

pub(super) fn configure(
    stream: &TcpStream,
    protocol: MailIncomingProtocol,
) -> Result<(), RpcError> {
    let timeout = Duration::from_secs(match protocol {
        MailIncomingProtocol::Imap => 30,
        MailIncomingProtocol::Pop3 => 60,
    });
    stream.set_nonblocking(false).map_err(|_| socket_error())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|_| socket_error())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|_| socket_error())
}

fn socket_error() -> RpcError {
    RpcError::new(ErrorCode::InternalError, "MAIL_ROUTE_SOCKET_UNAVAILABLE")
}

pub(super) fn open_imap(stream: TcpStream, input: &IncomingTest) -> Result<ImapSession, String> {
    ImapConnection {
        server_name: &input.server_name,
        security: input.security,
        trusted_certificate: input.trusted_certificate.as_deref(),
        username: &input.username,
        secret: &input.secret,
        authentication: input.authentication,
        provider: input.provider,
    }
    .open(stream)
}

fn probe(stream: TcpStream, input: IncomingTest) -> Result<usize, String> {
    match input.protocol {
        MailIncomingProtocol::Imap => Ok(open_imap(stream, &input)?.list_folders("")?.len()),
        MailIncomingProtocol::Pop3 => {
            open_pop3(stream, &input)?.quit()?;
            Ok(0)
        }
    }
}

pub(super) fn open_pop3(stream: TcpStream, input: &IncomingTest) -> Result<Pop3Session, String> {
    Pop3Session::open(
        stream,
        &Pop3Connection {
            server_name: &input.server_name,
            security: input.security,
            trusted_certificate: input.trusted_certificate.as_deref(),
            username: &input.username,
            secret: &input.secret,
            authentication: input.authentication,
        },
    )
}
