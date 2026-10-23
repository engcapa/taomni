use super::active::ActiveTerminal;
use super::authentication::build_kbd_prompter;
use super::authentication::clear_session_auth_responders;
use super::io_commands::validate_session_id;
use super::output::TerminalOutputChannel;
use super::output::add_terminal_output_channel;
use super::output::send_terminal_output;
use crate::state::AppState;
use crate::terminal::forwards;
use crate::terminal::network;
use crate::terminal::ssh;
use crate::terminal::x11;
use crate::terminal::x11_forward;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

/// Resolve SSH jump-host credentials into the manual `jump_*` fields of
/// `network`, so [`ssh::build_ssh_transport`] has a self-contained config.
///
/// - Session mode (`jump_session_id` set): look the jump session up in the
///   sessions DB, copy host/port/user/auth, and resolve its saved password
///   (`passwordRef` in options_json) or key path. A vault-locked password
///   surfaces as `VAULT_LOCKED`.
/// - Manual mode: just resolve a `vault:` reference in `jump_password`.
///
/// No-op when the session does not use a jump host.
pub(crate) fn resolve_jump_credentials(
    state: &State<'_, AppState>,
    network: &mut network::NetworkSettings,
) -> Result<(), String> {
    if !network.uses_jump_host() {
        return Ok(());
    }

    if !network.jump_session_id.trim().is_empty() {
        let jump = {
            let db = state
                .db
                .lock()
                .map_err(|_| "session database is unavailable".to_string())?;
            crate::session::db::get_session(&db, &network.jump_session_id)
                .map_err(|e| format!("jump session not found: {}", e))?
        };
        if jump.session_type != crate::session::models::SessionType::SSH {
            return Err("selected jump session is not an SSH session".into());
        }
        network.jump_host = jump.host.clone();
        network.jump_port = jump.port;
        network.jump_user = jump.username.clone().unwrap_or_default();
        match &jump.auth_method {
            crate::session::models::AuthMethod::PrivateKey { key_path } => {
                network.jump_auth_kind = "PrivateKey".into();
                network.jump_key_path = key_path.clone();
            }
            _ => {
                network.jump_auth_kind = "Password".into();
                // Saved SSH sessions stash the password as a `vault:` ref under
                // `passwordRef` in options_json; manual auth has none.
                let pass_ref = serde_json::from_str::<serde_json::Value>(&jump.options_json)
                    .ok()
                    .and_then(|v| {
                        v.get("passwordRef")
                            .and_then(|r| r.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default();
                if !pass_ref.is_empty() {
                    network.jump_password = pass_ref;
                }
            }
        }
    }

    // Resolve any `vault:` reference in the (manual or session-derived)
    // password into plaintext.
    network.resolve_jump_secret(&state.vault)?;
    Ok(())
}

/// If `proxy_session_id` is set on the network settings, load the saved Proxy
/// session from the DB and override the proxy_kind/host/port/user/pass fields.
pub(crate) fn resolve_proxy_session(
    state: &State<'_, AppState>,
    network: &mut network::NetworkSettings,
) -> Result<(), String> {
    if matches!(network.proxy_kind.as_str(), "app" | "custom") {
        return network::proxy_selection::resolve_application(state.inner(), network);
    }
    if !matches!(network.proxy_kind.as_str(), "http" | "socks5") {
        return Ok(());
    }
    let id = network.proxy_session_id.trim();
    if id.is_empty() {
        return Ok(());
    }

    let proxy_session = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::session::db::get_session(&db, id)
            .map_err(|e| format!("proxy session not found: {}", e))?
    };

    // Read proxyKind from options_json
    let proxy_kind = serde_json::from_str::<serde_json::Value>(&proxy_session.options_json)
        .ok()
        .and_then(|v| {
            v.get("proxyKind")
                .and_then(|k| k.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "http".to_string());

    network.proxy_kind = proxy_kind;
    network.proxy_host = proxy_session.host.clone();
    network.proxy_port = proxy_session.port;
    network.proxy_user = proxy_session.username.clone().unwrap_or_default();

    // Read password from vault ref in options_json
    let pass_ref = serde_json::from_str::<serde_json::Value>(&proxy_session.options_json)
        .ok()
        .and_then(|v| {
            v.get("passwordRef")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    network.proxy_pass = pass_ref;

    Ok(())
}

#[tauri::command]
pub async fn create_ssh_terminal(
    session_id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    auth_data: Option<String>,
    cols: u16,
    rows: u16,
    network_settings_json: Option<String>,
    x11: Option<bool>,
    x11_trusted: Option<bool>,
    startup_command: Option<String>,
    keep_open_after_startup_command: Option<bool>,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let output_generation = crate::webview_recovery::output_generation(&app_handle, window.label());
    validate_session_id(&session_id)?;
    {
        let terminals = state.terminal.terminals.read().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
    }

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

    // Keyboard-interactive (MFA/OTP) prompter: bridges the SSH auth loop to
    // the frontend so a second factor can be entered mid-connect. Cleaned up
    // below once connect resolves (success or error).
    let prompter = build_kbd_prompter(
        app_handle.clone(),
        state.terminal.ssh_auth_responders.clone(),
        session_id.clone(),
    );

    // X11 forwarding: resolve the local X server + cookie if the session has
    // X11 enabled. Resolution failure (no local display) is non-fatal — we log
    // and connect without forwarding so the terminal still works.
    let x11_forward = if x11.unwrap_or(false) {
        match x11::resolve(None) {
            Ok(display) => {
                let trusted = x11_trusted.unwrap_or(true);
                Some(Arc::new(x11_forward::XForward::new(
                    Arc::new(display),
                    trusted,
                )))
            }
            Err(e) => {
                tracing::warn!(
                    "X11 enabled but no local display ({}); connecting without forwarding",
                    e
                );
                None
            }
        }
    } else {
        None
    };

    let startup_command = startup_command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .map(|command| ssh::SshStartupCommand {
            command: command.to_string(),
            keep_open: keep_open_after_startup_command.unwrap_or(false),
        });

    let connect_result = ssh::connect_ssh(
        &host,
        port,
        &username,
        auth,
        cols,
        rows,
        network.as_ref(),
        Some(&prompter),
        x11_forward,
        startup_command.as_ref(),
    )
    .await;
    // Drop any responder left dangling for this session (e.g. auth failed
    // while a prompt round was still registered) so the map doesn't leak.
    clear_session_auth_responders(&state.terminal.ssh_auth_responders, &session_id);
    let (handle, channel, mut output_rx) = connect_result?;

    let handle_arc = Arc::new(handle);

    // Start any session-attached local port forwards. We capture the join
    // handles so `close_terminal` can abort them and release the bound
    // TCP listening ports.
    let forward_handles = if let Some(n) = &network {
        if !n.local_forwards.is_empty() {
            forwards::spawn_local_forwards(
                handle_arc.clone(),
                &n.local_forwards,
                app_handle.clone(),
                session_id.clone(),
            )
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let terminal = ActiveTerminal::Ssh {
        channel: Arc::new(AsyncMutex::new(channel)),
        handle: handle_arc,
        forwards: AsyncMutex::new(forward_handles),
    };

    {
        let mut terminals = state.terminal.terminals.write().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
        terminals.insert(session_id.clone(), terminal);
    }

    crate::webview_recovery::register_output(
        &app_handle,
        window.label(),
        output_generation,
        || {
            add_terminal_output_channel(
                &state.terminal.terminal_outputs,
                &session_id,
                on_output,
                window.label(),
            )
        },
    )?;

    let sid = session_id.clone();
    let app = app_handle.clone();
    let terminals = state.terminal.terminals.clone();
    let outputs = state.terminal.terminal_outputs.clone();
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            send_terminal_output(&outputs, &sid, data);
        }
        // SSH session ended naturally (peer closed, network drop, exit).
        // Remove the terminal entry and abort any session-attached
        // forward listeners so their bound TCP ports are released and
        // the in-flight bridge tasks (owned by per-listener JoinSets)
        // are torn down. This mirrors what `close_terminal` does on an
        // explicit user close, so forwards always end with the SSH
        // session — never outlive it.
        let removed = {
            let mut map = terminals.write().await;
            map.remove(&sid)
        };
        if let Some(ActiveTerminal::Ssh { forwards, .. }) = removed {
            let mut tasks = forwards.lock().await;
            for h in tasks.drain(..) {
                h.abort();
            }
        }
        if let Ok(mut outputs) = outputs.lock() {
            outputs.remove(&sid);
        }
        let _ = app.emit(&format!("terminal-exit-{}", sid), "closed");
    });

    Ok(session_id)
}
