use super::*;

pub(super) fn resolve_config(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
) -> Result<ResolvedMailAccount, String> {
    let network_settings = prepare_mail_network(state, config.network_settings.clone())?;
    let imap_host = config.imap.host.trim();
    if imap_host.is_empty() {
        return Err("IMAP host is required".into());
    }
    if config.smtp.host.trim().is_empty() {
        return Err("SMTP host is required".into());
    }
    let imap_username = config
        .imap
        .username
        .clone()
        .and_then(non_empty)
        .or_else(|| non_empty(config.email_address.clone()))
        .ok_or_else(|| "IMAP username is required".to_string())?;
    let (imap_password, smtp_username, smtp_password) = match config.auth_mode {
        MailAuthMode::Password => {
            let imap_password = resolve_secret(state, config.imap.password.as_deref())?
                .ok_or_else(|| "IMAP password or app password token is required".to_string())?;

            let (smtp_username, smtp_password) = if config.smtp.use_imap_auth {
                (imap_username.clone(), imap_password.clone())
            } else {
                let username = config
                    .smtp
                    .username
                    .clone()
                    .and_then(non_empty)
                    .or_else(|| non_empty(config.email_address.clone()))
                    .ok_or_else(|| "SMTP username is required".to_string())?;
                let password = resolve_secret(state, config.smtp.password.as_deref())?
                    .ok_or_else(|| "SMTP password or app password token is required".to_string())?;
                (username, password)
            };
            (imap_password, smtp_username, smtp_password)
        }
        MailAuthMode::OAuth2 => {
            let access_token =
                resolve_oauth_access_token(state, &config, network_settings.as_ref())?;
            let smtp_username = if config.smtp.use_imap_auth {
                imap_username.clone()
            } else {
                config
                    .smtp
                    .username
                    .clone()
                    .and_then(non_empty)
                    .or_else(|| non_empty(config.email_address.clone()))
                    .ok_or_else(|| "SMTP username is required".to_string())?
            };
            (access_token.clone(), smtp_username, access_token)
        }
    };

    Ok(ResolvedMailAccount {
        auth_mode: config.auth_mode,
        network_settings,
        config,
        imap_username,
        imap_password,
        smtp_username,
        smtp_password,
    })
}

pub(super) fn resolve_secret(
    state: &State<'_, AppState>,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => match state.vault.resolve(v)? {
            Some(plain) => Ok(Some((*plain).clone())),
            None => Ok(Some(v.to_string())),
        },
        None => Ok(None),
    }
}

/// Resolve mail session network settings for IMAP/SMTP/OAuth.
///
/// Important: this uses **only** the mail session's own `networkSettings`.
/// It never falls back to the app global proxy (`proxy::AppProxyConfig`).
/// Missing settings or `proxy_kind` empty/`none` means a direct connection.
pub(super) fn prepare_mail_network(
    state: &State<'_, AppState>,
    network: Option<NetworkSettings>,
) -> Result<Option<NetworkSettings>, String> {
    let Some(mut net) = network else {
        return Ok(None);
    };
    if matches!(net.proxy_kind.as_str(), "" | "none") {
        return Ok(None);
    }
    crate::terminal::resolve_proxy_session(state, &mut net)?;
    net.resolve_proxy_pass(&state.vault)?;
    crate::terminal::resolve_jump_credentials(state, &mut net)?;
    Ok(Some(net))
}
