//! Stream mbox bytes to the caller without opening its destination path.

use std::{
    io::{self, BufWriter, Write},
    net::Shutdown,
};

use taomni_mail_api::{
    MailIncomingProtocol,
    imap_exchange::{ExportMailbox, MBOX_EXPORT_FRAME_BYTES, write_frame},
};
use taomni_mail_engine::{imap_transport::imap_catch_result, mbox::imap_export_folder};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    runtime::Runtime,
    sync::mpsc,
};

use super::incoming::{configure, open_imap, while_current};

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: ExportMailbox,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Imap
        || request.connection.server_name.trim().is_empty()
        || request.connection.username.trim().is_empty()
        || request.folder.trim().is_empty()
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
        let _ = serve(exchange, request).await;
    });
    Ok(Ok(()))
}

async fn serve(exchange: TcpStream, request: ExportMailbox) -> io::Result<()> {
    let (mut reader, mut writer) = exchange.into_split();
    let connection = request.connection;
    let remote = tokio::select! {
        _ = reader.read_u8() => return Ok(()),
        remote = connection.route.connect() => remote,
    };
    let (socket, _) = match remote {
        Ok(pair) => pair,
        Err(error) => return finish(&mut writer, Err(error)).await,
    };
    let socket = socket.into_std()?;
    configure(&socket, MailIncomingProtocol::Imap)
        .map_err(|_| io::Error::other("Mail export socket setup failed"))?;
    let interrupt = socket.try_clone()?;
    let (sender, mut frames) = mpsc::channel(4);
    let worker = tokio::task::spawn_blocking(move || {
        imap_catch_result(|| {
            use taomni_mail_engine::imap_transport::ImapSession;
            let mut output = BufWriter::with_capacity(MBOX_EXPORT_FRAME_BYTES, FrameSink(sender));
            let count = match open_imap(socket, &connection)? {
                ImapSession::Plain(mut session) => {
                    imap_export_folder(&mut session, &request.folder, &mut output)
                }
                ImapSession::Tls(mut session) => {
                    imap_export_folder(&mut session, &request.folder, &mut output)
                }
            }?;
            output.flush().map_err(|error| error.to_string())?;
            Ok(count)
        })
    });
    let send_frames = async {
        while let Some(frame) = frames.recv().await {
            write_frame(&mut writer, &frame).await?;
        }
        Ok::<(), io::Error>(())
    };
    let sent = tokio::select! {
        _ = reader.read_u8() => Err(io::Error::new(io::ErrorKind::BrokenPipe, "Mail export was closed")),
        sent = send_frames => sent,
    };
    if sent.is_err() {
        drop(frames);
        let _ = interrupt.shutdown(Shutdown::Both);
        let _ = worker.await;
        return sent;
    }
    let result = worker.await.map_err(io::Error::other)?;
    finish(&mut writer, result).await
}

async fn finish(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    result: Result<usize, String>,
) -> io::Result<()> {
    // An empty frame terminates the content stream. The following receipt
    // distinguishes a completed export from a partly written mailbox.
    write_frame(writer, &[]).await?;
    write_frame(
        writer,
        &serde_json::to_vec(&result).map_err(io::Error::other)?,
    )
    .await?;
    writer.flush().await
}

struct FrameSink(mpsc::Sender<Vec<u8>>);

impl Write for FrameSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let size = bytes.len().min(MBOX_EXPORT_FRAME_BYTES);
        if size != 0 {
            self.0
                .blocking_send(bytes[..size].to_vec())
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "Mail export was closed"))?;
        }
        Ok(size)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_larger_buffers_as_bounded_frames_without_losing_bytes() {
        let body: Vec<u8> = (0..MBOX_EXPORT_FRAME_BYTES * 2 + 7)
            .map(|index| (index % 251) as u8)
            .collect();
        let (sender, mut receiver) = mpsc::channel(1);
        let expected = body.clone();
        let producer = tokio::task::spawn_blocking(move || FrameSink(sender).write_all(&body));
        let mut received = Vec::new();
        let mut sizes = Vec::new();
        while let Some(frame) = receiver.recv().await {
            sizes.push(frame.len());
            received.extend_from_slice(&frame);
        }
        producer.await.unwrap().unwrap();
        assert_eq!(sizes, [MBOX_EXPORT_FRAME_BYTES, MBOX_EXPORT_FRAME_BYTES, 7]);
        assert_eq!(received, expected);
    }
}
