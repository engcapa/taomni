use super::*;

fn sample_message() -> Vec<u8> {
    b"From: Example Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nDate: Tue, 30 Jun 2026 08:00:00 +0800\r\nMessage-ID: <sample@example.com>\r\nSubject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from Taomni Mail.\r\n"
            .to_vec()
}

fn sample_attachment_message() -> Vec<u8> {
    b"From: Example Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nSubject: Attachment sample\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody text.\r\n--b\r\nContent-Type: text/plain; name=\"report.txt\"\r\nContent-Disposition: attachment; filename=\"report.txt\"\r\n\r\nAttachment content.\r\n--b--\r\n"
            .to_vec()
}

fn sample_inline_image_message() -> Vec<u8> {
    // 1x1 PNG (68 bytes raw) base64-encoded for a multipart/related sample.
    b"From: Example Sender <sender@example.com>\r\n\
To: Receiver <receiver@example.com>\r\n\
Subject: Inline image sample\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"rel\"\r\n\
\r\n\
--rel\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Logo: <img src=\"cid:logo@inline.local\" alt=\"logo\"></p>\r\n\
--rel\r\n\
Content-Type: image/png; name=\"logo.png\"\r\n\
Content-Transfer-Encoding: base64\r\n\
Content-ID: <logo@inline.local>\r\n\
Content-Disposition: inline; filename=\"logo.png\"\r\n\
\r\n\
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==\r\n\
--rel--\r\n"
            .to_vec()
}

#[test]
fn should_list_remote_folders_only_when_refresh_or_cache_empty() {
    assert!(should_list_remote_folders(true, 0));
    assert!(should_list_remote_folders(true, 12));
    assert!(should_list_remote_folders(false, 0));
    assert!(!should_list_remote_folders(false, 3));
}

#[test]
fn folders_for_header_sync_merges_selected_into_cached_base() {
    let base = vec![
        MailFolder {
            account_id: "acct".into(),
            name: "INBOX".into(),
            display_name: "INBOX".into(),
            delimiter: Some("/".into()),
            flags: vec![],
            uid_validity: Some(1),
            uid_next: Some(10),
            total: Some(9),
            unread: Some(2),
            updated_at: 1,
            ..MailFolder::default()
        },
        MailFolder {
            account_id: "acct".into(),
            name: "Sent".into(),
            display_name: "Sent".into(),
            delimiter: Some("/".into()),
            flags: vec![],
            uid_validity: Some(1),
            uid_next: Some(3),
            total: Some(2),
            unread: Some(0),
            updated_at: 1,
            ..MailFolder::default()
        },
    ];
    let selected = MailFolder {
        account_id: "acct".into(),
        name: "INBOX".into(),
        display_name: "INBOX".into(),
        delimiter: Some("/".into()),
        flags: vec!["\\HasNoChildren".into()],
        uid_validity: Some(1),
        uid_next: Some(15),
        total: Some(14),
        unread: Some(4),
        updated_at: 99,
        ..MailFolder::default()
    };
    let merged = folders_for_header_sync(base, selected);
    assert_eq!(merged.len(), 2);
    let inbox = merged.iter().find(|f| f.name == "INBOX").unwrap();
    assert_eq!(inbox.total, Some(14));
    assert_eq!(inbox.unread, Some(4));
    assert_eq!(inbox.updated_at, 99);
    assert!(merged.iter().any(|f| f.name == "Sent"));
}

#[test]
fn network_fingerprint_is_direct_without_session_proxy() {
    assert_eq!(network_fingerprint(None), "direct");
    let none_kind = NetworkSettings {
        proxy_kind: "none".into(),
        ..NetworkSettings::default()
    };
    // Fingerprint still records kind=none (prepare_mail_network maps this to
    // direct routing); the important policy is prepare_mail_network never
    // loads AppProxyConfig.
    assert!(network_fingerprint(Some(&none_kind)).starts_with("none|"));
}

/// Regression: OAuth refresh used to call `reqwest::blocking` on the async
/// command worker. In debug builds that panics when dropping a nested
/// Runtime. Isolation must succeed while a Tokio runtime is current.
#[tokio::test]
async fn run_outside_tokio_context_avoids_nested_runtime_panic() {
    let value = run_outside_tokio_context(|| {
        // Mimic reqwest::blocking's debug enter probe: build+drop a shell
        // runtime on the worker thread. Must not see an outer enter().
        let _shell = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("shell runtime");
        42
    })
    .expect("isolated worker");
    assert_eq!(value, 42);
}

#[test]
fn mail_imap_fingerprint_changes_when_session_proxy_changes() {
    let mut account = sample_resolved_account();
    let direct = mail_imap_fingerprint(&account);
    account.network_settings = Some(NetworkSettings {
        proxy_kind: "socks5".into(),
        proxy_host: "127.0.0.1".into(),
        proxy_port: 1080,
        ..NetworkSettings::default()
    });
    let proxied = mail_imap_fingerprint(&account);
    assert_ne!(direct, proxied);
    // Unrelated display fields are not part of the connection fingerprint.
    account.config.display_name = Some("Other".into());
    assert_eq!(proxied, mail_imap_fingerprint(&account));
}

#[test]
fn mail_imap_fingerprint_changes_when_credentials_change() {
    let mut account = sample_resolved_account();
    let before = mail_imap_fingerprint(&account);
    account.imap_password = "rotated-token".into();
    assert_ne!(before, mail_imap_fingerprint(&account));
}

#[test]
fn is_imap_transport_error_detects_reconnectable_failures() {
    assert!(is_imap_transport_error("connection reset by peer"));
    assert!(is_imap_transport_error("IMAP NOOP failed: timed out"));
    assert!(is_imap_transport_error("IMAP protocol desync"));
    assert!(!is_imap_transport_error(
        "IMAP login failed: authenticationfailed"
    ));
}

#[test]
fn imap_catch_result_converts_panic_to_transport_error() {
    let err = imap_catch_result(|| -> Result<(), String> {
        panic!("assertion left == right failed");
    })
    .expect_err("panic becomes Err");
    assert!(is_imap_transport_error(&err));
}

#[test]
fn oauth_token_expired_refreshes_before_expiry() {
    let now = now_ts();
    assert!(oauth_token_expired(Some(now - 1)));
    assert!(oauth_token_expired(Some(
        now + OAUTH_REFRESH_SKEW_SECS.saturating_sub(1)
    )));
    assert!(!oauth_token_expired(Some(
        now + OAUTH_REFRESH_SKEW_SECS + 60
    )));
    assert!(!oauth_token_expired(None));
}

#[test]
fn oauth_refresh_scope_prefers_saved_scope_then_provider_default() {
    let bundle = MailOAuthTokenBundle {
        access_token: "access".into(),
        refresh_token: Some("refresh".into()),
        expires_at: None,
        token_type: None,
        scope: Some(" saved.scope ".into()),
    };
    let settings = MailOAuthSettings {
        scope: Some("settings.scope".into()),
        ..MailOAuthSettings::default()
    };
    assert_eq!(
        oauth_refresh_scope(MailProvider::Outlook, &bundle, &settings).as_deref(),
        Some("saved.scope")
    );

    let bundle_without_scope = MailOAuthTokenBundle {
        scope: None,
        ..bundle
    };
    assert_eq!(
        oauth_refresh_scope(MailProvider::Outlook, &bundle_without_scope, &settings).as_deref(),
        Some("settings.scope")
    );

    let settings_without_scope = MailOAuthSettings::default();
    assert_eq!(
        oauth_refresh_scope(
            MailProvider::Outlook,
            &bundle_without_scope,
            &settings_without_scope,
        )
        .as_deref(),
        Some(
            "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"
        )
    );
}

#[test]
fn oauth_refresh_invalid_grant_prompts_reauthorization() {
    let message = oauth_refresh_error_message(
        "OAuth token refresh failed: invalid_grant refresh token expired",
    );
    assert!(message.starts_with(OAUTH_REAUTHORIZE_REQUIRED));
    assert!(message.contains("invalid_grant"));
}

#[test]
fn oauth_loopback_redirect_uri_is_provider_specific() {
    assert_eq!(
        oauth_loopback_redirect_uri(MailProvider::Gmail, 49152).as_deref(),
        Ok("http://127.0.0.1:49152")
    );
    assert_eq!(
        oauth_loopback_redirect_uri(MailProvider::Outlook, 49152).as_deref(),
        Ok("http://localhost:49152")
    );
}

#[test]
fn oauth_device_code_response_accepts_google_verification_url() {
    let device = serde_json::from_str::<OAuthDeviceCodeResponse>(
        r#"{
                "device_code": "device",
                "user_code": "ABCD-EFGH",
                "verification_url": "https://www.google.com/device",
                "expires_in": 900,
                "interval": 5
            }"#,
    )
    .expect("parse Google device code response");

    assert_eq!(device.verification_uri, "https://www.google.com/device");
}

fn sample_resolved_account() -> ResolvedMailAccount {
    ResolvedMailAccount {
        config: MailAccountConfig {
            session_id: "acct".into(),
            email_address: "sender@example.com".into(),
            provider: MailProvider::Custom,
            auth_mode: MailAuthMode::Password,
            display_name: Some("Sender".into()),
            reply_to: None,
            signature: None,
            imap: MailServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                username: Some("sender@example.com".into()),
                password: Some("secret".into()),
                security: MailConnectionSecurity::Tls,
                trusted_cert: None,
            },
            smtp: MailSmtpConfig {
                host: "smtp.example.com".into(),
                port: 465,
                username: Some("sender@example.com".into()),
                password: Some("secret".into()),
                security: MailConnectionSecurity::Tls,
                use_imap_auth: true,
                trusted_cert: None,
            },
            oauth: MailOAuthSettings::default(),
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
        auth_mode: MailAuthMode::Password,
        network_settings: None,
        imap_username: "sender@example.com".into(),
        imap_password: "secret".into(),
        smtp_username: "sender@example.com".into(),
        smtp_password: "secret".into(),
    }
}

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

#[test]
fn decode_imap_modified_utf7_mailbox_names() {
    assert_eq!(decode_imap_modified_utf7("INBOX"), "INBOX");
    assert_eq!(decode_imap_modified_utf7("A &- B"), "A & B");
    assert_eq!(
        decode_imap_modified_utf7("~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
        "~peter/mail/台北/日本語"
    );
}

#[test]
fn imap_login_retry_classifies_transient_and_auth_errors() {
    assert!(should_retry_imap_login("No Response: LOGIN Login error"));
    assert!(should_retry_imap_login(
        "temporary rate limit, try again later"
    ));
    assert!(!should_retry_imap_login(
        "NO [AUTHENTICATIONFAILED] Invalid credentials"
    ));
    assert!(!should_retry_imap_login(
        "NO invalid login or password incorrect"
    ));
}

#[test]
fn parse_body_decodes_headers_and_preview() {
    let parsed = parse_body_message("acct", "INBOX", 7, Some(512), &sample_message(), 4096);
    assert_eq!(parsed.header.subject, "测试邮件");
    assert_eq!(
        parsed.header.message_id.as_deref(),
        Some("sample@example.com")
    );
    assert_eq!(
        parsed
            .header
            .from
            .as_ref()
            .and_then(|a| a.address.as_deref()),
        Some("sender@example.com")
    );
    assert_eq!(
        parsed.header.snippet.as_deref(),
        Some("Hello from Taomni Mail.")
    );
    assert!(parsed.body_text.as_deref().unwrap().contains("Taomni Mail"));
}

#[test]
fn parse_and_extract_attachment() {
    let raw = sample_attachment_message();
    let parsed = parse_body_message("acct", "INBOX", 8, Some(raw.len() as u32), &raw, 4096);
    assert!(parsed.header.has_attachments);
    assert_eq!(parsed.header.attachment_count, 1);
    assert_eq!(
        parsed.header.attachments[0].name.as_deref(),
        Some("report.txt")
    );

    let attachment = extract_attachment(&raw, 0).unwrap();
    assert_eq!(attachment.name.as_deref(), Some("report.txt"));
    assert_eq!(attachment.content_type.as_deref(), Some("text/plain"));
    assert_eq!(attachment.bytes, b"Attachment content.");
}

#[test]
fn parse_body_rewrites_cid_images_to_data_urls() {
    let raw = sample_inline_image_message();
    let parsed = parse_body_message("acct", "INBOX", 9, Some(raw.len() as u32), &raw, 4096);
    let html = parsed.body_html.as_deref().expect("html body");
    assert!(
        html.contains("data:image/png;base64,"),
        "expected embedded data URL, got: {html}"
    );
    assert!(
        !html.to_ascii_lowercase().contains("cid:logo@inline.local"),
        "cid reference should be rewritten for display"
    );
    assert!(html.contains("alt=\"logo\""));
}

#[test]
fn saved_mime_attachment_sections_handle_nested_parts_and_embedded_messages() {
    let raw = b"Content-Type: multipart/mixed; boundary=a\r\n\r\n--a\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nplain\r\n--b\r\nContent-Type: text/html\r\n\r\n<b>html</b>\r\n--b--\r\n--a\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=payload.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--a\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename=inner.eml\r\n\r\nSubject: Inner\r\nContent-Type: text/plain\r\n\r\nembedded\r\n--a--\r\n";
    assert_eq!(
        extract_attachment_section(raw, "1.2").unwrap().bytes,
        b"<b>html</b>"
    );
    let binary = extract_attachment_section(raw, "2").unwrap();
    assert_eq!(binary.name.as_deref(), Some("payload.bin"));
    assert_eq!(binary.bytes, [0, 1, 2, 3]);
    assert!(
        extract_attachment_section(raw, "3")
            .unwrap()
            .bytes
            .starts_with(b"Subject: Inner")
    );
    assert_eq!(
        extract_attachment_section(raw, "3.1").unwrap().bytes,
        b"embedded"
    );
    for invalid in ["0", "4", "1", "1.1.1", "2.1", "1.MIME", ""] {
        assert!(
            extract_attachment_section(raw, invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn cache_roundtrips_folders_messages_and_body() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let mut message = parse_body_message("acct", "INBOX", 10, Some(512), &sample_message(), 4096);
    message.header.flags = vec!["\\Seen".into()];
    let folder = MailFolder {
        account_id: "acct".into(),
        name: "INBOX".into(),
        display_name: "INBOX".into(),
        delimiter: Some("/".into()),
        flags: vec![],
        uid_validity: Some(1),
        uid_next: Some(11),
        total: Some(1),
        unread: Some(0),
        updated_at: now_ts(),
        ..MailFolder::default()
    };
    cache_sync_result(
        &conn,
        "acct",
        &[folder],
        &[message],
        "INBOX",
        &MailCacheSettings {
            header_retention_days: 0,
            ..MailCacheSettings::default()
        },
    )
    .unwrap();

    let folders = list_cached_folders(&conn, "acct").unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].uid_next, Some(11));

    let messages = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].subject, "测试邮件");
    assert!(messages[0].body_cached);

    let body = get_cached_body(&conn, "acct", "INBOX", 10)
        .unwrap()
        .unwrap();
    assert_eq!(body.source, "cache");
    assert!(body.text.unwrap().contains("Taomni Mail"));
}

#[test]
fn contact_index_searches_cached_headers() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let message = parse_body_message("acct", "INBOX", 10, Some(512), &sample_message(), 4096);
    upsert_message(&conn, &message).unwrap();

    assert_eq!(reindex_cached_contacts(&conn, "acct").unwrap(), 2);
    let contacts = search_contacts(&conn, "acct", "sender", 8).unwrap();

    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0].email, "sender@example.com");
    assert_eq!(contacts[0].source, "history");
}

#[test]
fn smtp_size_rejections_get_a_hint() {
    assert!(
        smtp_send_error("permanent error (552): 5.3.4 Message size exceeds fixed limit")
            .contains("SIZE limit")
    );
    assert_eq!(
        smtp_send_error("permanent error (550): no such user"),
        "SMTP send failed: permanent error (550): no such user"
    );
}

#[test]
fn sent_contacts_raise_sent_source() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let request = MailSendRequest {
        in_reply_to: None,
        references: Vec::new(),
        draft_id: None,
        from: None,
        reply_to: None,
        to: vec!["Receiver <receiver@example.com>".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hello".into(),
        text_body: Some("Body".into()),
        html_body: None,
        attachments: vec![],
        request_read_receipt: false,
    };

    assert_eq!(upsert_sent_contacts(&conn, "acct", &request).unwrap(), 1);
    let contacts = search_contacts(&conn, "acct", "receiver", 8).unwrap();

    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0].name.as_deref(), Some("Receiver"));
    assert_eq!(contacts[0].source, "sent");
}

#[test]
fn build_send_message_threads_replies_and_keeps_bcc_for_copies() {
    let request = MailSendRequest {
        to: vec!["Receiver <receiver@example.com>".into()],
        cc: vec![],
        bcc: vec!["hidden@example.com".into()],
        subject: "Re: Plan".into(),
        text_body: Some("Reply".into()),
        html_body: None,
        attachments: vec![],
        in_reply_to: Some("parent@example.com".into()),
        references: vec!["<root@example.com>".into(), "parent@example.com".into()],
        draft_id: None,
        from: None,
        reply_to: None,
        request_read_receipt: false,
    };
    let account = sample_resolved_account();
    let raw =
        String::from_utf8(build_send_message(&account, &request).unwrap().formatted()).unwrap();
    assert!(raw.contains("In-Reply-To: <parent@example.com>"), "{raw}");
    assert!(
        raw.contains("References: <root@example.com> <parent@example.com>"),
        "{raw}"
    );
    assert!(
        !raw.contains("hidden@example.com"),
        "SMTP message omits Bcc"
    );
    assert!(!raw.contains("Disposition-Notification-To"), "{raw}");
    let receipt = MailSendRequest {
        request_read_receipt: true,
        ..request.clone()
    };
    let raw =
        String::from_utf8(build_send_message(&account, &receipt).unwrap().formatted()).unwrap();
    assert!(
        raw.contains("Disposition-Notification-To: <sender@example.com>"),
        "{raw}"
    );

    let copy = build_send_message_with(
        &account,
        &request,
        &MessageBuildOptions {
            message_id: Some("<fixed@example.com>".into()),
            keep_bcc: true,
            self_envelope: false,
        },
    )
    .unwrap();
    let raw = String::from_utf8(copy.formatted()).unwrap();
    assert!(raw.contains("hidden@example.com"), "Sent copy keeps Bcc");
    assert!(raw.contains("Message-ID: <fixed@example.com>"), "{raw}");
}

#[test]
fn identity_overrides_from_and_reply_to() {
    let request = MailSendRequest {
        to: vec!["receiver@example.com".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hi".into(),
        text_body: Some("Body".into()),
        html_body: None,
        attachments: vec![],
        in_reply_to: None,
        references: vec![],
        draft_id: None,
        from: Some("Support <support@example.com>".into()),
        reply_to: Some("help@example.com".into()),
        request_read_receipt: false,
    };
    let message = build_send_message(&sample_resolved_account(), &request).unwrap();
    let raw = String::from_utf8(message.formatted()).unwrap();
    assert!(raw.contains("From: Support <support@example.com>"), "{raw}");
    assert!(raw.contains("Reply-To: help@example.com"), "{raw}");
    assert_eq!(
        message.envelope().from().unwrap().to_string(),
        "support@example.com"
    );
}

#[test]
fn draft_envelope_allows_messages_without_recipients() {
    let request = MailSendRequest {
        to: vec![],
        cc: vec![],
        bcc: vec![],
        subject: String::new(),
        text_body: Some("half written".into()),
        html_body: None,
        attachments: vec![],
        in_reply_to: None,
        references: vec![],
        draft_id: None,
        from: None,
        reply_to: None,
        request_read_receipt: false,
    };
    let options = MessageBuildOptions {
        self_envelope: true,
        ..MessageBuildOptions::default()
    };
    let raw = build_send_message_with(&sample_resolved_account(), &request, &options)
        .unwrap()
        .formatted();
    assert!(String::from_utf8(raw).unwrap().contains("half written"));
}

#[test]
fn parses_thread_headers_from_fetched_headers() {
    let raw = b"Subject: Re: x
Message-ID: <c@x>
In-Reply-To: <b@x>
References: <a@x>
 <b@x>

";
    let parsed = MessageParser::default().parse(&raw[..]).unwrap();
    assert_eq!(
        header_message_ids(parsed.in_reply_to()),
        vec!["b@x".to_string()]
    );
    assert_eq!(
        header_message_ids(parsed.references()),
        vec!["a@x".to_string(), "b@x".to_string()]
    );
}

#[test]
fn build_send_message_wraps_attachments_in_mixed_mime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("report.txt");
    std::fs::write(&path, b"attachment body").unwrap();
    let request = MailSendRequest {
        to: vec!["Receiver <receiver@example.com>".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hello".into(),
        text_body: Some("Plain body".into()),
        html_body: Some("<p><strong>HTML body</strong></p>".into()),
        in_reply_to: None,
        references: Vec::new(),
        draft_id: None,
        from: None,
        reply_to: None,
        attachments: vec![MailSendAttachment {
            path: path.to_string_lossy().into_owned(),
            name: Some("report.txt".into()),
            content_type: Some("text/plain".into()),
            inline: false,
            content_id: None,
        }],
        request_read_receipt: false,
    };

    let message = build_send_message(&sample_resolved_account(), &request).unwrap();
    let raw = String::from_utf8(message.formatted()).unwrap();

    assert!(raw.contains("multipart/mixed"));
    assert!(raw.contains("multipart/alternative"));
    assert!(raw.contains("filename=\"report.txt\""));
}

#[test]
fn build_send_message_embeds_inline_images_in_related_mime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("logo.png");
    std::fs::write(&path, b"png body").unwrap();
    let request = MailSendRequest {
        in_reply_to: None,
        references: Vec::new(),
        draft_id: None,
        from: None,
        reply_to: None,
        to: vec!["Receiver <receiver@example.com>".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hello".into(),
        text_body: Some("Plain body".into()),
        html_body: Some("<p><img src=\"cid:logo-1@inline.local\"></p>".into()),
        attachments: vec![MailSendAttachment {
            path: path.to_string_lossy().into_owned(),
            name: Some("logo.png".into()),
            content_type: Some("image/png".into()),
            inline: true,
            content_id: Some("logo-1@inline.local".into()),
        }],
        request_read_receipt: false,
    };

    let message = build_send_message(&sample_resolved_account(), &request).unwrap();
    let raw = String::from_utf8(message.formatted()).unwrap();

    assert!(raw.contains("multipart/related"));
    assert!(raw.contains("multipart/alternative"));
    assert!(raw.contains("Content-ID: <logo-1@inline.local>"));
    assert!(raw.contains("Content-Disposition: inline; filename=\"logo.png\""));
}

#[test]
fn build_send_message_nests_related_body_inside_mixed() {
    let dir = tempfile::tempdir().unwrap();
    let image_path = dir.path().join("logo.png");
    let report_path = dir.path().join("report.txt");
    std::fs::write(&image_path, b"png body").unwrap();
    std::fs::write(&report_path, b"report body").unwrap();
    let request = MailSendRequest {
        in_reply_to: None,
        references: Vec::new(),
        draft_id: None,
        from: None,
        reply_to: None,
        to: vec!["Receiver <receiver@example.com>".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Hello".into(),
        text_body: Some("Plain body".into()),
        html_body: Some("<p><img src=\"cid:logo-1@inline.local\"></p>".into()),
        attachments: vec![
            MailSendAttachment {
                path: image_path.to_string_lossy().into_owned(),
                name: Some("logo.png".into()),
                content_type: Some("image/png".into()),
                inline: true,
                content_id: Some("logo-1@inline.local".into()),
            },
            MailSendAttachment {
                path: report_path.to_string_lossy().into_owned(),
                name: Some("report.txt".into()),
                content_type: Some("text/plain".into()),
                inline: false,
                content_id: None,
            },
        ],
        request_read_receipt: false,
    };

    let message = build_send_message(&sample_resolved_account(), &request).unwrap();
    let raw = String::from_utf8(message.formatted()).unwrap();

    assert!(raw.contains("multipart/mixed"));
    assert!(raw.contains("multipart/related"));
    assert!(raw.contains("Content-ID: <logo-1@inline.local>"));
    assert!(raw.contains("filename=\"report.txt\""));
}

#[test]
fn local_drafts_roundtrip_and_delete() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let saved = save_mail_draft(
        &conn,
        "acct",
        MailDraftSaveRequest {
            id: None,
            to: vec!["Receiver <receiver@example.com>".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Draft subject".into(),
            text_body: "Plain".into(),
            html_body: "<p>Plain</p>".into(),
            attachments: vec![MailDraftAttachment {
                path: "/tmp/report.txt".into(),
                name: Some("report.txt".into()),
                content_type: Some("text/plain".into()),
                inline: false,
                content_id: None,
                size: Some(12),
                modified_at: Some(123),
            }],
            reply_context: Some(MailDraftContext {
                kind: Some("reply".into()),
                folder: Some("INBOX".into()),
                uid: Some(42),
                message_id: Some("msg@example.com".into()),
                subject: Some("Original".into()),
                references: Vec::new(),
                identity_id: None,
                outbox: None,
            }),
            remote_draft_folder: None,
            remote_draft_uid: None,
        },
    )
    .unwrap();

    let drafts = list_mail_drafts(&conn, "acct").unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].id, saved.id);
    assert_eq!(drafts[0].attachments[0].name.as_deref(), Some("report.txt"));
    assert_eq!(
        drafts[0].reply_context.as_ref().and_then(|ctx| ctx.uid),
        Some(42)
    );

    delete_mail_draft(&conn, "acct", &saved.id).unwrap();
    assert!(list_mail_drafts(&conn, "acct").unwrap().is_empty());
}

#[test]
fn update_and_remove_cache_helpers_mutate_rows() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    let mut first = parse_body_message("acct", "INBOX", 1, Some(10), &sample_message(), 4096);
    first.header.flags = vec!["\\Seen".into()];
    let mut second = parse_body_message("acct", "INBOX", 2, Some(10), &sample_message(), 4096);
    second.header.flags = vec!["\\Seen".into()];
    upsert_message(&conn, &first).unwrap();
    upsert_message(&conn, &second).unwrap();

    update_cached_flags(
        &conn,
        "acct",
        "INBOX",
        &[1],
        &["\\Flagged".into()],
        &["\\Seen".into()],
    )
    .unwrap();
    let messages = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
    let one = messages.iter().find(|m| m.uid == 1).unwrap();
    assert!(
        one.flags
            .iter()
            .any(|f| f.eq_ignore_ascii_case("\\Flagged"))
    );
    assert!(!one.flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")));
    let two = messages.iter().find(|m| m.uid == 2).unwrap();
    assert!(two.flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")));

    remove_cached_messages(&conn, "acct", "INBOX", &[1]).unwrap();
    let after = list_cached_messages(&conn, "acct", "INBOX", 20, 0).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].uid, 2);
}

#[test]
fn purge_cached_folder_removes_folder_and_subfolders_only() {
    let conn = Connection::open_in_memory().unwrap();
    init_mail_tables(&conn).unwrap();
    for name in ["Parent", "Parent/Child", "ParentX"] {
        upsert_message(
            &conn,
            &parse_body_message("acct", name, 1, Some(10), &sample_message(), 4096),
        )
        .unwrap();
        upsert_folder(
            &conn,
            &MailFolder {
                account_id: "acct".into(),
                name: name.into(),
                display_name: name.into(),
                delimiter: Some("/".into()),
                flags: vec![],
                uid_validity: None,
                uid_next: None,
                total: None,
                unread: None,
                updated_at: now_ts(),
                ..MailFolder::default()
            },
        )
        .unwrap();
    }

    purge_cached_folder(&conn, "acct", "Parent").unwrap();

    let names = list_cached_folders(&conn, "acct")
        .unwrap()
        .into_iter()
        .map(|f| f.name)
        .collect::<Vec<_>>();
    assert!(names.contains(&"ParentX".to_string()));
    assert!(!names.contains(&"Parent".to_string()));
    assert!(!names.contains(&"Parent/Child".to_string()));
    assert_eq!(
        list_cached_messages(&conn, "acct", "Parent", 20, 0)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        list_cached_messages(&conn, "acct", "Parent/Child", 20, 0)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        list_cached_messages(&conn, "acct", "ParentX", 20, 0)
            .unwrap()
            .len(),
        1
    );
}
