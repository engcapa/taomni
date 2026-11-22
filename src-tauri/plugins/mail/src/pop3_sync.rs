//! The signed Mail host owns the server connection for a POP3 sync round.

use std::io;

use serde::Serialize;
use taomni_mail_api::{
    IncomingTest, MailIncomingProtocol,
    imap_exchange::{read_frame, write_body_frame},
    pop3_exchange::{Pop3Command, Pop3Exchange},
};
use taomni_mail_engine::pop3::Pop3Session;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    runtime::Runtime,
};

use super::incoming::{configure, open_pop3, while_connected, while_current};

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: Pop3Exchange,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Pop3
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

async fn serve(exchange: tokio::net::TcpStream, connection: IncomingTest) -> io::Result<()> {
    let (mut read, mut write) = exchange.into_split();
    let stream = tokio::select! {
        _ = read.read_u8() => return Ok(()),
        result = connection.route.connect() => result,
    };
    let (stream, _) = match stream {
        Ok(pair) => pair,
        Err(error) => return write_body_frame(&mut write, &encode::<()>(Err(error))?).await,
    };
    let stream = stream.into_std()?;
    configure(&stream, MailIncomingProtocol::Pop3)
        .map_err(|_| io::Error::other("POP3 socket setup failed"))?;
    let interrupt = stream.try_clone()?;
    let opening = tokio::task::spawn_blocking(move || open_pop3(stream, &connection));
    let Some(result) = while_connected(&mut read, &interrupt, opening).await else {
        return Ok(());
    };
    let mut session = match result {
        Ok(session) => session,
        Err(error) => return write_body_frame(&mut write, &encode::<()>(Err(error))?).await,
    };
    write_body_frame(&mut write, &encode(Ok(()))?).await?;
    write.flush().await?;

    loop {
        let command =
            serde_json::from_slice(&read_frame(&mut read).await?).map_err(io::Error::other)?;
        let worker = tokio::task::spawn_blocking(move || respond(session, command));
        let Some(response) = while_connected(&mut read, &interrupt, worker).await else {
            return Ok(());
        };
        let (returned_session, metadata, original) = response?;
        write_body_frame(&mut write, &metadata).await?;
        if let Some(original) = original {
            write_body_frame(&mut write, &original).await?;
        }
        write.flush().await?;
        let Some(returned_session) = returned_session else {
            return Ok(());
        };
        session = returned_session;
    }
}

type Reply = (Option<Pop3Session>, Vec<u8>, Option<Vec<u8>>);

fn respond(mut session: Pop3Session, command: Pop3Command) -> io::Result<Reply> {
    let (metadata, original) = match command {
        Pop3Command::Uidl => (encode(session.uidl())?, None),
        Pop3Command::Retrieve { number } => match session.retr(number) {
            Ok(bytes) => (encode(Ok(()))?, Some(bytes)),
            Err(error) => (encode::<()>(Err(error))?, None),
        },
        Pop3Command::Delete { number } => (encode(session.dele(number))?, None),
        // Only the caller that durably saved the messages can authorize QUIT.
        // A lost request stream drops the socket and rolls back pending DELEs.
        Pop3Command::Quit => return Ok((None, encode(session.quit())?, None)),
    };
    Ok((Some(session), metadata, original))
}

fn encode<T: Serialize>(result: Result<T, String>) -> io::Result<Vec<u8>> {
    serde_json::to_vec(&result).map_err(io::Error::other)
}
