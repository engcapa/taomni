//! A tab owns an authenticated notification socket. Closing it interrupts IMAP.

use std::{
    io,
    net::{Shutdown, TcpStream},
};

use taomni_mail_api::{
    MailIncomingProtocol,
    imap_exchange::{ImapIdleNotice, OpenImapIdle, write_frame},
};
use taomni_mail_engine::imap_transport::imap_catch_result;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{
    io::{AsyncReadExt, AsyncWrite},
    runtime::Runtime,
    sync::mpsc,
};

use super::incoming::{configure, open_imap};

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: OpenImapIdle,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Imap
        || request.connection.server_name.trim().is_empty()
        || request.connection.username.trim().is_empty()
        || request.folder.trim().is_empty()
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let (exchange, _) =
        match runtime.block_on(operation.while_current(request.exchange.connect()))? {
            Ok(pair) => pair,
            Err(error) => return Ok(Err(error)),
        };
    operation.check_current()?;
    runtime.spawn(async move {
        let _ = serve(exchange, request).await;
    });
    Ok(Ok(()))
}

async fn serve(exchange: tokio::net::TcpStream, request: OpenImapIdle) -> io::Result<()> {
    let (mut read, mut write) = exchange.into_split();
    let stream = tokio::select! {
        _ = read.read_u8() => return Ok(()),
        connected = request.connection.route.connect() => connected,
    };
    let (stream, _) = match stream {
        Ok(pair) => pair,
        Err(error) => return send(&mut write, ImapIdleNotice::Error(error)).await,
    };
    let stream = stream.into_std()?;
    configure(&stream, MailIncomingProtocol::Imap)
        .map_err(|_| io::Error::other("IMAP IDLE socket setup failed"))?;
    let interrupt = stream.try_clone()?;
    let (notices, mut events) = mpsc::channel(4);
    let worker = tokio::task::spawn_blocking(move || watch(stream, request, notices));
    let forward = async {
        while let Some(notice) = events.recv().await {
            send(&mut write, notice).await?;
        }
        Ok(())
    };
    let result = tokio::select! {
        _ = read.read_u8() => Ok(()),
        result = forward => result,
    };
    drop(events);
    let _ = interrupt.shutdown(Shutdown::Both);
    let _ = worker.await;
    result
}

fn watch(stream: TcpStream, request: OpenImapIdle, notices: mpsc::Sender<ImapIdleNotice>) {
    let result = imap_catch_result(|| {
        let mut session = open_imap(stream, &request.connection)?;
        if !session.prepare_idle(&request.folder)? {
            let _ = notices.blocking_send(ImapIdleNotice::Unsupported);
            return Ok(());
        }
        if notices.blocking_send(ImapIdleNotice::Ready).is_err() {
            return Ok(());
        }
        loop {
            let notice = if session.idle_changed()? {
                ImapIdleNotice::Changed
            } else {
                ImapIdleNotice::Refresh
            };
            if notices.blocking_send(notice).is_err() {
                return Ok(());
            }
        }
    });
    if let Err(error) = result {
        let _ = notices.blocking_send(ImapIdleNotice::Error(error));
    }
}

async fn send(stream: &mut (impl AsyncWrite + Unpin), notice: ImapIdleNotice) -> io::Result<()> {
    let bytes = serde_json::to_vec(&notice).map_err(io::Error::other)?;
    write_frame(stream, &bytes).await
}
