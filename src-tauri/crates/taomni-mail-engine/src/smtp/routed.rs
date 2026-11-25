//! SMTP negotiation over the stream already authorized by the core.

use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use lettre::address::Envelope;
use lettre::transport::smtp::{
    authentication::{Credentials, DEFAULT_MECHANISMS, Mechanism},
    client::{AsyncSmtpConnection, AsyncTokioStream},
    extension::ClientId,
    response::Response,
};
use taomni_mail_api::compose::PreparedMail;
use taomni_mail_api::{SMTP_DELIVERY_UNKNOWN, SmtpConnection, SmtpDelivery};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf},
    net::TcpStream,
};
use tokio_native_tls::{TlsConnector, TlsStream};

use super::smtp_envelope;
use crate::{
    imap_auth::MailAuthMode,
    tls::{MailConnectionSecurity, smtp_tls_parameters, tls_connector},
};

pub async fn check_routed_connection(
    stream: TcpStream,
    request: &SmtpConnection,
) -> Result<(), String> {
    let mut client = connect(stream, request)
        .await
        .map_err(|error| format!("SMTP test failed: {error}"))?;
    let connected = client.test_connected().await;
    quit(&mut client).await;
    if connected {
        Ok(())
    } else {
        Err("SMTP test did not establish a connection".into())
    }
}

pub async fn send_routed_message(request: SmtpDelivery) -> Result<Response, String> {
    let envelope = smtp_envelope(request.sender.as_deref(), &request.recipients)?;
    let (source, _) = request.mime_source.connect().await?;
    let mut mime = Vec::new();
    source
        .take(request.mime_length.saturating_add(1))
        .read_to_end(&mut mime)
        .await
        .map_err(|error| format!("Read outgoing mail: {error}"))?;
    if mime.len() as u64 != request.mime_length {
        return Err("Outgoing message length did not match the authorized MIME source".into());
    }
    deliver(&request.connection, &envelope, &mime).await
}

pub async fn send_prepared_response(
    connection: &SmtpConnection,
    message: &PreparedMail,
) -> Result<Response, String> {
    let envelope = smtp_envelope(
        message.envelope.sender.as_deref(),
        &message.envelope.recipients,
    )?;
    deliver(connection, &envelope, &message.bytes).await
}

async fn deliver(
    connection: &SmtpConnection,
    envelope: &Envelope,
    mime: &[u8],
) -> Result<Response, String> {
    let (stream, _) = connection.route.connect().await?;
    let mut client = connect(stream, connection)
        .await
        .map_err(|error| super::send_error(&error))?;
    let result = client.send(envelope, mime).await.map_err(|error| {
        if error.status().is_none() && !error.is_client() {
            format!("{SMTP_DELIVERY_UNKNOWN}: {error}. Verify delivery before resending.")
        } else {
            super::send_error(&error.to_string())
        }
    });
    // Bound the cleanup independently of the final DATA response.
    if result.is_ok() {
        quit(&mut client).await;
    }
    result
}

async fn connect(
    stream: TcpStream,
    request: &SmtpConnection,
) -> Result<AsyncSmtpConnection, String> {
    let hello = ClientId::default();
    let trusted = request.trusted_certificate.as_deref();
    let transport: Box<dyn AsyncTokioStream> = match request.security {
        MailConnectionSecurity::Tls => {
            let connector = TlsConnector::from(tls_connector(trusted)?);
            let secured = connector
                .connect(&request.server_name, stream)
                .await
                .map_err(|error| error.to_string())?;
            Box::new(SmtpTlsStream(secured))
        }
        _ => Box::new(stream),
    };
    let mut client = AsyncSmtpConnection::connect_with_transport(transport, &hello)
        .await
        .map_err(|error| error.to_string())?;
    if request.security == MailConnectionSecurity::Starttls {
        let tls = smtp_tls_parameters(&request.server_name, trusted)?;
        client
            .starttls(tls, &hello)
            .await
            .map_err(|error| error.to_string())?;
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
        .map_err(|error| error.to_string())?;
    Ok(client)
}

async fn quit(client: &mut AsyncSmtpConnection) {
    let _ = tokio::time::timeout(Duration::from_secs(1), client.quit()).await;
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
