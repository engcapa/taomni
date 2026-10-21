use super::model::TunnelAuthMethod;
use super::model::TunnelConfig;
use super::model::TunnelSshCreds;
use crate::terminal::ssh::SshAuth;

/* ---------------------------- helpers ------------------------------- */

pub(super) fn ssh_auth_from(creds: &TunnelSshCreds) -> Result<SshAuth, String> {
    match creds.auth_method {
        TunnelAuthMethod::Password => {
            let pwd = creds
                .auth_data
                .clone()
                .ok_or_else(|| "Password is empty".to_string())?;
            Ok(SshAuth::Password(pwd))
        }
        TunnelAuthMethod::PrivateKey => {
            let path = creds
                .auth_data
                .clone()
                .ok_or_else(|| "Private key path is empty".to_string())?;
            Ok(SshAuth::PrivateKey(path))
        }
        TunnelAuthMethod::Agent => Ok(SshAuth::Agent),
    }
}

/// Replace `config.ssh.auth_data` with the resolved plaintext when it is
/// `vault:<id>`. Called by command entrypoints before spawning the forward
/// task, so the spawned task never needs to carry a `Vault` handle.
///
/// When the persisted `auth_data` is `None` (which happens whenever the
/// user saves a Password tunnel with `save_auth=false` — see
/// [`save_all`]), look for a session-cached plaintext password keyed by
/// `config.id` so the user can Save → Start within a single session
/// without being asked to re-enter the password.
pub(super) fn resolve_tunnel_creds(
    config: &mut TunnelConfig,
    vault: &crate::vault::Vault,
    session_password: Option<String>,
) -> Result<(), String> {
    if !matches!(config.ssh.auth_method, TunnelAuthMethod::Password) {
        return Ok(());
    }
    let raw = match config.ssh.auth_data.as_deref() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            // No persisted secret. Use the in-memory password if we have one;
            // otherwise leave auth_data as-is and let `ssh_auth_from` raise
            // a clear "Password is empty" error.
            if let Some(pwd) = session_password {
                config.ssh.auth_data = Some(pwd);
            }
            return Ok(());
        }
    };
    if let Some(plain) = vault.resolve(&raw)? {
        config.ssh.auth_data = Some((*plain).clone());
    }
    Ok(())
}

pub(super) fn compute_auth_status(creds: &TunnelSshCreds, has_session: bool) -> String {
    if matches!(creds.auth_method, TunnelAuthMethod::Agent) {
        return "agent".to_string();
    }
    match creds.auth_data.as_deref() {
        Some(s) if s.starts_with(crate::vault::VAULT_REF_PREFIX) => "vault".to_string(),
        Some(s) if !s.is_empty() => "plaintext".to_string(),
        _ => {
            if has_session {
                "session".to_string()
            } else {
                "none".to_string()
            }
        }
    }
}
