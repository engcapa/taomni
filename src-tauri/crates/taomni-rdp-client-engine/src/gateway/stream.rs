use super::ndr;
use super::payload::ReceivePipePayload;
use super::payload::build_send_to_server_request;
use super::payload::decode_receive_pipe_response;
use super::rpc::parse_response_pdu;
use super::rpc_transport::read_non_rts_pdu;
use super::transport::GatewayTlsStream;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt as _;
use tokio::io::DuplexStream;
use tokio::io::ReadBuf;
use tokio::sync::watch;
// ── GatewayStream ──────────────────────────────────────────────────────

/// Bidirectional pipe abstraction over the IN/OUT HTTPS channels.
///
/// Reads are delivered by the RPC_OUT_DATA receive-pipe task; writes are
/// serialized through TsProxySendToServer on RPC_IN_DATA.
pub struct GatewayStream {
    pub(super) reader: Pin<Box<dyn AsyncRead + Send + Sync>>,
    pub(super) writer: Pin<Box<dyn AsyncWrite + Send + Sync>>,
    pub(super) cancel_tx: Option<watch::Sender<()>>,
}

impl GatewayStream {
    pub fn new<R: AsyncRead + Send + Sync + 'static, W: AsyncWrite + Send + Sync + 'static>(
        reader: R,
        writer: W,
    ) -> Self {
        Self {
            reader: Box::pin(reader),
            writer: Box::pin(writer),
            cancel_tx: None,
        }
    }

    pub(super) fn with_cancel(mut self, cancel_tx: watch::Sender<()>) -> Self {
        self.cancel_tx = Some(cancel_tx);
        self
    }
}

impl Drop for GatewayStream {
    fn drop(&mut self) {
        self.cancel_tx.take();
    }
}

impl AsyncRead for GatewayStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.reader).poll_read(cx, buf)
    }
}

impl AsyncWrite for GatewayStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.writer).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.writer).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.writer).poll_shutdown(cx)
    }
}

pub(super) fn spawn_gateway_stream(
    in_stream: GatewayTlsStream,
    out_stream: GatewayTlsStream,
    tunnel_context: ndr::ContextHandle,
    channel_context: ndr::ContextHandle,
    receive_call_id: u32,
) -> GatewayStream {
    let (reader_tx, reader_rx) = tokio::io::duplex(64 * 1024);
    let (writer_tx, writer_rx) = tokio::io::duplex(64 * 1024);
    let next_call_id = Arc::new(AtomicU32::new(100));
    let (cancel_tx, cancel_rx) = watch::channel(());

    tokio::spawn(gateway_reader_task(
        out_stream,
        reader_tx,
        receive_call_id,
        cancel_rx,
    ));
    tokio::spawn(gateway_writer_task(
        in_stream,
        writer_rx,
        tunnel_context,
        channel_context,
        next_call_id,
    ));

    GatewayStream::new(reader_rx, writer_tx).with_cancel(cancel_tx)
}

pub(super) async fn gateway_reader_task(
    mut out_stream: GatewayTlsStream,
    mut reader_tx: DuplexStream,
    receive_call_id: u32,
    mut cancel_rx: watch::Receiver<()>,
) {
    loop {
        let pdu = tokio::select! {
            pdu = read_non_rts_pdu(&mut out_stream) => match pdu {
                Ok(pdu) => pdu,
                Err(e) => {
                    tracing::debug!("rdg reader stopped: {}", e);
                    let _ = reader_tx.shutdown().await;
                    return;
                }
            },
            changed = cancel_rx.changed() => {
                if changed.is_err() {
                    tracing::debug!("rdg reader cancelled");
                    let _ = reader_tx.shutdown().await;
                    return;
                }
                continue;
            }
        };
        let resp = match parse_response_pdu(&pdu) {
            Ok(resp) => resp,
            Err(_) => continue,
        };
        if resp.header.call_id != receive_call_id {
            continue;
        }
        match decode_receive_pipe_response(&resp) {
            Ok(ReceivePipePayload::Data(data)) => {
                if reader_tx.write_all(&data).await.is_err() {
                    return;
                }
            }
            Ok(ReceivePipePayload::FinalReturn(_)) | Err(_) => {
                let _ = reader_tx.shutdown().await;
                return;
            }
        }
    }
}

pub(super) async fn gateway_writer_task(
    mut in_stream: GatewayTlsStream,
    mut writer_rx: DuplexStream,
    tunnel_context: ndr::ContextHandle,
    channel_context: ndr::ContextHandle,
    next_call_id: Arc<AtomicU32>,
) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = match writer_rx.read(&mut buf).await {
            Ok(0) => {
                close_gateway_contexts(
                    &mut in_stream,
                    &channel_context,
                    &tunnel_context,
                    &next_call_id,
                )
                .await;
                return;
            }
            Ok(n) => n,
            Err(e) => {
                tracing::debug!("rdg writer stopped: {}", e);
                close_gateway_contexts(
                    &mut in_stream,
                    &channel_context,
                    &tunnel_context,
                    &next_call_id,
                )
                .await;
                return;
            }
        };
        let call_id = next_call_id.fetch_add(1, Ordering::Relaxed);
        let pdu = match build_send_to_server_request(call_id, &channel_context, &buf[..n]) {
            Ok(pdu) => pdu,
            Err(e) => {
                tracing::debug!("rdg writer stopped: {}", e);
                return;
            }
        };
        if let Err(e) = in_stream.write_all(&pdu).await {
            tracing::debug!("rdg writer write failed: {}", e);
            close_gateway_contexts(
                &mut in_stream,
                &channel_context,
                &tunnel_context,
                &next_call_id,
            )
            .await;
            return;
        }
    }
}

pub(super) async fn close_gateway_contexts<S>(
    in_stream: &mut S,
    channel_context: &ndr::ContextHandle,
    tunnel_context: &ndr::ContextHandle,
    next_call_id: &AtomicU32,
) where
    S: AsyncWrite + Unpin,
{
    let close_channel_id = next_call_id.fetch_add(1, Ordering::Relaxed);
    let close_channel = ndr::build_close_channel_request(close_channel_id, channel_context);
    if let Err(e) = in_stream.write_all(&close_channel).await {
        tracing::debug!("rdg close channel write failed: {}", e);
        let _ = in_stream.shutdown().await;
        return;
    }

    let close_tunnel_id = next_call_id.fetch_add(1, Ordering::Relaxed);
    let close_tunnel = ndr::build_close_tunnel_request(close_tunnel_id, tunnel_context);
    if let Err(e) = in_stream.write_all(&close_tunnel).await {
        tracing::debug!("rdg close tunnel write failed: {}", e);
    }
    let _ = in_stream.shutdown().await;
}
