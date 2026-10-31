use super::active::ActiveTerminal;
use super::output::TerminalOutputSubscribers;
use super::output::send_terminal_output;
use crate::state::AppState;
use crate::terminal::forwards;
use crate::terminal::pty;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use russh::Sig;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;

pub(super) fn read_loop_local(
    mut reader: Box<dyn Read + Send>,
    session_id: String,
    app: AppHandle,
    outputs: TerminalOutputSubscribers,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                send_terminal_output(&outputs, &session_id, buf[..n].to_vec());
            }
            Err(_) => break,
        }
    }
    if let Ok(mut outputs) = outputs.lock() {
        outputs.remove(&session_id);
    }
    outputs.broker.exit(&session_id);
    crate::mobile::events::EventSink::emit(
        &crate::mobile::events::DesktopSink(app),
        &format!("terminal-exit-{}", session_id),
        serde_json::json!("closed"),
    );
}

pub(super) fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("Terminal session id is required".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn write_terminal(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let gate = state.mobile.broker.gate(&session_id).ok();
    let _guard = match gate.as_ref() {
        Some(g) => Some(g.lock().await),
        None => None,
    };
    if let Some((cols, rows)) = state.mobile.broker.desktop(&session_id, None) {
        let _ = resize_terminal_inner(&state, &session_id, cols, rows).await;
    }
    write_terminal_inner(&state, &session_id, &data).await
}

pub(crate) async fn write_terminal_inner(
    state: &AppState,
    session_id: &str,
    data: &str,
) -> Result<(), String> {
    let bytes = B64
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    let terminals = state.terminal.terminals.read().await;
    let terminal = terminals
        .get(session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { writer, .. } => {
            let mut w = writer.lock().map_err(|e| format!("Lock failed: {}", e))?;
            w.write_all(&bytes)
                .map_err(|e| format!("Write failed: {}", e))?;
            w.flush().map_err(|e| format!("Flush failed: {}", e))?;
        }
        ActiveTerminal::Ssh { channel, .. } => {
            let channel = Arc::clone(channel);
            drop(terminals);
            let ch = channel.lock().await;
            ch.data_bytes(bytes)
                .await
                .map_err(|e| format!("SSH write failed: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let gate = state.mobile.broker.gate(&session_id).ok();
    let _guard = match gate.as_ref() {
        Some(g) => Some(g.lock().await),
        None => None,
    };
    state.mobile.broker.desktop(&session_id, Some((cols, rows)));
    resize_terminal_inner(&state, &session_id, cols, rows).await
}

pub(crate) async fn resize_terminal_inner(
    state: &AppState,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminal.terminals.read().await;
    let terminal = terminals
        .get(session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { master, .. } => {
            let m = master.lock().map_err(|e| format!("Lock failed: {}", e))?;
            pty::resize_pty(&**m, cols, rows)
        }
        ActiveTerminal::Ssh { channel, .. } => {
            let channel = Arc::clone(channel);
            drop(terminals);
            let ch = channel.lock().await;
            ch.window_change(cols as u32, rows as u32, 0, 0)
                .await
                .map_err(|e| format!("SSH resize failed: {}", e))?;
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn send_terminal_signal(
    session_id: String,
    signal: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    send_terminal_signal_inner(&state, &session_id, &signal).await
}

pub(crate) async fn send_terminal_signal_inner(
    state: &AppState,
    session_id: &str,
    signal: &str,
) -> Result<(), String> {
    let terminals = state.terminal.terminals.read().await;
    let terminal = terminals
        .get(session_id)
        .ok_or_else(|| format!("Terminal {} not found", session_id))?;

    match terminal {
        ActiveTerminal::Local { child, .. } => send_local_signal(child, signal),
        ActiveTerminal::Ssh { channel, .. } => {
            let sig = ssh_signal_from_name(signal)?;
            let channel = Arc::clone(channel);
            drop(terminals);
            let ch = channel.lock().await;
            ch.signal(sig)
                .await
                .map_err(|e| format!("SSH signal failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn close_terminal(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.mobile.broker.remove(&session_id);
    let removed = {
        let mut terminals = state.terminal.terminals.write().await;
        terminals.remove(&session_id)
    };
    if let Some(ActiveTerminal::Ssh { forwards, .. }) = removed {
        // Abort listener tasks so the local TCP ports are released
        // before the SSH handle drops.
        let mut tasks = forwards.lock().await;
        for h in tasks.drain(..) {
            h.abort();
        }
    }
    if let Ok(mut outputs) = state.terminal.terminal_outputs.lock() {
        outputs.remove(&session_id);
    }
    // A closed terminal can never accept late cwd reports; drop its
    // per-runtime dedup entry (design §4.1.5).
    if let Ok(mut runtime) = state.terminal.local_directory_runtime.lock() {
        runtime.remove(&session_id);
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn send_local_signal(
    child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    signal: &str,
) -> Result<(), String> {
    let sig = match signal {
        "SIGINT" => libc::SIGINT,
        "SIGTERM" => libc::SIGTERM,
        "SIGKILL" => libc::SIGKILL,
        "SIGQUIT" => libc::SIGQUIT,
        "SIGHUP" => libc::SIGHUP,
        _ => return Err(format!("Unsupported local signal {}", signal)),
    };
    let child = child.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let pid = child
        .process_id()
        .ok_or_else(|| "Local terminal process id is unavailable".to_string())?;
    let rc = unsafe { libc::kill(pid as i32, sig) };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!(
            "Local signal {} failed: {}",
            signal,
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(unix))]
pub(super) fn send_local_signal(
    child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    signal: &str,
) -> Result<(), String> {
    match signal {
        "SIGTERM" | "SIGKILL" => {
            let mut child = child.lock().map_err(|e| format!("Lock failed: {}", e))?;
            child
                .kill()
                .map_err(|e| format!("Local kill failed: {}", e))
        }
        _ => Err(format!(
            "Local signal {} is not supported on this platform",
            signal
        )),
    }
}

pub(super) fn ssh_signal_from_name(signal: &str) -> Result<Sig, String> {
    match signal {
        "SIGINT" => Ok(Sig::INT),
        "SIGTERM" => Ok(Sig::TERM),
        "SIGKILL" => Ok(Sig::KILL),
        "SIGQUIT" => Ok(Sig::QUIT),
        "SIGHUP" => Ok(Sig::HUP),
        _ => Err(format!("Unsupported SSH signal {}", signal)),
    }
}
