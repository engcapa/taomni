//! Tauri commands and core-owned credentials, certificate pins, and routing
//! for the signed RDP client.

#[cfg(feature = "legacy-rdp-client")]
mod legacy;
mod module_host;
pub(crate) mod tls;
mod transport;

pub use taomni_rdp_client_api::RdpOptions;
#[cfg(all(debug_assertions, feature = "legacy-rdp-client"))]
pub(crate) use taomni_rdp_client_engine::qa_graphics_capture;

use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::terminal::network::NetworkSettings;
use crate::vault::Vault;
#[cfg(feature = "legacy-rdp-client")]
use taomni_rdp_client_api::SLUG;
#[cfg(feature = "legacy-rdp-client")]
use taomni_rdp_client_engine::ws::{RdpControl, RdpSession};
use tokio_util::sync::CancellationToken;

pub(crate) enum DesktopRdpSession {
    #[cfg(feature = "legacy-rdp-client")]
    Local(RdpSession),
    Module(module_host::ModuleSession),
}

impl DesktopRdpSession {
    fn closed(&self) -> CancellationToken {
        match self {
            #[cfg(feature = "legacy-rdp-client")]
            Self::Local(session) => session.cancel.clone(),
            Self::Module(session) => session.closed(),
        }
    }
}

struct ConnectionSettings {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options: RdpOptions,
    network: Option<NetworkSettings>,
}

#[derive(Debug, Serialize)]
pub struct RdpConnectResult {
    pub session_id: String,
    pub ws_port: u16,
    pub ws_token: String,
}

/// Resolve a possibly-vault-referenced secret. Mirrors the helper used by
/// `vnc_connect`. Errors map to `VAULT_LOCKED` strings the UI already handles.
fn resolve_secret(vault: &Vault, value: Option<&str>) -> Result<Option<String>, String> {
    match value {
        Some(v) if !v.is_empty() => match vault.resolve(v)? {
            Some(plain) => Ok(Some((*plain).clone())),
            None => Ok(Some(v.to_string())),
        },
        _ => Ok(None),
    }
}

fn apply_session_credentials_to_gateway(
    options: &mut RdpOptions,
    username: &Option<String>,
    password: &Option<String>,
) {
    if let Some(g) = options.gateway.as_mut() {
        if g.use_session_creds {
            g.username = username.clone().unwrap_or_default();
            g.password = password.clone();
        }
    }
}

fn apply_stored_certificate_pins(
    state: &AppState,
    host: &str,
    port: u16,
    options: &mut RdpOptions,
) -> Result<(), String> {
    let db = state.core.db.lock().map_err(|e| e.to_string())?;
    if let Some(pin) = tls::load_pin(&db, host, port).map_err(|e| e.to_string())? {
        options.certificate_fingerprint = Some(pin);
    } else if let Some(pin) = options.certificate_fingerprint.as_deref() {
        options.certificate_fingerprint = Some(tls::normalize_fingerprint(pin)?);
    }
    if let Some(gateway) = options.gateway.as_mut() {
        if let Some(pin) =
            tls::load_pin(&db, &gateway.host, gateway.port).map_err(|e| e.to_string())?
        {
            gateway.certificate_fingerprint = Some(pin);
        } else if let Some(pin) = gateway.certificate_fingerprint.as_deref() {
            gateway.certificate_fingerprint = Some(tls::normalize_fingerprint(pin)?);
        }
    }
    Ok(())
}

fn resolve_connection(
    state: &State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options_json: Option<&str>,
    network_settings_json: Option<&str>,
) -> Result<ConnectionSettings, String> {
    let resolved_password = resolve_secret(&state.core.vault, password.as_deref())?;
    let mut options = RdpOptions::from_json(options_json);
    apply_stored_certificate_pins(state, &host, port, &mut options)?;
    if let Some(g) = options.gateway.as_mut() {
        if let Some(p) = g.password.as_deref() {
            if let Some(plain) = state.core.vault.resolve(p)? {
                g.password = Some((*plain).clone());
            }
        }
    }
    apply_session_credentials_to_gateway(&mut options, &username, &resolved_password);
    let mut network = NetworkSettings::from_json(network_settings_json);
    if let Some(n) = network.as_mut() {
        crate::terminal::resolve_proxy_session(state, n)?;
        n.resolve_proxy_pass(&state.core.vault)?;
        crate::terminal::resolve_jump_credentials(state, n)?;
    }

    Ok(ConnectionSettings {
        host,
        port,
        username,
        password: resolved_password,
        options,
        network,
    })
}

async fn start_session(
    registry: &crate::plugin::PluginRegistry,
    settings: ConnectionSettings,
) -> Result<(RdpConnectResult, DesktopRdpSession), String> {
    #[cfg(feature = "legacy-rdp-client")]
    if registry.get(SLUG).is_none() {
        return legacy::start(settings).await;
    }
    let session = module_host::start(registry, settings).await?;
    let result = RdpConnectResult {
        session_id: session.started.session_id.clone(),
        ws_port: session.started.ws_port,
        ws_token: session.started.ws_token.clone(),
    };
    Ok((result, DesktopRdpSession::Module(session)))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rdp_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options_json: Option<String>,
    network_settings_json: Option<String>,
) -> Result<RdpConnectResult, String> {
    let settings = resolve_connection(
        &state,
        host,
        port,
        username,
        password,
        options_json.as_deref(),
        network_settings_json.as_deref(),
    )?;
    let (result, session) = start_session(&state.plugins, settings).await?;
    let reaper_cancel = session.closed();

    // Reap the session-map entry once the relay's cancellation token fires
    // (idle timeout, WS close, server disconnect, or explicit
    // `rdp_disconnect`). Without this the `RdpSession` would linger in the
    // map after its backend worker has already exited.
    let reaper_sessions = state.legacy.remote_desktop.rdp_sessions.clone();
    let reaper_id = result.session_id.clone();
    state
        .legacy
        .remote_desktop
        .rdp_sessions
        .write()
        .await
        .insert(reaper_id.clone(), session);
    tokio::spawn(async move {
        reaper_cancel.cancelled().await;
        reaper_sessions.write().await.remove(&reaper_id);
    });

    Ok(result)
}

#[tauri::command]
pub async fn rdp_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = state
        .legacy
        .remote_desktop
        .rdp_sessions
        .write()
        .await
        .remove(&session_id);
    match session {
        #[cfg(feature = "legacy-rdp-client")]
        Some(DesktopRdpSession::Local(local)) => {
            let _ = local.control_tx.send(RdpControl::Disconnect);
        }
        Some(DesktopRdpSession::Module(module)) => {
            module_host::close(&state.plugins, module).await;
        }
        None => {}
    }
    Ok(())
}

/// Persist an explicitly confirmed SHA-256 certificate fingerprint. Future
/// handshakes for this exact host/port pair accept only that leaf certificate
/// when operating-system trust validation fails.
#[tauri::command]
pub async fn rdp_trust_certificate(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    fingerprint: String,
) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return Err("RDP certificate trust requires a valid host and port".to_string());
    }
    let db = state.core.db.lock().map_err(|e| e.to_string())?;
    tls::save_pin(&db, host, port, &fingerprint)
}

/// Run the real IronRDP connection path without spawning the UI relay. Used
/// by the SessionEditor "Test connection" button.
#[tauri::command]
pub async fn rdp_test_connection(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options_json: Option<String>,
    network_settings_json: Option<String>,
) -> Result<String, String> {
    let settings = resolve_connection(
        &state,
        host,
        port,
        username,
        password,
        options_json.as_deref(),
        network_settings_json.as_deref(),
    )?;
    let result = test_session(&state.plugins, settings).await?;

    Ok(format!(
        "RDP connection OK — protocol={}, desktop={}x{}, server={}",
        result.protocol, result.width, result.height, result.server_name,
    ))
}

async fn test_session(
    registry: &crate::plugin::PluginRegistry,
    settings: ConnectionSettings,
) -> Result<taomni_rdp_client_api::ConnectionTestResult, String> {
    #[cfg(feature = "legacy-rdp-client")]
    if registry.get(SLUG).is_none() {
        return legacy::test(settings).await;
    }
    module_host::test(registry, settings).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use taomni_rdp_client_api::GatewayOpt;

    #[test]
    fn gateway_reuses_session_credentials_when_requested() {
        let mut options = RdpOptions {
            gateway: Some(GatewayOpt {
                host: "rdg.example.com".into(),
                port: 443,
                username: "gateway-user".into(),
                password: Some("gateway-pass".into()),
                auth: "ntlm".into(),
                use_session_creds: true,
                certificate_fingerprint: None,
            }),
            ..RdpOptions::default()
        };
        apply_session_credentials_to_gateway(
            &mut options,
            &Some("rdp-user".into()),
            &Some("rdp-pass".into()),
        );
        let gateway = options.gateway.unwrap();
        assert_eq!(gateway.username, "rdp-user");
        assert_eq!(gateway.password.as_deref(), Some("rdp-pass"));
    }

    #[test]
    fn gateway_keeps_explicit_credentials_when_not_reusing_session() {
        let mut options = RdpOptions {
            gateway: Some(GatewayOpt {
                host: "rdg.example.com".into(),
                port: 443,
                username: "gateway-user".into(),
                password: Some("gateway-pass".into()),
                auth: "basic".into(),
                use_session_creds: false,
                certificate_fingerprint: None,
            }),
            ..RdpOptions::default()
        };
        apply_session_credentials_to_gateway(
            &mut options,
            &Some("rdp-user".into()),
            &Some("rdp-pass".into()),
        );
        let gateway = options.gateway.unwrap();
        assert_eq!(gateway.username, "gateway-user");
        assert_eq!(gateway.password.as_deref(), Some("gateway-pass"));
    }

    #[test]
    fn rdp_options_default_to_nla_for_new_sessions() {
        assert!(RdpOptions::default().nla);
        let parsed: RdpOptions = serde_json::from_str("{}").unwrap();
        assert!(parsed.nla);
        let legacy_tls: RdpOptions = serde_json::from_str(r#"{"nla":false}"#).unwrap();
        assert!(!legacy_tls.nla);
    }
}
