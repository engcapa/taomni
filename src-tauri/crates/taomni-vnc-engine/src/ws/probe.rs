use std::{future::Future, net::Shutdown};

use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::{limits::DecodeLimits, policy::VncSecurityPolicy, tls::prepare_rfb_transport};

use super::{ForwardTaskGuard, RelayRequest, VNC_AUTH_TIMEOUT, VncDialedTransport};

pub struct ProbeRequest {
    pub host: String,
    pub username: Option<String>,
    pub password: Option<Zeroizing<String>>,
    pub security_policy: VncSecurityPolicy,
    pub allow_unencrypted: bool,
}

impl From<RelayRequest> for ProbeRequest {
    fn from(request: RelayRequest) -> Self {
        Self {
            host: request.host,
            username: request.username,
            password: request.password,
            security_policy: request.security_policy,
            allow_unencrypted: request.options.allow_unencrypted,
        }
    }
}

/// Close the socket if the probe future is dropped during blocking authentication.
struct ProbeSocket(std::net::TcpStream);

impl Drop for ProbeSocket {
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

pub async fn probe_connection(
    request: ProbeRequest,
    dial: impl Future<Output = Result<VncDialedTransport, String>> + Send,
    attempt: CancellationToken,
) -> Result<String, String> {
    tokio::select! {
        result = authenticate(request, dial) => result,
        _ = attempt.cancelled() => Err("VNC connection attempt stopped by the user".into()),
    }
}

async fn authenticate(
    request: ProbeRequest,
    dial: impl Future<Output = Result<VncDialedTransport, String>> + Send,
) -> Result<String, String> {
    let transport = dial.await?;
    let _forward = ForwardTaskGuard::new(transport.network_forward_task);
    let mut prepared = prepare_rfb_transport(
        transport.stream,
        &request.host,
        request.security_policy,
        VNC_AUTH_TIMEOUT,
        request.allow_unencrypted,
        request
            .username
            .as_deref()
            .is_some_and(|name| !name.trim().is_empty()),
    )
    .await?;
    let _tls = ForwardTaskGuard::new(prepared.take_tls_task());
    let _socket = ProbeSocket(
        prepared
            .try_clone_stream()
            .map_err(|error| format!("clone VNC stream for connection test: {error}"))?,
    );
    tokio::task::spawn_blocking(move || {
        let mut rfb = prepared.into_connection(
            VNC_AUTH_TIMEOUT,
            request.security_policy,
            DecodeLimits::default(),
        )?;
        let init = rfb.authenticate_with_policy(
            request.username.as_deref(),
            request.password.as_deref().map(String::as_str),
            request.security_policy,
        )?;
        Ok(format!(
            "Connection successful: {}x{} - {}",
            init.width, init.height, init.name
        ))
    })
    .await
    .map_err(|error| format!("VNC handshake worker failed: {error}"))?
}
