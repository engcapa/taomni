use super::*;

#[cfg(test)]
pub(super) use taomni_mail_engine::imap_auth::xoauth2_sasl_response;
#[cfg(any(test, feature = "legacy-mail-imap"))]
use taomni_mail_engine::imap_transport::{ImapConnection, ImapSession};

pub(super) struct ProxyForward(JoinHandle<()>);

impl Drop for ProxyForward {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(any(test, feature = "legacy-mail-imap"))]
pub(super) fn connect_imap(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<ActiveImapSession, String> {
    connect_imap_with_socket(account, runtime).map(|(session, _)| session)
}

/// Connect and also return a clone of the TCP socket, so a watcher can shut
/// the connection down from another thread (e.g. to end a blocked IDLE).
#[cfg(any(test, feature = "legacy-mail-imap"))]
pub(super) fn connect_imap_with_socket(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<(ActiveImapSession, Option<TcpStream>), String> {
    let host = account.config.imap.host.trim();
    let port = account.config.imap.port;
    let (connect_host, connect_port, forward_task) =
        mail_effective_endpoint(account, host, port, runtime)?;
    let stream = tcp_connect(&connect_host, connect_port)?;
    let socket = stream.try_clone().ok();
    let connection = ImapConnection {
        server_name: host,
        security: account.config.imap.security,
        trusted_certificate: account.config.imap.trusted_cert.as_deref(),
        username: &account.imap_username,
        secret: &account.imap_password,
        authentication: account.auth_mode,
        provider: account.config.provider,
    };
    let session = match connection.open(stream)? {
        ImapSession::Tls(session) => ActiveImapSession::Tls {
            session,
            forward_task,
        },
        ImapSession::Plain(session) => ActiveImapSession::Plain {
            session,
            forward_task,
        },
    };
    Ok((session, socket))
}

pub(super) fn mail_effective_endpoint(
    account: &ResolvedMailAccount,
    host: &str,
    port: u16,
    runtime: &tokio::runtime::Handle,
) -> Result<(String, u16, Option<ProxyForward>), String> {
    let Some(network) = account.network_settings.clone() else {
        return Ok((host.to_string(), port, None));
    };
    // Use the caller's Handle without entering the runtime on this thread for
    // the whole IMAP/SMTP lifetime. `block_on` only needs the Handle; keeping
    // `enter()` active breaks `reqwest::blocking` (nested Runtime drop panic).
    let forward = runtime.block_on(crate::database::forward::start(
        host.to_string(),
        port,
        network,
    ))?;
    Ok((
        "127.0.0.1".to_string(),
        forward.local_port,
        Some(ProxyForward(forward.task)),
    ))
}

pub(super) fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECS);
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("failed to resolve {host}:{port}: {e}"))?;
    let mut last_error = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                return Ok(stream);
            }
            Err(e) => last_error = Some(e),
        }
    }
    Err(format!(
        "failed to connect to {host}:{port}: {}",
        last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no resolved address".into())
    ))
}

#[cfg(test)]
mod tests {
    use super::ProxyForward;
    use std::future::pending;
    use std::time::Duration;
    use tokio::sync::oneshot;
    use tokio::time::timeout;

    #[tokio::test]
    async fn forwarder_is_cancelled_when_its_connection_owner_leaves() {
        let (released, stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let _released = released;
            pending::<()>().await;
        });
        let forward = ProxyForward(task);
        assert!(!forward.0.is_finished());

        drop(forward);
        assert!(
            timeout(Duration::from_secs(1), stopped)
                .await
                .expect("forwarder task did not stop")
                .is_err()
        );
    }
}
