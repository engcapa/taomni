use super::*;

/// Packaged Windows builds use the GUI subsystem and have no parent console.
/// Every language-server command, including custom commands, is background
/// infrastructure and must not allocate a transient console window.
pub(super) fn no_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

pub(super) fn initialize_timeout_secs(command: &LspServerCommandPreset) -> u64 {
    let id = command.id.to_ascii_lowercase();
    let prog = command.command.to_ascii_lowercase();
    if id == "jdtls" || prog.contains("jdtls") {
        JDTLS_INITIALIZE_TIMEOUT_SECS
    } else {
        INITIALIZE_TIMEOUT_SECS
    }
}

pub(super) fn workspace_client_capabilities() -> Value {
    json!({
        "applyEdit": true,
        "workspaceEdit": {
            "documentChanges": true,
            "resourceOperations": ["create", "rename", "delete"],
            "failureHandling": "abort",
            "changeAnnotationSupport": {
                "groupsOnLabel": false
            }
        },
        "workspaceFolders": true,
        "configuration": true,
        "diagnostics": {
            "refreshSupport": true,
            "relatedDocumentSupport": true
        },
        "fileOperations": {
            "dynamicRegistration": true,
            "didCreate": true,
            "willCreate": true,
            "didRename": true,
            "willRename": true,
            "didDelete": true,
            "willDelete": true
        },
        "didChangeWatchedFiles": {
            "dynamicRegistration": true
        },
        "symbol": {
            "dynamicRegistration": true,
            "resolveSupport": {
                "properties": ["location.range"]
            }
        }
    })
}

/// Build a process command for an LSP server binary.
///
/// On Windows:
/// - Prefer launching Eclipse JDT LS via `java -jar` so stdio is not mediated by
///   `cmd.exe` / `jdtls.cmd` (which often leaves the session stuck mid-start).
/// - Other `.cmd`/`.bat` shims (npm globals) go through `cmd.exe /D /S /C` with a
///   single properly-quoted command line after resolving the absolute path.
pub(super) fn build_lsp_server_command(
    program: &str,
    args: &[String],
    workspace_root: &Path,
    tooling_java_home: Option<&Path>,
    tooling_java_error: Option<&str>,
) -> Result<Command, String> {
    let program = program.trim();
    #[cfg(windows)]
    {
        let resolved = resolve_server_program(program);
        if is_jdtls_program(program, &resolved) {
            // Always expand jdtls ourselves. Falling back to jdtls.cmd hides
            // actionable errors (wrong JDK, missing config) as plain
            // "stdout closed" and reintroduces the cmd.exe stdio problems.
            return build_jdtls_java_command(
                &resolved,
                args,
                workspace_root,
                tooling_java_home,
                tooling_java_error,
            );
        }
        let is_batch = resolved
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
        if is_batch {
            let mut cmd = Command::new("cmd.exe");
            // /D skips AutoRun; /S keeps the quoted command line intact so paths
            // with spaces (and trailing args) reach the batch file correctly.
            cmd.arg("/D")
                .arg("/S")
                .arg("/C")
                .arg(windows_cmd_line(&resolved, args));
            return Ok(cmd);
        }
        let mut cmd = Command::new(&resolved);
        cmd.args(args);
        return Ok(cmd);
    }
    #[cfg(not(windows))]
    {
        let _ = (tooling_java_home, tooling_java_error);
        let mut cmd = Command::new(program);
        // For the jdtls wrapper, pin `-data` to our managed per-workspace index dir
        // (unless the caller already passed one) so the index location is ours to
        // control and prune — matching the Windows launch path. The wrapper forwards
        // unknown args straight to the Equinox launcher, and `-data` is exactly what
        // upstream jdtls.py appends.
        let resolved = which::which(program).unwrap_or_else(|_| PathBuf::from(program));
        if is_jdtls_program(program, &resolved)
            && !args.iter().any(|arg| arg == "-data" || arg == "--data")
        {
            let data_dir = jdtls_data_dir(workspace_root);
            ensure_jdtls_data_dir(&data_dir, workspace_root)?;
            cmd.args(args);
            cmd.arg("-data");
            cmd.arg(&data_dir);
            log::info!(
                "lsp: launching jdtls wrapper {program} with -data {}",
                data_dir.display()
            );
        } else {
            let _ = workspace_root;
            cmd.args(args);
        }
        Ok(cmd)
    }
}

pub(super) async fn read_stdout(
    session: Arc<LspSession>,
    stdout: ChildStdout,
    sessions: LspSessionRegistry,
    last_errors: LspLastErrorRegistry,
    map_key: String,
) {
    let mut reader = BufReader::new(stdout);
    let reason = 'messages: loop {
        let mut content_length = None;
        loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) => {
                    let exit = {
                        let mut child = session.child.lock().await;
                        match child.try_wait() {
                            Ok(Some(status)) => format!(" (exit {status})"),
                            _ => String::new(),
                        }
                    };
                    break 'messages format!("language server stdout closed{exit}");
                }
                Ok(_) => {
                    if line == b"\r\n" || line == b"\n" {
                        break;
                    }
                    if let Ok(header) = std::str::from_utf8(&line) {
                        let trimmed = header.trim();
                        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
                            content_length = value.trim().parse::<usize>().ok();
                        }
                    }
                }
                Err(e) => {
                    break 'messages format!("language server stdout read failed: {e}");
                }
            }
        }
        let Some(len) = content_length else {
            break "language server response missing Content-Length".to_string();
        };
        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            break format!("language server response body read failed: {e}");
        }
        match serde_json::from_slice::<Value>(&body) {
            Ok(message) => session.handle_message(message).await,
            Err(e) => log::warn!("lsp: invalid JSON from {}: {e}", session.command.command),
        }
    };
    let expected_shutdown = session.shutting_down.load(Ordering::SeqCst);
    let reason = if let Some(stderr) = session.stderr_snippet().await {
        format!("{reason} ({stderr})")
    } else {
        reason
    };
    if expected_shutdown {
        session.fail_pending(&reason).await;
    } else {
        session.abort(&reason).await;
        last_errors
            .lock()
            .await
            .insert(map_key.clone(), reason.clone());
    }
    remove_exited_session(&sessions, &map_key, &session).await;
    if expected_shutdown {
        log::debug!("lsp:{}: {reason}", session.command.command);
    } else {
        log::warn!("lsp:{}: {reason}", session.command.command);
    }
}

pub(super) async fn remove_exited_session(
    sessions: &LspSessionRegistry,
    map_key: &str,
    session: &Arc<LspSession>,
) {
    let mut sessions = sessions.lock().await;
    let is_current = matches!(
        sessions.get(map_key),
        Some(LspSessionEntry::Ready(current)) if Arc::ptr_eq(current, session)
    );
    if is_current {
        sessions.remove(map_key);
    }
}

pub(super) async fn read_stderr(session: Arc<LspSession>, stderr: ChildStderr) {
    let command = session.command.command.clone();
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                log::debug!("lsp:{command}: {line}");
                let mut tail = session.stderr_tail.lock().await;
                if !tail.is_empty() {
                    tail.push('\n');
                }
                tail.push_str(&line);
                // Cap memory if a server spams stderr.
                const MAX: usize = 8_192;
                let len = tail.len();
                if len > MAX {
                    *tail = tail[len - MAX..].to_string();
                }
            }
            Ok(None) => return,
            Err(e) => {
                log::debug!("lsp:{command}: stderr read failed: {e}");
                return;
            }
        }
    }
}
