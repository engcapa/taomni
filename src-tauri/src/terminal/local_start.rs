use super::active::ActiveTerminal;
use super::io_commands::read_loop_local;
use super::io_commands::validate_session_id;
use super::local_commands::record_successful_local_start;
use super::output::TerminalOutputChannel;
use super::output::add_terminal_output_channel;
use crate::state::AppState;
use crate::terminal::client;
use crate::terminal::pty;
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::io::Write;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::State;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalCreated {
    pub session_id: String,
    /// `LocalShellOption.id` of the shell that was actually launched. Lets the
    /// frontend skip features (e.g. inline history suggestions) that conflict
    /// with shells that already provide them, even when the caller didn't pass
    /// an explicit `shell` arg and we resolved a default.
    pub shell_id: String,
    /// Present when the terminal started successfully but the local-directory
    /// usage record could not be saved. Launch success is never downgraded to
    /// an IPC error for a history write failure (design §4.1.5).
    pub directory_use_warning: Option<String>,
    /// SDK variables resolved for this workspace. Interactive shell profiles
    /// may overwrite the PTY launch environment, so task wrappers re-apply
    /// these values immediately around each command.
    pub task_environment: BTreeMap<String, String>,
}

pub(super) fn terminal_task_environment(
    sdk_environment: Option<&crate::sdk::WorkspaceSdkEnvironment>,
    inherited_path: Option<&std::ffi::OsStr>,
) -> BTreeMap<String, String> {
    let Some(sdk_environment) = sdk_environment else {
        return BTreeMap::new();
    };
    let mut environment = sdk_environment.environment.clone();
    if let Some(path) = sdk_environment.prepend_path(inherited_path) {
        environment.insert("PATH".to_string(), path.to_string_lossy().into_owned());
    }
    environment
}

/// Register an already-spawned local PTY in the shared terminal runtime and
/// start forwarding its output. SocksCap uses this after it has prepared the
/// rootless capture environment and spawned an interactive TUI command.
pub(crate) async fn register_local_terminal(
    session_id: String,
    handle: pty::PtyHandle,
    reader: Box<dyn Read + Send>,
    on_output: TerminalOutputChannel,
    state: &AppState,
    app_handle: AppHandle,
    window_label: &str,
    output_generation: Option<u64>,
) -> Result<(), String> {
    register_routed_terminal(
        session_id,
        handle,
        reader,
        on_output,
        state,
        app_handle,
        window_label,
        output_generation,
        crate::database::forward::ForwardGuard(None),
    )
    .await
}

pub(crate) async fn register_routed_terminal(
    session_id: String,
    handle: pty::PtyHandle,
    reader: Box<dyn Read + Send>,
    on_output: TerminalOutputChannel,
    state: &AppState,
    app_handle: AppHandle,
    window_label: &str,
    output_generation: Option<u64>,
    route: crate::database::forward::ForwardGuard,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let initial_size = handle
        .master
        .get_size()
        .ok()
        .map(|size| (size.cols, size.rows));
    let terminal = ActiveTerminal::Local {
        _route: route,
        writer: Mutex::new(handle.writer),
        master: Mutex::new(handle.master),
        child: Mutex::new(handle.child),
    };

    {
        let mut terminals = state.terminal.terminals.write().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
        state.mobile.broker.register(&session_id);
        state.mobile.broker.desktop(&session_id, initial_size);
        terminals.insert(session_id.clone(), terminal);
    }
    if let Err(error) = crate::webview_recovery::register_output(
        &app_handle,
        window_label,
        output_generation,
        || {
            add_terminal_output_channel(
                &state.terminal.terminal_outputs,
                &session_id,
                on_output,
                window_label,
            )
        },
    ) {
        state.terminal.terminals.write().await.remove(&session_id);
        return Err(error);
    }

    let sid = session_id;
    let terminals = state.terminal.terminals.clone();
    let outputs = state.terminal.terminal_outputs.clone();
    std::thread::spawn(move || {
        read_loop_local(reader, sid.clone(), app_handle, outputs);
        // Drop the route and child after EOF, including a remote network loss.
        terminals.blocking_write().remove(&sid);
    });
    Ok(())
}

#[tauri::command]
pub async fn create_local_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
    workspace_root: Option<String>,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<LocalTerminalCreated, String> {
    let output_generation = crate::webview_recovery::output_generation(&app_handle, window.label());
    validate_session_id(&session_id)?;
    let sdk_environment = if let Some(root) = workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|root| !root.is_empty())
    {
        let root_path = std::path::Path::new(root);
        let scope_path = cwd
            .as_deref()
            .map(std::path::Path::new)
            .unwrap_or(root_path);
        match state
            .workspace
            .sdk
            .resolve_environment(root_path, scope_path)
            .await
        {
            Ok(environment) => Some(environment),
            Err(error) => {
                log::warn!(
                    "failed to resolve workspace terminal SDK environment for {root}: {error}"
                );
                None
            }
        }
    } else {
        None
    };
    let task_environment = terminal_task_environment(
        sdk_environment.as_ref(),
        std::env::var_os("PATH").as_deref(),
    );
    let (handle, reader, shell_id) = pty::create_pty_with_environment(
        cols,
        rows,
        shell,
        shell_args,
        cwd.clone(),
        sdk_environment.as_ref(),
    )?;

    let initial_size = handle
        .master
        .get_size()
        .ok()
        .map(|size| (size.cols, size.rows));
    let terminal = ActiveTerminal::Local {
        _route: crate::database::forward::ForwardGuard(None),
        writer: Mutex::new(handle.writer),
        master: Mutex::new(handle.master),
        child: Mutex::new(handle.child),
    };

    {
        let mut terminals = state.terminal.terminals.write().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
        state.mobile.broker.register(&session_id);
        state.mobile.broker.desktop(&session_id, initial_size);
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
    let outputs = state.terminal.terminal_outputs.clone();
    std::thread::spawn(move || {
        read_loop_local(reader, sid, app, outputs);
    });

    let directory_use_warning =
        record_successful_local_start(&state, &app_handle, &session_id, cwd.as_deref());

    Ok(LocalTerminalCreated {
        session_id,
        shell_id,
        directory_use_warning,
        task_environment,
    })
}

#[tauri::command]
pub async fn create_command_terminal(
    session_id: String,
    kind: String,
    host: String,
    port: u16,
    username: Option<String>,
    options_json: Option<String>,
    cols: u16,
    rows: u16,
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

    let launch = client::build_client_terminal_launch(
        &kind,
        &host,
        port,
        username.as_deref(),
        options_json.as_deref(),
    )?;
    let (handle, reader) = pty::create_command_pty(cols, rows, &launch.program, &launch.args)?;

    let initial_size = handle
        .master
        .get_size()
        .ok()
        .map(|size| (size.cols, size.rows));
    let terminal = ActiveTerminal::Local {
        _route: crate::database::forward::ForwardGuard(None),
        writer: Mutex::new(handle.writer),
        master: Mutex::new(handle.master),
        child: Mutex::new(handle.child),
    };

    {
        let mut terminals = state.terminal.terminals.write().await;
        if terminals.contains_key(&session_id) {
            return Err(format!("Terminal {} already exists", session_id));
        }
        state.mobile.broker.register(&session_id);
        state.mobile.broker.desktop(&session_id, initial_size);
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
    let outputs = state.terminal.terminal_outputs.clone();
    std::thread::spawn(move || {
        read_loop_local(reader, sid, app, outputs);
    });

    Ok(session_id)
}
