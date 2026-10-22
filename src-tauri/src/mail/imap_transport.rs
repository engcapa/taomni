use super::*;

pub(super) struct Xoauth2Authenticator {
    pub(super) username: String,
    pub(super) access_token: String,
}

impl imap::Authenticator for Xoauth2Authenticator {
    type Response = String;

    fn process(&self, _challenge: &[u8]) -> Self::Response {
        xoauth2_sasl_response(&self.username, &self.access_token)
    }
}

pub(super) fn xoauth2_sasl_response(username: &str, access_token: &str) -> String {
    format!("user={username}\x01auth=Bearer {access_token}\x01\x01")
}

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

pub(super) fn authenticate_imap_client<T: Read + Write>(
    client: imap::Client<T>,
    account: &ResolvedMailAccount,
) -> Result<imap::Session<T>, String> {
    match account.auth_mode {
        MailAuthMode::Password => {
            login_imap_client(client, &account.imap_username, &account.imap_password)
        }
        MailAuthMode::OAuth2 => {
            let auth = Xoauth2Authenticator {
                username: account.imap_username.clone(),
                access_token: account.imap_password.clone(),
            };
            if account.config.provider == MailProvider::Outlook {
                let initial_response = BASE64_STANDARD
                    .encode(xoauth2_sasl_response(&auth.username, &auth.access_token));
                client
                    .authenticate(format!("XOAUTH2 {initial_response}"), &auth)
                    .map_err(|(e, _)| imap_xoauth2_auth_error(account.config.provider, e))
            } else {
                client
                    .authenticate("XOAUTH2", &auth)
                    .map_err(|(e, _)| imap_xoauth2_auth_error(account.config.provider, e))
            }
        }
    }
}

pub(super) fn imap_xoauth2_auth_error(provider: MailProvider, error: imap::Error) -> String {
    let detail = error.to_string();
    if provider == MailProvider::Outlook
        && detail.contains("User is authenticated but not connected")
    {
        format!(
            "IMAP XOAUTH2 authentication failed: {detail}. Outlook accepted the OAuth token, but the mailbox was not connected. Enable IMAP in Outlook.com Settings > Mail > Forwarding and IMAP, then retry. If it still fails, approve the recent IMAP sign-in activity at account.live.com/activity."
        )
    } else {
        format!("IMAP XOAUTH2 authentication failed: {detail}")
    }
}

pub(super) fn login_imap_client<T: Read + Write>(
    mut client: imap::Client<T>,
    username: &str,
    password: &str,
) -> Result<imap::Session<T>, String> {
    for attempt in 0..=IMAP_LOGIN_RETRY_DELAYS_MS.len() {
        match client.login(username, password) {
            Ok(session) => return Ok(session),
            Err((e, next_client)) => {
                let message = e.to_string();
                client = next_client;
                let retry_limit_reached = attempt >= IMAP_LOGIN_RETRY_DELAYS_MS.len();
                let retryable = should_retry_imap_login(&message);
                if retry_limit_reached || !retryable {
                    return Err(format!("IMAP login failed: {message}"));
                }

                let delay_ms = IMAP_LOGIN_RETRY_DELAYS_MS[attempt];
                tracing::debug!(
                    "transient IMAP login failure; retrying in {delay_ms}ms: {message}"
                );
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }

    Err("IMAP login failed".into())
}

pub(super) fn should_retry_imap_login(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    if message.contains("authenticationfailed")
        || message.contains("authentication failed")
        || message.contains("invalid credentials")
        || message.contains("invalid login")
        || message.contains("bad credentials")
        || (message.contains("password") && message.contains("incorrect"))
    {
        return false;
    }

    message.contains("login error")
        || message.contains("no response")
        || message.contains("temporar")
        || message.contains("try again")
        || message.contains("rate")
        || message.contains("throttl")
        || message.contains("too many")
        || message.contains("timeout")
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
