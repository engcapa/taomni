//! OpenSSH preparation is cancellable; final PTY spawn/registration is atomic
//! with respect to the mobile request. The route and probe are owned here.
use super::{
    active::ActiveTerminal,
    io_commands::read_loop_local,
    network::NetworkSettings,
    openssh,
    output::{TerminalOutputChannel, add_terminal_output_channel},
    pty,
};
use crate::{
    mobile::session_open::connection_auth::{MobileAuthContext, during_connection},
    state::AppState,
};
use std::{io::Write, sync::Mutex};

pub(super) async fn start(
    session_id: String,
    host: &str,
    port: u16,
    username: &str,
    cols: u16,
    rows: u16,
    network: Option<&NetworkSettings>,
    x11: bool,
    x11_trusted: bool,
    startup_command: Option<&str>,
    keep_open: bool,
    on_output: TerminalOutputChannel,
    state: &AppState,
    app_handle: tauri::AppHandle,
    window_label: &str,
    output_generation: Option<u64>,
    mobile: Option<&MobileAuthContext>,
) -> Result<String, String> {
    let mut launch = during_connection(mobile, async {
        openssh::probe(host, port, username, network).await?;
        openssh::launch(host, port, username, network).await
    })
    .await?;
    launch.args.insert(0, "-tt".into());
    if x11 {
        launch
            .args
            .insert(0, if x11_trusted { "-Y" } else { "-X" }.into());
    }
    if let Some(net) = network {
        for forward in &net.local_forwards {
            launch
                .args
                .insert(0, format!("-L{}:{}", forward.local, forward.remote));
        }
        if !net.local_forwards.is_empty() {
            launch.args.insert(0, "-oExitOnForwardFailure=yes".into());
        }
    }
    let command = startup_command.map(str::trim).filter(|s| !s.is_empty());
    if !keep_open {
        if let Some(command) = command {
            launch.args.push(command.into());
        }
    }
    let mut terminals = state.terminal.terminals.write().await;
    if terminals.contains_key(&session_id) {
        return Err(format!("Terminal {} already exists", session_id));
    }
    let register = || {
        let (mut handle, reader) =
            pty::create_command_pty(cols, rows, &launch.program, &launch.args)?;
        // Until published, this scope owns and explicitly kills the child on
        // errors (portable-pty child drop alone does not guarantee termination).
        let prepared = (|| {
            if keep_open {
                if let Some(command) = command {
                    handle
                        .writer
                        .write_all(format!("{command}\r").as_bytes())
                        .map_err(|e| e.to_string())?;
                }
            }
            crate::webview_recovery::register_output(
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
            )
        })();
        if let Err(error) = prepared {
            let _ = handle.child.kill();
            return Err(error);
        }
        let terminal = ActiveTerminal::Local {
            _route: launch.route,
            writer: Mutex::new(handle.writer),
            master: Mutex::new(handle.master),
            child: Mutex::new(handle.child),
        };
        state.mobile.broker.register(&session_id);
        state.mobile.broker.desktop(&session_id, Some((cols, rows)));
        terminals.insert(session_id.clone(), terminal);
        Ok(reader)
    };
    let reader = if let Some(mobile) = mobile {
        mobile
            .runtime
            .open_requests
            .while_pending(&mobile.request_id, register)?
    } else {
        register()?
    };
    drop(terminals);
    let sid = session_id.clone();
    let outputs = state.terminal.terminal_outputs.clone();
    std::thread::spawn(move || read_loop_local(reader, sid, app_handle, outputs));
    Ok(session_id)
}
