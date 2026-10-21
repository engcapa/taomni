use super::*;

#[tauri::command]
pub async fn mail_oauth_authorize(
    request: MailOAuthAuthorizeRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MailOAuthAuthorizeResult, String> {
    let client_id = request.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("OAuth2 client ID is required".into());
    }
    if request.provider == MailProvider::Custom {
        return Err("OAuth2 mail auth requires Gmail or Outlook provider".into());
    }

    let bind_host = oauth_loopback_bind_host(request.provider)?;
    let listener = std::net::TcpListener::bind((bind_host, 0))
        .map_err(|e| format!("OAuth callback listener failed: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("OAuth callback timeout setup failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("OAuth callback address failed: {e}"))?
        .port();
    let redirect_uri = oauth_loopback_redirect_uri(request.provider, port)?;
    let state_token = random_urlsafe_token(32);
    let verifier = random_urlsafe_token(48);
    let challenge = pkce_challenge(&verifier);
    let auth_url = build_oauth_authorize_url(
        request.provider,
        &client_id,
        &redirect_uri,
        &state_token,
        &challenge,
    )?;

    #[allow(deprecated)]
    app.shell()
        .open(auth_url, None)
        .map_err(|e| format!("failed to open OAuth authorization URL: {e}"))?;

    let callback_state = state_token.clone();
    let callback =
        tokio::task::spawn_blocking(move || wait_for_oauth_callback(listener, &callback_state))
            .await
            .map_err(|e| format!("OAuth callback task failed: {e}"))??;

    let provider = request.provider;
    let client_secret =
        resolve_secret(&state, request.client_secret.as_deref())?.and_then(non_empty);
    let network_settings = prepare_mail_network(&state, request.network_settings.clone())?;
    let token = tokio::task::spawn_blocking(move || {
        exchange_oauth_code_blocking(
            provider,
            &client_id,
            client_secret.as_deref(),
            &redirect_uri,
            &callback.code,
            &verifier,
            network_settings.as_ref(),
        )
    })
    .await
    .map_err(|e| format!("OAuth token exchange task failed: {e}"))??;

    persist_new_oauth_token(
        &state,
        provider,
        &request.email_address,
        &request.session_id,
        token,
    )
}

#[tauri::command]
pub async fn mail_oauth_device_start(
    request: MailOAuthDeviceStartRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MailOAuthDeviceStartResult, String> {
    let client_id = request.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("OAuth2 client ID is required".into());
    }
    if request.provider == MailProvider::Custom {
        return Err("Device code authorization requires Gmail or Outlook provider".into());
    }
    let network_settings = prepare_mail_network(&state, request.network_settings.clone())?;
    let provider = request.provider;
    let device = tokio::task::spawn_blocking(move || {
        start_oauth_device_code_blocking(provider, &client_id, network_settings.as_ref())
    })
    .await
    .map_err(|e| format!("OAuth device code task failed: {e}"))??;

    #[allow(deprecated)]
    app.shell()
        .open(device.verification_uri.clone(), None)
        .map_err(|e| format!("failed to open OAuth device login URL: {e}"))?;

    Ok(MailOAuthDeviceStartResult {
        device_code: device.device_code,
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        message: device.message.unwrap_or_else(|| {
            "Open the verification URL and enter the device code to authorize this mail account."
                .into()
        }),
        expires_in: device.expires_in.unwrap_or(900),
        interval: device.interval.unwrap_or(5).max(1),
    })
}

#[tauri::command]
pub async fn mail_oauth_device_complete(
    request: MailOAuthDeviceCompleteRequest,
    state: State<'_, AppState>,
) -> Result<MailOAuthAuthorizeResult, String> {
    let client_id = request.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("OAuth2 client ID is required".into());
    }
    if request.provider == MailProvider::Custom {
        return Err("Device code authorization requires Gmail or Outlook provider".into());
    }
    let device_code = request.device_code.trim().to_string();
    if device_code.is_empty() {
        return Err("OAuth2 device code is required".into());
    }
    let client_secret =
        resolve_secret(&state, request.client_secret.as_deref())?.and_then(non_empty);
    let network_settings = prepare_mail_network(&state, request.network_settings.clone())?;
    let provider = request.provider;
    let interval = request.interval.unwrap_or(5).max(1);
    let expires_in = request.expires_in.unwrap_or(900).max(1);
    let token = tokio::task::spawn_blocking(move || {
        complete_oauth_device_code_blocking(
            provider,
            &client_id,
            client_secret.as_deref(),
            &device_code,
            interval,
            expires_in,
            network_settings.as_ref(),
        )
    })
    .await
    .map_err(|e| format!("OAuth device polling task failed: {e}"))??;

    persist_new_oauth_token(
        &state,
        provider,
        &request.email_address,
        &request.session_id,
        token,
    )
}

pub(super) fn resolve_oauth_access_token(
    state: &State<'_, AppState>,
    config: &MailAccountConfig,
    network: Option<&NetworkSettings>,
) -> Result<String, String> {
    if config.provider == MailProvider::Custom {
        return Err("OAuth2 mail auth requires Gmail or Outlook provider".into());
    }

    let token_ref = config
        .oauth
        .token_ref
        .as_deref()
        .and_then(non_empty_str)
        .ok_or_else(|| "OAuth2 token is required. Reconnect this mail account.".to_string())?;
    let mut bundle = read_oauth_token_bundle(state, token_ref, config)?;
    if !oauth_token_expired(bundle.expires_at) {
        return Ok(bundle.access_token);
    }

    let refresh_token = match bundle.refresh_token.clone().and_then(non_empty) {
        Some(value) => value,
        None => match config
            .oauth
            .refresh_token_ref
            .as_deref()
            .and_then(non_empty_str)
        {
            Some(value) => resolve_secret(state, Some(value))?
                .and_then(non_empty)
                .ok_or_else(oauth_reauthorize_required_message)?,
            None => {
                return Err(oauth_reauthorize_required_message());
            }
        },
    };
    let client_id = config
        .oauth
        .client_id
        .as_deref()
        .and_then(non_empty_str)
        .ok_or_else(|| "OAuth2 client ID is required to refresh this mail account".to_string())?
        .to_string();
    let client_secret = resolve_secret(state, config.oauth.client_secret.as_deref())?;
    let refresh_scope = oauth_refresh_scope(config.provider, &bundle, &config.oauth);
    // resolve_config runs on the async command worker. reqwest::blocking builds a
    // nested Runtime and panics in debug if the calling thread has already entered
    // Tokio ("Cannot drop a runtime..."). Always refresh on a plain OS thread.
    let provider = config.provider;
    let network = network.cloned();
    let refreshed = run_outside_tokio_context({
        let refresh_token = refresh_token.clone();
        let refresh_scope = refresh_scope.clone();
        move || {
            refresh_oauth_token_blocking(
                provider,
                &client_id,
                client_secret.as_deref(),
                &refresh_token,
                refresh_scope.as_deref(),
                network.as_ref(),
            )
        }
    })?
    .map_err(|e| oauth_refresh_error_message(&e))?;
    bundle.access_token = refreshed.access_token;
    if let Some(refresh_token) = refreshed.refresh_token.and_then(non_empty) {
        bundle.refresh_token = Some(refresh_token);
    }
    bundle.expires_at = refreshed
        .expires_in
        .map(|seconds| now_ts() + seconds.max(0));
    bundle.token_type = refreshed.token_type.and_then(non_empty);
    bundle.scope = refreshed.scope.and_then(non_empty).or(refresh_scope);
    persist_oauth_token_bundle(state, token_ref, &bundle)?;
    tracing::info!(
        provider = ?config.provider,
        session_id = %config.session_id,
        "refreshed mail OAuth2 access token"
    );
    Ok(bundle.access_token)
}

pub(super) fn persist_new_oauth_token(
    state: &State<'_, AppState>,
    provider: MailProvider,
    email_address: &str,
    session_id: &str,
    token: OAuthTokenResponse,
) -> Result<MailOAuthAuthorizeResult, String> {
    if let Some(error) = token.error.as_deref() {
        let detail = token.error_description.as_deref().unwrap_or("");
        return Err(format!("OAuth token exchange failed: {error} {detail}"));
    }
    if token.access_token.trim().is_empty() {
        return Err("OAuth token response did not include an access token".into());
    }
    let refresh_token = token
        .refresh_token
        .clone()
        .and_then(non_empty)
        .ok_or_else(|| {
            "OAuth token response did not include a refresh token. Ensure offline access is allowed and reconnect.".to_string()
        })?;
    let expires_at = token.expires_in.map(|seconds| now_ts() + seconds.max(0));
    let scope = token
        .scope
        .clone()
        .and_then(non_empty)
        .or_else(|| oauth_scope(provider).ok().map(str::to_string));
    let token_type = token.token_type.clone().and_then(non_empty);
    let bundle = MailOAuthTokenBundle {
        access_token: token.access_token,
        refresh_token: Some(refresh_token),
        expires_at,
        token_type: token_type.clone(),
        scope: scope.clone(),
    };
    let json = serde_json::to_string(&bundle).map_err(|e| e.to_string())?;
    let label_owner =
        non_empty(email_address.to_string()).unwrap_or_else(|| session_id.to_string());
    let saved = state.vault.put(
        "mail-oauth-token",
        &format!("{label_owner} OAuth2 token"),
        &json,
    )?;
    Ok(MailOAuthAuthorizeResult {
        token_ref: saved.reference,
        expires_at,
        scope,
        token_type,
    })
}

pub(super) fn read_oauth_token_bundle(
    state: &State<'_, AppState>,
    token_ref: &str,
    config: &MailAccountConfig,
) -> Result<MailOAuthTokenBundle, String> {
    let raw = resolve_secret(state, Some(token_ref))?
        .ok_or_else(|| "OAuth2 token is required. Reconnect this mail account.".to_string())?;
    if let Ok(bundle) = serde_json::from_str::<MailOAuthTokenBundle>(&raw) {
        if !bundle.access_token.trim().is_empty() {
            return Ok(bundle);
        }
    }

    // Backwards-compatible fallback: treat a non-JSON token entry as an access
    // token and use the separate refresh ref / expiresAt fields if present.
    let refresh_token = match config
        .oauth
        .refresh_token_ref
        .as_deref()
        .and_then(non_empty_str)
    {
        Some(value) => resolve_secret(state, Some(value))?.and_then(non_empty),
        None => None,
    };
    Ok(MailOAuthTokenBundle {
        access_token: raw,
        refresh_token,
        expires_at: config.oauth.expires_at,
        token_type: Some("Bearer".into()),
        scope: config.oauth.scope.clone(),
    })
}

pub(super) fn persist_oauth_token_bundle(
    state: &State<'_, AppState>,
    token_ref: &str,
    bundle: &MailOAuthTokenBundle,
) -> Result<(), String> {
    let id = token_ref
        .strip_prefix(crate::vault::VAULT_REF_PREFIX)
        .ok_or_else(|| "OAuth2 token must be stored in the credential vault".to_string())?;
    let json = serde_json::to_string(bundle).map_err(|e| e.to_string())?;
    state.vault.update(id, &json)
}

pub(super) fn oauth_refresh_scope(
    provider: MailProvider,
    bundle: &MailOAuthTokenBundle,
    settings: &MailOAuthSettings,
) -> Option<String> {
    bundle
        .scope
        .clone()
        .and_then(non_empty)
        .or_else(|| settings.scope.clone().and_then(non_empty))
        .or_else(|| oauth_scope(provider).ok().map(str::to_string))
}

pub(super) fn oauth_reauthorize_required_message() -> String {
    OAUTH_REAUTHORIZE_REQUIRED.to_string()
}

pub(super) fn oauth_refresh_error_message(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("invalid_grant")
        || lower.contains("interaction_required")
        || lower.contains("consent_required")
        || lower.contains("unauthorized_client")
        || lower.contains("aadsts70008")
        || lower.contains("aadsts700082")
    {
        format!("{OAUTH_REAUTHORIZE_REQUIRED} Detail: {error}")
    } else {
        format!(
            "OAuth2 access token expired and refresh failed: {error}. Reauthorize this mail account if the refresh token has expired."
        )
    }
}

pub(super) fn oauth_token_expired(expires_at: Option<i64>) -> bool {
    match expires_at {
        Some(ts) => ts <= now_ts() + OAUTH_REFRESH_SKEW_SECS,
        None => false,
    }
}

/// Run `f` on a thread that has **not** entered a Tokio runtime.
///
/// `reqwest::blocking` creates a temporary Runtime in debug builds to detect
/// nested use; dropping that Runtime while the current thread is already inside
/// Tokio panics with "Cannot drop a runtime in a context where blocking is not
/// allowed". OAuth refresh is often invoked from async Tauri commands, so isolate
/// the blocking HTTP client onto a plain OS thread when needed.
pub(super) fn run_outside_tokio_context<R: Send + 'static>(
    f: impl FnOnce() -> R + Send + 'static,
) -> Result<R, String> {
    if tokio::runtime::Handle::try_current().is_err() {
        return Ok(f());
    }
    std::thread::Builder::new()
        .name("mail-oauth-http".into())
        .spawn(f)
        .map_err(|e| format!("failed to spawn mail HTTP worker: {e}"))?
        .join()
        .map_err(|_| "mail HTTP worker thread panicked".to_string())
}

pub(super) fn refresh_oauth_token_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
    scope: Option<&str>,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let mut params = vec![
        ("client_id", client_id.to_string()),
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
    ];
    if let Some(secret) = client_secret.and_then(non_empty_str) {
        params.push(("client_secret", secret.to_string()));
    }
    if let Some(scope) = scope.and_then(non_empty_str) {
        params.push(("scope", scope.to_string()));
    }

    let client = build_oauth_http_client_blocking(network)?;
    let response = client
        .post(token_url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth token refresh failed: {e}"))?;
    parse_oauth_token_response(response, "refresh")
}

pub(super) fn exchange_oauth_code_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let mut params = vec![
        ("client_id", client_id.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("code_verifier", verifier.to_string()),
    ];
    if let Some(secret) = client_secret.and_then(non_empty_str) {
        params.push(("client_secret", secret.to_string()));
    }

    let client = build_oauth_http_client_blocking(network)?;
    let response = client
        .post(token_url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth token exchange failed: {e}"))?;
    parse_oauth_token_response(response, "exchange")
}

pub(super) fn start_oauth_device_code_blocking(
    provider: MailProvider,
    client_id: &str,
    network: Option<&NetworkSettings>,
) -> Result<OAuthDeviceCodeResponse, String> {
    let device_url = oauth_device_code_url(provider)?;
    let params = vec![
        ("client_id", client_id.to_string()),
        ("scope", oauth_scope(provider)?.to_string()),
    ];

    let client = build_oauth_http_client_blocking(network)?;
    let response = client
        .post(device_url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth device code request failed: {e}"))?;
    parse_oauth_device_code_response(response)
}

pub(super) fn complete_oauth_device_code_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    device_code: &str,
    interval: i64,
    expires_in: i64,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let client_secret = client_secret.and_then(non_empty_str);
    if provider == MailProvider::Gmail && client_secret.is_none() {
        return Err(
            "Gmail device code authorization requires the OAuth client secret from a Google TV and Limited Input OAuth client"
                .into(),
        );
    }
    let client = build_oauth_http_client_blocking(network)?;
    let deadline = Instant::now() + Duration::from_secs(expires_in.clamp(1, 3600) as u64);
    let mut poll_interval = Duration::from_secs(interval.clamp(1, 30) as u64);

    loop {
        if Instant::now() >= deadline {
            return Err("OAuth device code expired before authorization completed".into());
        }

        let mut params = vec![
            ("client_id", client_id.to_string()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
            ("device_code", device_code.to_string()),
        ];
        if let Some(secret) = client_secret {
            params.push(("client_secret", secret.to_string()));
        }
        let response = client
            .post(token_url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(oauth_form_body(&params))
            .send()
            .map_err(|e| format!("OAuth device token polling failed: {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|e| format!("OAuth device token response read failed: {e}"))?;
        let token = serde_json::from_str::<OAuthTokenResponse>(&text).map_err(|e| {
            format!("OAuth device token response parse failed ({status}): {e}; {text}")
        })?;

        if status.is_success() && token.error.is_none() {
            if token.access_token.trim().is_empty() {
                return Err("OAuth device token response did not include an access token".into());
            }
            return Ok(token);
        }

        let error = token.error.as_deref().unwrap_or(if status.is_success() {
            "invalid_response"
        } else {
            "http_error"
        });
        let detail = token.error_description.as_deref().unwrap_or("");
        match error {
            "authorization_pending" => {
                std::thread::sleep(poll_interval);
            }
            "slow_down" => {
                poll_interval =
                    (poll_interval + Duration::from_secs(5)).min(Duration::from_secs(30));
                std::thread::sleep(poll_interval);
            }
            "authorization_declined" => {
                return Err("OAuth device authorization was declined".into());
            }
            "bad_verification_code" => {
                return Err("OAuth device authorization failed: bad verification code".into());
            }
            "expired_token" => {
                return Err("OAuth device code expired before authorization completed".into());
            }
            _ => {
                return Err(format!(
                    "OAuth device authorization failed ({status}): {error} {detail}"
                ));
            }
        }
    }
}

pub(super) fn build_oauth_http_client_blocking(
    network: Option<&NetworkSettings>,
) -> Result<reqwest::blocking::Client, String> {
    let mut builder =
        reqwest::blocking::Client::builder().timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS));
    if let Some(net) = network {
        match net.proxy_kind.as_str() {
            "" | "none" => {}
            "http" => {
                let url = format!("http://{}:{}", net.proxy_host, net.proxy_port);
                let mut proxy = reqwest::Proxy::all(&url)
                    .map_err(|e| format!("OAuth HTTP proxy config failed: {e}"))?;
                if !net.proxy_user.is_empty() {
                    proxy = proxy.basic_auth(&net.proxy_user, &net.proxy_pass);
                }
                builder = builder.proxy(proxy);
            }
            "socks5" => {
                let url = format!("socks5h://{}:{}", net.proxy_host, net.proxy_port);
                let mut proxy = reqwest::Proxy::all(&url)
                    .map_err(|e| format!("OAuth SOCKS5 proxy config failed: {e}"))?;
                if !net.proxy_user.is_empty() {
                    proxy = proxy.basic_auth(&net.proxy_user, &net.proxy_pass);
                }
                builder = builder.proxy(proxy);
            }
            "ssh-tunnel" => {
                return Err("OAuth2 token requests through SSH tunnel are not supported yet; use HTTP or SOCKS5 proxy for this Mail session.".into());
            }
            "system" => {
                return Err("System proxy is not supported for Mail OAuth yet; use HTTP or SOCKS5 proxy in this session's Network tab.".into());
            }
            other => return Err(format!("Unsupported Mail OAuth proxy type: {other}")),
        }
    }
    builder
        .build()
        .map_err(|e| format!("failed to build OAuth client: {e}"))
}

pub(super) fn parse_oauth_token_response(
    response: reqwest::blocking::Response,
    action: &str,
) -> Result<OAuthTokenResponse, String> {
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("OAuth token {action} response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("OAuth token {action} failed ({status}): {text}"));
    }
    let token = serde_json::from_str::<OAuthTokenResponse>(&text)
        .map_err(|e| format!("OAuth token {action} response parse failed: {e}"))?;
    if let Some(error) = token.error.as_deref() {
        let detail = token.error_description.as_deref().unwrap_or("");
        return Err(format!("OAuth token {action} failed: {error} {detail}"));
    }
    if token.access_token.trim().is_empty() {
        return Err(format!(
            "OAuth token {action} response did not include an access token"
        ));
    }
    Ok(token)
}

pub(super) fn parse_oauth_device_code_response(
    response: reqwest::blocking::Response,
) -> Result<OAuthDeviceCodeResponse, String> {
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("OAuth device code response read failed: {e}"))?;
    let device = serde_json::from_str::<OAuthDeviceCodeResponse>(&text)
        .map_err(|e| format!("OAuth device code response parse failed ({status}): {e}; {text}"))?;
    if !status.is_success() {
        let error = device.error.as_deref().unwrap_or("request_failed");
        let detail = device.error_description.as_deref().unwrap_or("");
        return Err(format!(
            "OAuth device code request failed ({status}): {error} {detail}"
        ));
    }
    if let Some(error) = device.error.as_deref() {
        let detail = device.error_description.as_deref().unwrap_or("");
        return Err(format!(
            "OAuth device code request failed: {error} {detail}"
        ));
    }
    if device.device_code.trim().is_empty()
        || device.user_code.trim().is_empty()
        || device.verification_uri.trim().is_empty()
    {
        return Err("OAuth device code response was missing required fields".into());
    }
    Ok(device)
}

pub(super) fn oauth_form_body(params: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

pub(super) fn oauth_loopback_bind_host(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("127.0.0.1"),
        MailProvider::Outlook => Ok("localhost"),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(super) fn oauth_loopback_redirect_uri(
    provider: MailProvider,
    port: u16,
) -> Result<String, String> {
    match provider {
        MailProvider::Gmail => Ok(format!("http://127.0.0.1:{port}")),
        MailProvider::Outlook => Ok(format!("http://localhost:{port}")),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(super) fn build_oauth_authorize_url(
    provider: MailProvider,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(oauth_authorize_url(provider)?)
        .map_err(|e| format!("OAuth authorize URL parse failed: {e}"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", oauth_scope(provider)?)
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
        if provider == MailProvider::Gmail {
            query
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
        }
    }
    Ok(url.to_string())
}

pub(super) fn wait_for_oauth_callback(
    listener: std::net::TcpListener,
    expected_state: &str,
) -> Result<OAuthCallback, String> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(value) => break value,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("OAuth callback timed out".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("OAuth callback failed: {e}")),
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf = [0u8; 8192];
    let n = stream
        .read(&mut buf)
        .map_err(|e| format!("OAuth callback read failed: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let line = request
        .lines()
        .next()
        .ok_or_else(|| "OAuth callback request was empty".to_string())?;
    let path = line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "OAuth callback request was malformed".to_string())?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}"))
        .map_err(|e| format!("OAuth callback URL parse failed: {e}"))?;
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut error_description = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => error_description = Some(value.into_owned()),
            _ => {}
        }
    }

    let result = if let Some(error) = error {
        let detail = error_description.unwrap_or_default();
        Err(format!("OAuth authorization failed: {error} {detail}"))
    } else if state.as_deref() != Some(expected_state) {
        Err("OAuth callback state did not match; authorization was rejected".into())
    } else {
        let code = code.ok_or_else(|| "OAuth callback did not include a code".to_string())?;
        Ok(OAuthCallback { code })
    };

    let body = if result.is_ok() {
        "Taomni Mail authorization complete. You can close this window."
    } else {
        "Taomni Mail authorization failed. You can close this window and retry."
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    result
}

pub(super) fn oauth_authorize_url(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://accounts.google.com/o/oauth2/v2/auth"),
        MailProvider::Outlook => {
            Ok("https://login.microsoftonline.com/common/oauth2/v2.0/authorize")
        }
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(super) fn oauth_token_url(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://oauth2.googleapis.com/token"),
        MailProvider::Outlook => Ok("https://login.microsoftonline.com/common/oauth2/v2.0/token"),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(super) fn oauth_device_code_url(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://oauth2.googleapis.com/device/code"),
        MailProvider::Outlook => {
            Ok("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode")
        }
        MailProvider::Custom => {
            Err("Device code authorization requires Gmail or Outlook provider".into())
        }
    }
}

pub(super) fn oauth_scope(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://mail.google.com/"),
        MailProvider::Outlook => Ok(
            "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
        ),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(super) fn random_urlsafe_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::fill(buf.as_mut_slice());
    URL_SAFE_NO_PAD.encode(buf)
}

pub(super) fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}
