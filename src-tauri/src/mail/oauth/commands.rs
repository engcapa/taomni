use super::callback::build_oauth_authorize_url;
use super::callback::oauth_loopback_bind_host;
use super::callback::oauth_loopback_redirect_uri;
use super::callback::wait_for_oauth_callback;
use super::endpoints::pkce_challenge;
use super::endpoints::random_urlsafe_token;
use super::exchange::complete_oauth_device_code_blocking;
use super::exchange::exchange_oauth_code_blocking;
use super::exchange::start_oauth_device_code_blocking;
use super::tokens::persist_new_oauth_token;
use crate::mail::account_config::prepare_mail_network;
use crate::mail::account_config::resolve_secret;
use crate::mail::connection_model::MailProvider;
use crate::mail::oauth_model::MailOAuthAuthorizeRequest;
use crate::mail::oauth_model::MailOAuthAuthorizeResult;
use crate::mail::oauth_model::MailOAuthDeviceCompleteRequest;
use crate::mail::oauth_model::MailOAuthDeviceStartRequest;
use crate::mail::oauth_model::MailOAuthDeviceStartResult;
use crate::mail::utilities::non_empty;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_shell::ShellExt;

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
