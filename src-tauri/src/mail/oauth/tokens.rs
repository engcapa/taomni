use super::endpoints::oauth_scope;
use super::exchange::refresh_oauth_token_blocking;
use super::exchange::run_outside_tokio_context;
use crate::mail::account_config::resolve_secret;
use crate::mail::account_model::MailAccountConfig;
use crate::mail::connection_model::MailProvider;
use crate::mail::limits::OAUTH_REAUTHORIZE_REQUIRED;
use crate::mail::limits::OAUTH_REFRESH_SKEW_SECS;
use crate::mail::oauth_model::MailOAuthAuthorizeResult;
use crate::mail::oauth_model::MailOAuthSettings;
use crate::mail::oauth_model::MailOAuthTokenBundle;
use crate::mail::oauth_model::OAuthTokenResponse;
use crate::mail::utilities::non_empty;
use crate::mail::utilities::non_empty_str;
use crate::mail::utilities::now_ts;
use crate::state::AppState;
use crate::terminal::network::NetworkSettings;
use sha2::Digest;
use tauri::State;

pub(in crate::mail) fn resolve_oauth_access_token(
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

pub(in crate::mail) fn persist_new_oauth_token(
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

pub(in crate::mail) fn read_oauth_token_bundle(
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

pub(in crate::mail) fn persist_oauth_token_bundle(
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

pub(in crate::mail) fn oauth_refresh_scope(
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

pub(in crate::mail) fn oauth_reauthorize_required_message() -> String {
    OAUTH_REAUTHORIZE_REQUIRED.to_string()
}

pub(in crate::mail) fn oauth_refresh_error_message(error: &str) -> String {
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

pub(in crate::mail) fn oauth_token_expired(expires_at: Option<i64>) -> bool {
    match expires_at {
        Some(ts) => ts <= now_ts() + OAUTH_REFRESH_SKEW_SECS,
        None => false,
    }
}
