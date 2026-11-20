use super::*;

pub(super) use taomni_mail_engine::imap_auth::xoauth2_sasl_response;

pub(super) fn connect_imap(
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
) -> Result<ActiveImapSession, String> {
    connect_imap_with_socket(account, runtime).map(|(session, _)| session)
}

/// Connect and also return a clone of the TCP socket, so a watcher can shut
/// the connection down from another thread (e.g. to end a blocked IDLE).
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
    let trusted = account.config.imap.trusted_cert.as_deref();
    let pinned = trusted.is_some_and(|value| !value.trim().is_empty());
    let session = match account.config.imap.security {
        MailConnectionSecurity::Tls => {
            let connector = certs::tls_connector(trusted)?;
            let tls_stream = connector.connect(host, stream).map_err(|e| {
                certs::certificate_error_hint(&format!("IMAP TLS handshake failed: {e}"), pinned)
            })?;
            let mut client = imap::Client::new(tls_stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            ActiveImapSession::Tls {
                session: authenticate_imap_client(client, account)?,
                forward_task,
            }
        }
        MailConnectionSecurity::Starttls => {
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            let connector = certs::tls_connector(trusted)?;
            let client = client.secure(host, &connector).map_err(|e| {
                certs::certificate_error_hint(&format!("IMAP STARTTLS failed: {e}"), pinned)
            })?;
            ActiveImapSession::Tls {
                session: authenticate_imap_client(client, account)?,
                forward_task,
            }
        }
        MailConnectionSecurity::None => {
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|e| format!("IMAP greeting failed: {e}"))?;
            ActiveImapSession::Plain {
                session: authenticate_imap_client(client, account)?,
                forward_task,
            }
        }
    };
    Ok((session, socket))
}

pub(super) fn mail_effective_endpoint(
    account: &ResolvedMailAccount,
    host: &str,
    port: u16,
    runtime: &tokio::runtime::Handle,
) -> Result<(String, u16, Option<JoinHandle<()>>), String> {
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
        Some(forward.task),
    ))
}

fn authenticate_imap_client<T: Read + Write>(
    client: imap::Client<T>,
    account: &ResolvedMailAccount,
) -> Result<imap::Session<T>, String> {
    taomni_mail_engine::imap_auth::authenticate(
        client,
        &account.imap_username,
        &account.imap_password,
        account.auth_mode,
        account.config.provider,
    )
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
