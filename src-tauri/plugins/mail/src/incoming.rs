use std::{
    future::Future,
    net::{Shutdown, TcpStream},
    time::Duration,
};

use taomni_mail_api::{IncomingTest, MailIncomingProtocol};
use taomni_mail_engine::{
    imap_folders::imap_list_folders,
    imap_transport::{ImapConnection, ImapSession},
    pop3::{Pop3Connection, Pop3Session},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::runtime::Runtime;

pub(super) fn check(
    runtime: &Runtime,
    operation: &Operation,
    input: IncomingTest,
) -> Result<Result<usize, String>, RpcError> {
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
        let mut worker = tokio::task::spawn_blocking(move || probe(stream, input));
        let result = while_current(operation, &mut worker).await;
        if result.is_err() {
            // Closing both halves wakes native TLS and any blocked protocol read.
            let _ = interrupt.shutdown(Shutdown::Both);
            let _ = worker.await;
        }
        result
    })?;
    operation.check_current()?;
    result.map_err(|_| RpcError::from_code(ErrorCode::InternalError))
}

async fn while_current<T>(
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

fn configure(stream: &TcpStream, protocol: MailIncomingProtocol) -> Result<(), RpcError> {
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

fn probe(stream: TcpStream, input: IncomingTest) -> Result<usize, String> {
    let trusted_certificate = input.trusted_certificate.as_deref();
    match input.protocol {
        MailIncomingProtocol::Imap => {
            let connection = ImapConnection {
                server_name: &input.server_name,
                security: input.security,
                trusted_certificate,
                username: &input.username,
                secret: &input.secret,
                authentication: input.authentication,
                provider: input.provider,
            };
            let folders = match connection.open(stream)? {
                ImapSession::Plain(mut session) => imap_list_folders(&mut session, "")?,
                ImapSession::Tls(mut session) => imap_list_folders(&mut session, "")?,
            };
            Ok(folders.len())
        }
        MailIncomingProtocol::Pop3 => {
            let connection = Pop3Connection {
                server_name: &input.server_name,
                security: input.security,
                trusted_certificate,
                username: &input.username,
                secret: &input.secret,
                authentication: input.authentication,
            };
            Pop3Session::open(stream, &connection)?.quit()?;
            Ok(0)
        }
    }
}
