use super::*;
#[test]
#[ignore = "requires TAOMNI_VAULT_PASSWORD and live Outlook network access"]
fn live_saved_outlook_oauth2_probe() {
    let session_name = std::env::var("TAOMNI_LIVE_MAIL_SESSION")
        .expect("TAOMNI_LIVE_MAIL_SESSION must name the saved mail session to probe");
    let vault_password = std::env::var("TAOMNI_VAULT_PASSWORD")
        .expect("TAOMNI_VAULT_PASSWORD must be set for this ignored live test");
    let app_data = live_app_data_dir();
    let db_path = app_data.join("taomni.db");
    let vault_path = app_data.join("vault.db");
    println!("appData={}", app_data.display());

    let db = Connection::open(&db_path).expect("open taomni.db");
    let sessions = crate::session::db::list_sessions(&db, None).expect("list sessions");
    let session = sessions
        .into_iter()
        .find(|candidate| candidate.name == session_name || candidate.id == session_name)
        .unwrap_or_else(|| panic!("saved mail session `{session_name}` not found"));
    let options = serde_json::from_str::<serde_json::Value>(&session.options_json)
        .expect("parse session options");
    let email = session
        .username
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| session.name.clone());
    let token_ref = options
        .get("mailOauthTokenRef")
        .and_then(serde_json::Value::as_str)
        .expect("mailOauthTokenRef missing");
    let client_id = options
        .get("mailOauthClientId")
        .and_then(serde_json::Value::as_str)
        .expect("mailOauthClientId missing");
    let imap_host = session.host.clone();
    let imap_port = session.port;
    let smtp_host = options
        .get("mailSmtpHost")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("smtp-mail.outlook.com")
        .to_string();
    let smtp_port = options
        .get("mailSmtpPort")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(587);

    println!("sessionId={}", session.id);
    println!("email={email}");
    println!("clientId={client_id}");
    println!("imap={imap_host}:{imap_port}");
    println!("smtp={smtp_host}:{smtp_port}");

    let vault = crate::vault::Vault::open(&vault_path).expect("open vault.db");
    vault.unlock(&vault_password).expect("unlock vault");
    let token_json = vault
        .resolve(token_ref)
        .expect("resolve OAuth token ref")
        .expect("OAuth token ref not found");
    let mut bundle =
        serde_json::from_str::<MailOAuthTokenBundle>(&token_json).expect("parse token bundle");
    println!("storedExpiresAt={:?}", bundle.expires_at);
    println!("storedScope={:?}", bundle.scope);

    if oauth_token_expired(bundle.expires_at) {
        let refresh_token = bundle
            .refresh_token
            .as_deref()
            .and_then(non_empty_str)
            .expect("refresh token missing");
        let refresh_scope = oauth_refresh_scope(
            MailProvider::Outlook,
            &bundle,
            &MailOAuthSettings {
                client_id: Some(client_id.into()),
                client_secret: None,
                token_ref: Some(token_ref.into()),
                refresh_token_ref: None,
                expires_at: bundle.expires_at,
                scope: bundle.scope.clone(),
            },
        );
        let refreshed = refresh_oauth_token_blocking(
            MailProvider::Outlook,
            client_id,
            None,
            refresh_token,
            refresh_scope.as_deref(),
            None,
        )
        .expect("refresh OAuth token");
        bundle.access_token = refreshed.access_token;
        bundle.expires_at = refreshed
            .expires_in
            .map(|seconds| now_ts() + seconds.max(0));
        bundle.scope = refreshed.scope.and_then(non_empty).or(refresh_scope);
        println!("tokenRefreshedInMemory=true");
        println!("refreshedExpiresAt={:?}", bundle.expires_at);
        println!("refreshedScope={:?}", bundle.scope);
    }

    match jwt_claims_summary(&bundle.access_token) {
        Ok(claims) => println!(
            "jwtClaims={}",
            serde_json::to_string_pretty(&claims).expect("format claims")
        ),
        Err(error) => println!("jwtClaims=unavailable:{error}"),
    }

    let account = live_oauth_account(
        &session.id,
        &email,
        &imap_host,
        imap_port,
        &smtp_host,
        smtp_port,
        client_id,
        token_ref,
        &bundle,
    );
    match connect_imap(&account, &tokio::runtime::Handle::current()) {
        Ok(mut session) => {
            println!("imapCrateAuth=ok");
            let folders = session
                .list_folders(&account.config.session_id)
                .unwrap_or_default();
            println!("imapCrateFolderCount={}", folders.len());
            session.logout();
        }
        Err(error) => {
            println!("imapCrateAuth=err:{error}");
        }
    }

    let raw_initial =
        raw_imap_xoauth2_probe(&imap_host, imap_port, &email, &bundle.access_token, true)
            .expect("raw IMAP initial-response probe");
    println!("rawImapInitial={}", raw_initial.join(" | "));

    let raw_challenge =
        raw_imap_xoauth2_probe(&imap_host, imap_port, &email, &bundle.access_token, false)
            .expect("raw IMAP challenge-response probe");
    println!("rawImapChallenge={}", raw_challenge.join(" | "));

    let raw_smtp = raw_smtp_xoauth2_probe(&smtp_host, smtp_port, &email, &bundle.access_token)
        .expect("raw SMTP XOAUTH2 probe");
    println!("rawSmtp={}", raw_smtp.join(" | "));
}

fn live_app_data_dir() -> std::path::PathBuf {
    std::env::var("TAOMNI_APP_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .expect("resolve data dir")
                .join("com.taomni.app")
        })
}

fn live_oauth_account(
    session_id: &str,
    email: &str,
    imap_host: &str,
    imap_port: u16,
    smtp_host: &str,
    smtp_port: u16,
    client_id: &str,
    token_ref: &str,
    bundle: &MailOAuthTokenBundle,
) -> ResolvedMailAccount {
    ResolvedMailAccount {
        config: MailAccountConfig {
            session_id: session_id.into(),
            email_address: email.into(),
            provider: MailProvider::Outlook,
            auth_mode: MailAuthMode::OAuth2,
            display_name: None,
            reply_to: None,
            signature: None,
            imap: MailServerConfig {
                host: imap_host.into(),
                port: imap_port,
                username: Some(email.into()),
                password: None,
                security: MailConnectionSecurity::Tls,
                trusted_cert: None,
            },
            smtp: MailSmtpConfig {
                host: smtp_host.into(),
                port: smtp_port,
                username: Some(email.into()),
                password: None,
                security: MailConnectionSecurity::Starttls,
                use_imap_auth: true,
                trusted_cert: None,
            },
            oauth: MailOAuthSettings {
                client_id: Some(client_id.into()),
                client_secret: None,
                token_ref: Some(token_ref.into()),
                refresh_token_ref: None,
                expires_at: bundle.expires_at,
                scope: bundle.scope.clone(),
            },
            network_settings: None,
            sync: MailSyncSettings::default(),
            cache: MailCacheSettings::default(),
            ai: MailAiSettings::default(),
            save_sent_copy: None,
            special_folders: HashMap::new(),
            incoming: MailIncomingProtocol::Imap,
            pop3_leave_days: None,
            carddav: None,
            caldav: None,
        },
        auth_mode: MailAuthMode::OAuth2,
        network_settings: None,
        imap_username: email.into(),
        imap_password: bundle.access_token.clone(),
        smtp_username: email.into(),
        smtp_password: bundle.access_token.clone(),
    }
}

fn jwt_claims_summary(access_token: &str) -> Result<serde_json::Value, String> {
    let parts = access_token.split('.').collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err("access token is opaque, not a JWT".into());
    }
    let claims_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|e| format!("decode JWT claims: {e}"))?;
    let claims = serde_json::from_slice::<serde_json::Value>(&claims_bytes)
        .map_err(|e| format!("parse JWT claims: {e}"))?;
    let mut summary = serde_json::Map::new();
    for key in [
        "aud",
        "iss",
        "tid",
        "azp",
        "appid",
        "scp",
        "upn",
        "preferred_username",
        "email",
        "unique_name",
        "exp",
        "nbf",
        "iat",
    ] {
        if let Some(value) = claims.get(key) {
            summary.insert(key.into(), value.clone());
        }
    }
    Ok(serde_json::Value::Object(summary))
}

fn raw_imap_xoauth2_probe(
    host: &str,
    port: u16,
    username: &str,
    access_token: &str,
    initial_response: bool,
) -> Result<Vec<String>, String> {
    let mut stream = tls_connect(host, port)?;
    let mut transcript = Vec::new();
    transcript.push(format!("S: {}", read_protocol_line(&mut stream)?));
    write_protocol_line(&mut stream, "A001 CAPABILITY")?;
    transcript.extend(tagged_response(&mut stream, "A001")?);
    let sasl = BASE64_STANDARD.encode(xoauth2_sasl_response(username, access_token));
    if initial_response {
        write_protocol_line(&mut stream, &format!("A002 AUTHENTICATE XOAUTH2 {sasl}"))?;
        transcript.extend(tagged_response(&mut stream, "A002")?);
    } else {
        write_protocol_line(&mut stream, "A002 AUTHENTICATE XOAUTH2")?;
        let line = read_protocol_line(&mut stream)?;
        transcript.push(format!("S: {line}"));
        if line.starts_with('+') {
            write_protocol_line(&mut stream, &sasl)?;
            transcript.extend(tagged_response(&mut stream, "A002")?);
        }
    }
    if transcript
        .iter()
        .any(|line| line.starts_with("S: A002 OK") || line.contains(" A002 OK "))
    {
        write_protocol_line(&mut stream, "A003 SELECT INBOX")?;
        transcript.extend(tagged_response(&mut stream, "A003")?);
    }
    let _ = write_protocol_line(&mut stream, "A004 LOGOUT");
    Ok(transcript)
}

fn raw_smtp_xoauth2_probe(
    host: &str,
    port: u16,
    username: &str,
    access_token: &str,
) -> Result<Vec<String>, String> {
    let tcp = std::net::TcpStream::connect((host, port))
        .map_err(|e| format!("SMTP TCP connect {host}:{port}: {e}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
        .map_err(|e| format!("SMTP read timeout setup: {e}"))?;
    tcp.set_write_timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
        .map_err(|e| format!("SMTP write timeout setup: {e}"))?;
    let mut tcp = tcp;
    let mut transcript = Vec::new();
    transcript.extend(smtp_response(&mut tcp)?);
    write_protocol_line(&mut tcp, "EHLO taomni.local")?;
    transcript.extend(smtp_response(&mut tcp)?);
    write_protocol_line(&mut tcp, "STARTTLS")?;
    transcript.extend(smtp_response(&mut tcp)?);
    let connector = TlsConnector::builder()
        .build()
        .map_err(|e| format!("SMTP TLS connector: {e}"))?;
    let mut tls = connector
        .connect(host, tcp)
        .map_err(|e| format!("SMTP STARTTLS handshake: {e}"))?;
    write_protocol_line(&mut tls, "EHLO taomni.local")?;
    transcript.extend(smtp_response(&mut tls)?);
    let sasl = BASE64_STANDARD.encode(xoauth2_sasl_response(username, access_token));
    write_protocol_line(&mut tls, &format!("AUTH XOAUTH2 {sasl}"))?;
    transcript.extend(smtp_response(&mut tls)?);
    let _ = write_protocol_line(&mut tls, "QUIT");
    Ok(transcript)
}

fn tls_connect(
    host: &str,
    port: u16,
) -> Result<native_tls::TlsStream<std::net::TcpStream>, String> {
    let tcp = std::net::TcpStream::connect((host, port))
        .map_err(|e| format!("TCP connect {host}:{port}: {e}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
        .map_err(|e| format!("read timeout setup: {e}"))?;
    tcp.set_write_timeout(Some(Duration::from_secs(DEFAULT_TIMEOUT_SECS)))
        .map_err(|e| format!("write timeout setup: {e}"))?;
    let connector = TlsConnector::builder()
        .build()
        .map_err(|e| format!("TLS connector: {e}"))?;
    connector
        .connect(host, tcp)
        .map_err(|e| format!("TLS handshake {host}:{port}: {e}"))
}

fn write_protocol_line(stream: &mut impl Write, line: &str) -> Result<(), String> {
    stream
        .write_all(format!("{line}\r\n").as_bytes())
        .map_err(|e| format!("write protocol line: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("flush protocol line: {e}"))
}

fn read_protocol_line(stream: &mut impl Read) -> Result<String, String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        stream
            .read_exact(&mut byte)
            .map_err(|e| format!("read protocol line: {e}"))?;
        buf.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf)
        .trim_end_matches(['\r', '\n'])
        .to_string())
}

fn tagged_response(stream: &mut impl Read, tag: &str) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    loop {
        let line = read_protocol_line(stream)?;
        let done = line.starts_with(&format!("{tag} "));
        lines.push(format!("S: {line}"));
        if done {
            return Ok(lines);
        }
    }
}

fn smtp_response(stream: &mut impl Read) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    loop {
        let line = read_protocol_line(stream)?;
        let complete = line.len() >= 4 && line.as_bytes().get(3) == Some(&b' ');
        lines.push(format!("S: {line}"));
        if complete {
            return Ok(lines);
        }
    }
}
