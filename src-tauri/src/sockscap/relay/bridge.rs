use super::admission::enable_keepalive;
use super::limits::RELAY_FIRST_BYTE_TIMEOUT;
use super::limits::RELAY_PREFIX_WRITE_TIMEOUT;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::time::Duration;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::io::ReadBuf;
use tokio::net::TcpStream;

pub(super) async fn write_prefix<W>(remote: &mut W, prefix: &[u8]) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    if prefix.is_empty() {
        return Ok(());
    }
    tokio::time::timeout(RELAY_PREFIX_WRITE_TIMEOUT, remote.write_all(prefix))
        .await
        .map_err(|_| {
            format!(
                "prefix write timed out after {}s",
                RELAY_PREFIX_WRITE_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("prefix write: {e}"))
}

pub(super) async fn bridge_tcp<A>(a: &mut A, b: &mut TcpStream) -> Result<(u64, u64), String>
where
    A: AsyncRead + AsyncWrite + Unpin,
{
    // Both ends are real sockets here (direct, HTTP CONNECT, SOCKS5 and the
    // xray-core inbound all return one), so both get keepalive.
    enable_keepalive(b);
    bridge_any(a, b).await
}

/// Wraps a stream so the bridge can tell whether any data has moved, without
/// giving up `copy_bidirectional`'s buffering. Only reads are counted: every
/// byte that crosses the bridge is read from one side first.
pub(super) struct Activity<'a, S> {
    pub(super) inner: &'a mut S,
    pub(super) reads: Arc<AtomicU64>,
}

impl<S: AsyncRead + Unpin> AsyncRead for Activity<'_, S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        let before = buf.filled().len();
        let r = Pin::new(&mut *me.inner).poll_read(cx, buf);
        if matches!(r, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            me.reads.fetch_add(1, Ordering::Relaxed);
        }
        r
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Activity<'_, S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut *self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.get_mut().inner).poll_shutdown(cx)
    }
}

pub(super) async fn bridge_any<A, B>(a: &mut A, b: &mut B) -> Result<(u64, u64), String>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    bridge_any_until(a, b, RELAY_FIRST_BYTE_TIMEOUT).await
}

pub(super) async fn bridge_any_until<A, B>(
    a: &mut A,
    b: &mut B,
    first_byte_timeout: Duration,
) -> Result<(u64, u64), String>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let reads = Arc::new(AtomicU64::new(0));
    let mut ta = Activity {
        inner: a,
        reads: Arc::clone(&reads),
    };
    let mut tb = Activity {
        inner: b,
        reads: Arc::clone(&reads),
    };
    let copy = tokio::io::copy_bidirectional(&mut ta, &mut tb);
    tokio::pin!(copy);

    // Guard only the establishment phase. A flow that has never moved a byte in
    // either direction is not going to; one that has is a legitimate session
    // whose quiet periods are none of our business. Without this, a flow that
    // connected but never spoke held its slot for the lifetime of the process —
    // which is how a handful of broken flows could exhaust capacity outright.
    tokio::select! {
        r = &mut copy => r.map_err(|e| format!("bridge: {e}")),
        _ = tokio::time::sleep(first_byte_timeout) => {
            if reads.load(Ordering::Relaxed) == 0 {
                Err(format!(
                    "no data in either direction within {:?}; abandoning flow",
                    first_byte_timeout
                ))
            } else {
                copy.await.map_err(|e| format!("bridge: {e}"))
            }
        }
    }
}
