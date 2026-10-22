use super::*;
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
