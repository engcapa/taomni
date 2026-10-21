use super::connection::SessionSlot;
use super::connection::ShellIo;
use super::connection::SshConnection;
use russh::ChannelId;
use russh::server::Session;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::Ordering;

impl SshConnection {
    /// Reserve a session slot for max-sessions accounting. Idempotent once held.
    pub(super) fn try_acquire_session_slot(&mut self) -> bool {
        if self.session_slot.is_some() {
            return true;
        }
        let max = self.opts.max_sessions.max(1);
        loop {
            let cur = self.active_sessions.load(Ordering::SeqCst);
            if cur >= max {
                return false;
            }
            if self
                .active_sessions
                .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                self.session_slot = Some(SessionSlot {
                    active: self.active_sessions.clone(),
                });
                return true;
            }
        }
    }

    /// Open a local shell in a PTY for `channel` and start pumping its output
    /// to the SSH channel. Idempotent per channel.
    pub(super) async fn ensure_shell(
        &mut self,
        channel: ChannelId,
        cols: u16,
        rows: u16,
        session: &mut Session,
    ) {
        if self.shells.contains_key(&channel) {
            return;
        }
        {
            let mut pending = self.pending_channels.lock().await;
            pending.remove(&channel);
        }

        let launch = crate::terminal::pty::resolve_shell(None);
        let mut args = launch.args;
        #[cfg(unix)]
        if self.opts.login_shell {
            // Prefer login shell so user rc files load (PATH, aliases, …).
            if !args.iter().any(|a| a == "-l" || a == "--login") {
                args.insert(0, "-l".to_string());
            }
        }
        // Client env is applied for exec via shell exports; interactive shells
        // inherit the server process environment (whitelist vars can be set by
        // the user in their login rc when loginShell is enabled).
        let cwd = Some(self.opts.root.display().to_string());

        let result = spawn_pty_command(cols, rows, &launch.program, &args, cwd.as_deref());
        let (handle, reader) = match result {
            Ok(t) => t,
            Err(e) => {
                self.log.line(format!("failed to open shell PTY: {}", e));
                let _ = session.handle().eof(channel).await;
                return;
            }
        };

        self.attach_pty_io(channel, handle, reader, session, "shell");
    }

    /// Run a one-shot command in a PTY (or pipe-like PTY) for `exec` requests.
    /// Returns false if the command could not be spawned.
    pub(super) async fn ensure_exec(
        &mut self,
        channel: ChannelId,
        command: &str,
        cols: u16,
        rows: u16,
        session: &mut Session,
    ) -> bool {
        if self.shells.contains_key(&channel) {
            return true;
        }
        {
            let mut pending = self.pending_channels.lock().await;
            pending.remove(&channel);
        }

        let command = apply_env_exports(command, &self.pending_env);
        let (program, args) = exec_command_launch(&command, self.opts.login_shell);
        let cwd = Some(self.opts.root.display().to_string());
        let result = spawn_pty_command(cols, rows, &program, &args, cwd.as_deref());
        let (handle, reader) = match result {
            Ok(t) => t,
            Err(e) => {
                self.log
                    .line(format!("failed to exec {:?}: {}", command, e));
                return false;
            }
        };
        self.attach_pty_io(channel, handle, reader, session, "exec");
        true
    }

    pub(super) fn attach_pty_io(
        &mut self,
        channel: ChannelId,
        handle: crate::terminal::pty::PtyHandle,
        mut reader: Box<dyn Read + Send>,
        session: &mut Session,
        kind: &'static str,
    ) {
        let crate::terminal::pty::PtyHandle {
            writer,
            mut child,
            master,
            ..
        } = handle;

        self.shells.insert(channel, ShellIo { writer, master });

        let handle = session.handle();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let cancel = self.cancel.clone();
        let log = self.log.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => {
                        let _ = handle.eof(channel).await;
                        let _ = handle.close(channel).await;
                        break;
                    }
                    maybe = rx.recv() => {
                        match maybe {
                            Some(chunk) => {
                                if handle.data(channel, chunk).await.is_err() {
                                    break;
                                }
                            }
                            None => {
                                let code = match child.wait() {
                                    Ok(status) => status.exit_code(),
                                    Err(_) => 0,
                                };
                                let _ = handle.exit_status_request(channel, code).await;
                                let _ = handle.eof(channel).await;
                                let _ = handle.close(channel).await;
                                break;
                            }
                        }
                    }
                }
            }
            log.line(format!("{} session closed", kind));
        });
    }
}

/// Build (program, args) for an SSH `exec` request using the platform default shell.
pub(super) fn exec_command_launch(command: &str, login_shell: bool) -> (String, Vec<String>) {
    let launch = crate::terminal::pty::resolve_shell(None);
    let program = launch.program;
    let _lower = program.to_ascii_lowercase();

    #[cfg(windows)]
    {
        let _ = login_shell;
        if _lower.contains("pwsh") || _lower.contains("powershell") {
            let mut args = launch.args;
            args.extend([
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                command.to_string(),
            ]);
            return (program, args);
        }
        // cmd.exe style
        let mut args = launch.args;
        if args.is_empty() {
            args.push("/C".into());
        } else if !args.iter().any(|a| a.eq_ignore_ascii_case("/c")) {
            args.push("/C".into());
        }
        args.push(command.to_string());
        return (program, args);
    }

    #[cfg(unix)]
    {
        let mut args = launch.args;
        let flag = if login_shell { "-lc" } else { "-c" };
        args.push(flag.into());
        args.push(command.to_string());
        (program, args)
    }

    #[cfg(not(any(windows, unix)))]
    {
        let _ = login_shell;
        (program, vec![command.to_string()])
    }
}

/// Spawn a PTY-backed process at optional `cwd`.
pub(super) fn spawn_pty_command(
    cols: u16,
    rows: u16,
    program: &str,
    args: &[String],
    cwd: Option<&str>,
) -> Result<(crate::terminal::pty::PtyHandle, Box<dyn Read + Send>), String> {
    if let Some(dir) = cwd {
        crate::terminal::pty::create_pty(
            cols,
            rows,
            Some(program.to_string()),
            Some(args.to_vec()),
            Some(dir.to_string()),
        )
        .map(|(h, r, _)| (h, r))
    } else {
        crate::terminal::pty::create_command_pty(cols, rows, program, args)
    }
}

/// Prefix a shell command with `export KEY=VAL;` for accepted env vars (Unix-ish shells).
pub(super) fn apply_env_exports(command: &str, env: &HashMap<String, String>) -> String {
    if env.is_empty() {
        return command.to_string();
    }
    let mut prefix = String::new();
    for (k, v) in env {
        // Minimal quoting for double-quoted values.
        let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
        prefix.push_str(&format!("export {}=\"{}\"; ", k, escaped));
    }
    prefix.push_str(command);
    prefix
}
