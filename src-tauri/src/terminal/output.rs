use super::io_commands::validate_session_id;
use crate::state::AppState;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::State;
use tauri::ipc::Channel;
use tauri::ipc::InvokeResponseBody;

pub type TerminalOutputChannel = Channel<InvokeResponseBody>;
pub struct TerminalOutputSubscriber {
    pub(super) channel: TerminalOutputChannel,
    pub(super) window_label: String,
}
pub struct TerminalOutputHub {
    desktop: Mutex<HashMap<String, Vec<TerminalOutputSubscriber>>>,
    pub(crate) broker: Arc<crate::mobile::pty_broker::Broker>,
}
impl TerminalOutputHub {
    pub(crate) fn new(broker: Arc<crate::mobile::pty_broker::Broker>) -> Self {
        Self {
            desktop: Mutex::new(HashMap::new()),
            broker,
        }
    }
    pub(crate) fn lock(
        &self,
    ) -> std::sync::LockResult<
        std::sync::MutexGuard<'_, HashMap<String, Vec<TerminalOutputSubscriber>>>,
    > {
        self.desktop.lock()
    }
}
pub(crate) type TerminalOutputSubscribers = Arc<TerminalOutputHub>;

pub(crate) fn revoke_window_outputs(state: &AppState, window_label: &str) {
    if let Ok(mut outputs) = state.terminal.terminal_outputs.lock() {
        for subscribers in outputs.values_mut() {
            subscribers.retain(|subscriber| subscriber.window_label != window_label);
        }
        outputs.retain(|_, subscribers| !subscribers.is_empty());
    }
}

pub(super) fn add_terminal_output_channel(
    outputs: &TerminalOutputSubscribers,
    session_id: &str,
    on_output: TerminalOutputChannel,
    window_label: &str,
) -> Result<(), String> {
    let mut outputs = outputs
        .lock()
        .map_err(|e| format!("Terminal output lock failed: {}", e))?;
    outputs
        .entry(session_id.to_string())
        .or_default()
        .push(TerminalOutputSubscriber {
            channel: on_output,
            window_label: window_label.to_owned(),
        });
    Ok(())
}

pub(super) fn send_terminal_output(
    outputs: &TerminalOutputSubscribers,
    session_id: &str,
    data: Vec<u8>,
) {
    outputs.broker.output(session_id, &data);
    let Ok(mut outputs) = outputs.lock() else {
        return;
    };
    let Some(channels) = outputs.get_mut(session_id) else {
        return;
    };
    channels.retain(|subscriber| {
        subscriber
            .channel
            .send(InvokeResponseBody::Raw(data.clone()))
            .is_ok()
    });
}

#[tauri::command]
pub async fn attach_terminal_output(
    session_id: String,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    use tauri::Manager;
    let output_generation =
        crate::webview_recovery::output_generation(window.app_handle(), window.label());
    validate_session_id(&session_id)?;
    {
        let terminals = state.terminal.terminals.read().await;
        if !terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} not found", session_id));
        }
    }
    crate::webview_recovery::register_output(
        window.app_handle(),
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
    )
}

/// Only remove this caller's particular subscription. Never close a native
/// terminal as cleanup for a read-only recovery view.
#[tauri::command]
pub fn detach_terminal_output(
    session_id: String,
    channel_id: u32,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut outputs = state
        .terminal
        .terminal_outputs
        .lock()
        .map_err(|_| "Terminal output lock failed")?;
    if let Some(subscribers) = outputs.get_mut(&session_id) {
        subscribers.retain(|s| s.window_label != window.label() || s.channel.id() != channel_id);
    }
    Ok(())
}
