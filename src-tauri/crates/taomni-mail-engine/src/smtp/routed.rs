//! SMTP negotiation over the stream already authorized by the core.

use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use lettre::transport::smtp::{
    authentication::{Credentials, DEFAULT_MECHANISMS, Mechanism},
    client::{AsyncSmtpConnection, AsyncTokioStream},
    extension::ClientId,
};
use taomni_mail_api::OutgoingTest;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};
use tokio_native_tls::{TlsConnector, TlsStream};

use crate::{
    imap_auth::MailAuthMode,
    tls::{MailConnectionSecurity, smtp_tls_parameters, tls_connector},
};

pub async fn check_routed_connection(
    stream: TcpStream,
    request: &OutgoingTest,
) -> Result<(), String> {
    let hello = ClientId::default();
    let trusted = request.trusted_certificate.as_deref();
    let transport: Box<dyn AsyncTokioStream> = match request.security {
        MailConnectionSecurity::Tls => {
            let connector = TlsConnector::from(tls_connector(trusted)?);
            let secured = connector
                .connect(&request.server_name, stream)
                .await
                .map_err(smtp_error)?;
            Box::new(SmtpTlsStream(secured))
        }
        _ => Box::new(stream),
    };
    let mut client = AsyncSmtpConnection::connect_with_transport(transport, &hello)
        .await
        .map_err(smtp_error)?;
    if request.security == MailConnectionSecurity::Starttls {
        let tls = smtp_tls_parameters(&request.server_name, trusted)?;
        client.starttls(tls, &hello).await.map_err(smtp_error)?;
    }
    let mechanisms = match request.authentication {
        MailAuthMode::OAuth2 => &[Mechanism::Xoauth2],
        MailAuthMode::Password => DEFAULT_MECHANISMS,
    };
    client
        .auth(
            mechanisms,
            &Credentials::new(request.username.clone(), request.secret.to_string()),
        )
        .await
        .map_err(smtp_error)?;
    let connected = client.test_connected().await;
    let _ = tokio::time::timeout(Duration::from_secs(1), client.quit()).await;
    if connected {
        Ok(())
    } else {
        Err("SMTP test did not establish a connection".into())
    }
}

fn smtp_error(error: impl std::fmt::Display) -> String {
    format!("SMTP test failed: {error}")
}

#[derive(Debug)]
struct SmtpTlsStream(TlsStream<TcpStream>);

impl AsyncTokioStream for SmtpTlsStream {
    fn peer_addr(&self) -> io::Result<SocketAddr> {
        self.0.get_ref().get_ref().get_ref().peer_addr()
    }
}

impl AsyncRead for SmtpTlsStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(context, buffer)
    }
}

impl AsyncWrite for SmtpTlsStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(context, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(context)
    }
}
