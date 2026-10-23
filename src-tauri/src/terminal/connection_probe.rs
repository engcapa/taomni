use super::ssh_start::resolve_jump_credentials;
use super::ssh_start::resolve_proxy_session;
use crate::state::AppState;
use crate::terminal::network;
use crate::terminal::ssh;
use tauri::State;

#[tauri::command]
pub async fn test_ssh_connection(
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    auth_data: Option<String>,
    network_settings_json: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let auth = match auth_method.as_str() {
        "Password" => {
            let raw = auth_data.unwrap_or_default();
            let resolved = state.vault.resolve(&raw)?;
            ssh::SshAuth::Password(resolved.map(|z| (*z).clone()).unwrap_or(raw))
        }
        "PrivateKey" => {
            ssh::SshAuth::PrivateKey(auth_data.unwrap_or_else(|| "~/.ssh/id_ed25519".to_string()))
        }
        "Agent" => ssh::SshAuth::Agent,
        "Gssapi" | "None" => ssh::SshAuth::Gssapi,
        _ => {
            let raw = auth_data.unwrap_or_default();
            let resolved = state.vault.resolve(&raw)?;
            ssh::SshAuth::Password(resolved.map(|z| (*z).clone()).unwrap_or(raw))
        }
    };

    let network = network::NetworkSettings::from_json(network_settings_json.as_deref());
    let network = match network {
        Some(mut n) => {
            resolve_proxy_session(&state, &mut n)?;
            n.resolve_proxy_pass(&state.vault)?;
            resolve_jump_credentials(&state, &mut n)?;
            Some(n)
        }
        None => None,
    };

    if matches!(auth, ssh::SshAuth::Gssapi) {
        return super::openssh::probe(&host, port, &username, network.as_ref()).await;
    }
    let start = std::time::Instant::now();
    let (handle, channel, _rx) = ssh::connect_ssh(
        &host,
        port,
        &username,
        auth,
        80,
        24,
        network.as_ref(),
        None,
        None,
        None,
    )
    .await?;
    let elapsed = start.elapsed();

    // Close the test connection
    drop(channel);
    drop(handle);

    Ok(format!(
        "Connection successful ({:.0}ms)",
        elapsed.as_millis()
    ))
}

/// Test proxy connectivity by establishing a TCP connection through the proxy
/// to a user-specified test target (default: www.google.com:443). Returns timing on
/// success or an error message on failure.
#[tauri::command]
pub async fn test_proxy_connection(
    proxy_kind: String,
    proxy_host: String,
    proxy_port: u16,
    proxy_user: String,
    proxy_pass: String,
    test_host: String,
    test_port: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let resolved_pass = state
        .vault
        .resolve(&proxy_pass)?
        .map(|z| (*z).clone())
        .unwrap_or(proxy_pass);

    let ns = network::NetworkSettings {
        proxy_kind,
        proxy_host,
        proxy_port,
        proxy_user,
        proxy_pass: resolved_pass,
        ..Default::default()
    };

    let start = std::time::Instant::now();
    let stream = network::establish_transport(&test_host, test_port, Some(&ns)).await?;
    drop(stream);
    let elapsed = start.elapsed();

    Ok(format!("OK ({:.0}ms)", elapsed.as_millis()))
}
