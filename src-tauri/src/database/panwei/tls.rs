use super::connection::connect;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadBuf;
use tokio_opengauss::tls::ChannelBinding as OgChannelBinding;
use tokio_opengauss::tls::MakeTlsConnect;
use tokio_opengauss::tls::TlsConnect;
use tokio_opengauss::tls::TlsStream as OgTlsStream;

#[derive(Clone)]
pub(super) struct PanWeiNativeTls {
    pub(super) connector: tokio_native_tls::TlsConnector,
}

pub(super) struct PanWeiNativeTlsConnect {
    pub(super) connector: tokio_native_tls::TlsConnector,
    pub(super) domain: String,
}

pub(super) struct PanWeiNativeTlsStream<S>(pub(super) tokio_native_tls::TlsStream<S>);

impl PanWeiNativeTls {
    pub(super) fn new() -> Result<Self, native_tls::Error> {
        let mut builder = native_tls::TlsConnector::builder();
        // The UI currently exposes a single "encrypted connection" checkbox,
        // without CA/certificate pinning fields. Match SQL Server's existing
        // trust_cert behavior so self-signed intranet PanWeiDB deployments can
        // still get transport encryption.
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
        Ok(Self {
            connector: tokio_native_tls::TlsConnector::from(builder.build()?),
        })
    }
}

impl<S> MakeTlsConnect<S> for PanWeiNativeTls
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = PanWeiNativeTlsStream<S>;
    type TlsConnect = PanWeiNativeTlsConnect;
    type Error = native_tls::Error;

    fn make_tls_connect(&mut self, domain: &str) -> Result<Self::TlsConnect, Self::Error> {
        Ok(PanWeiNativeTlsConnect {
            connector: self.connector.clone(),
            domain: domain.to_string(),
        })
    }
}

impl<S> TlsConnect<S> for PanWeiNativeTlsConnect
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = PanWeiNativeTlsStream<S>;
    type Error = native_tls::Error;
    type Future =
        Pin<Box<dyn Future<Output = Result<PanWeiNativeTlsStream<S>, native_tls::Error>> + Send>>;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move {
            self.connector
                .connect(&self.domain, stream)
                .await
                .map(PanWeiNativeTlsStream)
        })
    }
}

impl<S> AsyncRead for PanWeiNativeTlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl<S> AsyncWrite for PanWeiNativeTlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl<S> OgTlsStream for PanWeiNativeTlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn channel_binding(&self) -> OgChannelBinding {
        OgChannelBinding::none()
    }
}
