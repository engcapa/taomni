use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};

trait RdpIo: AsyncRead + AsyncWrite + Unpin + Send + Sync {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send + Sync> RdpIo for T {}

type ConnectFuture = Pin<Box<dyn Future<Output = Result<RdpTransport, String>> + Send>>;

/// A route provider for the initial connection and for desktop-size reconnects.
pub type RdpConnector = Arc<dyn Fn() -> ConnectFuture + Send + Sync>;

/// Open one raw channel to the selected RD Gateway. The RDP host does the TLS
/// handshake and never chooses the upstream address for this route.
pub fn gateway_socket(host: &str, port: u16) -> RdpConnector {
    let address = format!("{}:{port}", host.trim());
    Arc::new(move || {
        let address = address.clone();
        Box::pin(async move {
            let tcp = TcpStream::connect(&address)
                .await
                .map_err(|error| format!("rdg: connect {address}: {error}"))?;
            tcp.set_nodelay(true)
                .map_err(|error| format!("rdg: set TCP_NODELAY: {error}"))?;
            let local = tcp.local_addr().map_err(|error| error.to_string())?;
            Ok(RdpTransport::new(tcp, local))
        })
    })
}

pub struct RdpTransport {
    stream: Box<dyn RdpIo>,
    pub local_addr: SocketAddr,
}

impl RdpTransport {
    pub fn new(
        stream: impl AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static,
        local_addr: SocketAddr,
    ) -> Self {
        Self {
            stream: Box::new(stream),
            local_addr,
        }
    }
}

impl AsyncRead for RdpTransport {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}

impl AsyncWrite for RdpTransport {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
