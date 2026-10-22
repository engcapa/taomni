use super::handler::CcHandler;
use super::model::TokenScope;
use super::parameters::ReadCaptureParams;
use super::scope::resolve_backend_session_id;
use rmcp::ErrorData;
use rmcp::model::CallToolResult;
use rmcp::model::Content;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

/// Hard wall-clock cap on a single captured run (方案4). Kept below the CC
/// idle-reaper's in-flight ceiling (`process::TOOL_WAIT_CEILING_SECS` = 960) so
/// the capture's own timeout fires first and the CC process is never reaped
/// mid-capture.
pub(super) const CAPTURE_TIMEOUT_SECS: u64 = 900;

/// Map `read_capture` params onto a typed reduction op, validating presence of
/// the fields each op needs.
pub(super) fn parse_reduce_op(
    p: &ReadCaptureParams,
) -> Result<crate::agent::capture::reduce::ReduceOp, String> {
    use crate::agent::capture::reduce::ReduceOp;
    match p.op.as_str() {
        "head" => Ok(ReduceOp::Head {
            n: p.n.unwrap_or(50) as usize,
        }),
        "tail" => Ok(ReduceOp::Tail {
            n: p.n.unwrap_or(50) as usize,
        }),
        "range" => {
            let start = p.start.ok_or("range requires `start`")? as usize;
            let end = p.end.ok_or("range requires `end`")? as usize;
            Ok(ReduceOp::Range { start, end })
        }
        "grep" => Ok(ReduceOp::Grep {
            pattern: p.pattern.clone().ok_or("grep requires `pattern`")?,
            context: p.context.unwrap_or(0) as usize,
        }),
        "jq" => Ok(ReduceOp::Jq {
            filter: p.filter.clone().ok_or("jq requires `filter`")?,
        }),
        "stats" => Ok(ReduceOp::Stats),
        other => Err(format!(
            "unknown op '{other}' (expected head|tail|range|grep|jq|stats)"
        )),
    }
}

/// Append the reduction's note / truncation receipt to its text for CC.
pub(super) fn annotate_reduce(r: crate::agent::capture::reduce::ReduceResult) -> String {
    let mut text = r.text;
    if let Some(note) = r.note {
        text.push_str(&format!("\n[{note}]"));
    }
    if r.truncated {
        text.push_str("\n[output clipped by read_capture cap — narrow with grep/range]");
    }
    text
}

/// Build the bounded `run_captured` summary (shared by B and C paths).
pub(super) fn capture_summary(
    id: &str,
    status: crate::agent::capture::CaptureStatus,
    rc: Option<i32>,
    lines: u64,
    bytes: u64,
    truncated: bool,
    head: &str,
    tail: &str,
) -> String {
    format!(
        "[capture {id}] status={status:?} exit={exit} lines={lines} bytes≈{bytes} truncated={trunc}\n\
         --- head {h} ---\n{head}--- tail {t} ---\n{tail}\
         提示：完整输出已捕获。用 read_capture(capture_id=\"{id}\", op=\"grep|head|tail|range|jq|stats\", …) 按需检索，不要重跑命令。",
        exit = rc.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
        trunc = truncated,
        h = crate::agent::capture::SUMMARY_HEAD,
        t = crate::agent::capture::SUMMARY_TAIL,
    )
}

impl CcHandler {
    /// Run a command on the bound host capturing its full output (方案4), then
    /// return only a bounded summary. `reflect_session=false` → B path
    /// (independent channel, Taomni-local file); `true` → C path (live
    /// interactive session, remote temp file, POSIX SSH only). Blocks with
    /// progress events + a hard timeout; cancellable via `cc_cancel_capture`.
    pub(super) async fn run_captured_impl(
        &self,
        scope: &TokenScope,
        command: &str,
        reflect_session: bool,
        session_id: Option<String>,
    ) -> Result<CallToolResult, ErrorData> {
        use crate::agent::capture::{CaptureSource, CaptureStatus, exec_b, exec_c};
        use crate::terminal::ActiveTerminal;

        let sid = session_id
            .or_else(|| scope.allowed_session_id.clone())
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    "run_captured requires a bound terminal session".to_string(),
                    None,
                )
            })?;
        let state = self.app_state();

        if state.agent.captures.running_count(&scope.thread_id) >= 2 {
            return Err(ErrorData::internal_error(
                "too many captures already running for this thread; retry shortly".to_string(),
                None,
            ));
        }

        // Clone connection handles out of the terminals map so we don't hold its
        // lock across a possibly-minutes-long run.
        type SshHandle = Arc<russh::client::Handle<crate::terminal::ssh::SshHandler>>;
        type SshWrite = Arc<tokio::sync::Mutex<russh::ChannelWriteHalf<russh::client::Msg>>>;
        enum Target {
            Ssh(SshHandle, SshWrite),
            Local,
        }
        let target = {
            // `sid` is a tab id (token scope / fill_session_id). `state.terminal.terminals`
            // is keyed by the backend session id, so translate before lookup —
            // otherwise this always misses and reports a live terminal as dead.
            let backend_sid = resolve_backend_session_id(&state, &sid);
            let terms = state.terminal.terminals.read().await;
            match terms.get(&backend_sid) {
                Some(ActiveTerminal::Ssh {
                    handle, channel, ..
                }) => Target::Ssh(handle.clone(), channel.clone()),
                Some(ActiveTerminal::Local { .. }) => Target::Local,
                None => {
                    return Err(ErrorData::invalid_params(
                        format!("no live terminal for session {sid}"),
                        None,
                    ));
                }
            }
        };

        let cwd = state
            .agent
            .agent_thread_cwd
            .lock()
            .unwrap()
            .get(&scope.thread_id)
            .cloned();

        // Shared live counts (C reads these for the final tally; B reads the
        // writer). The progress closure also emits to the UI.
        let counts = Arc::new(std::sync::Mutex::new((0u64, 0u64)));
        let app = self.app.clone();
        let cap_thread = scope.thread_id.clone();
        let counts_cb = counts.clone();
        let make_progress = move |cap_id: String| {
            let app = app.clone();
            let thread = cap_thread.clone();
            let counts = counts_cb.clone();
            move |lines: u64, bytes: u64| {
                *counts.lock().unwrap() = (lines, bytes);
                let _ = app.emit(
                    "agent-cc-capture-progress",
                    serde_json::json!({
                        "captureId": cap_id, "threadId": thread, "lines": lines, "bytes": bytes,
                    }),
                );
            }
        };

        let cancel = Arc::new(tokio::sync::Notify::new());

        // ---- C path: in-session, remote temp file (POSIX SSH only) ---------
        if reflect_session {
            let (handle, write_half) = match target {
                Target::Ssh(h, w) => (h, w),
                Target::Local => {
                    return Err(ErrorData::invalid_params(
                        "reflect_session=true is only available for remote SSH sessions; \
                         use reflect_session=false here"
                            .to_string(),
                        None,
                    ));
                }
            };
            let meta = state.agent.captures.begin(
                &scope.thread_id,
                command,
                CaptureSource::RemoteFile {
                    session_id: sid.clone(),
                    path: String::new(),
                    family: crate::agent::capture::ShellFamily::Posix,
                },
            );
            let (family, path) = exec_c::start_c_ssh(&handle, &write_half, command, &meta.id)
                .await
                .map_err(|e| {
                    state
                        .agent
                        .captures
                        .finish(&meta.id, CaptureStatus::Failed, None, 0, 0, false);
                    ErrorData::invalid_params(e, None)
                })?;
            state.agent.captures.set_source(
                &meta.id,
                CaptureSource::RemoteFile {
                    session_id: sid.clone(),
                    path: path.clone(),
                    family,
                },
            );
            state
                .agent
                .cc_capture_cancels
                .lock()
                .unwrap()
                .insert(meta.id.clone(), cancel.clone());

            let progress = make_progress(meta.id.clone());
            let marker = format!("__TAOMNI_END_{}", meta.id);
            let poll = exec_c::poll_c_ssh(
                &handle,
                &write_half,
                &path,
                &marker,
                cancel.clone(),
                progress,
            );
            let (status, rc) =
                match tokio::time::timeout(Duration::from_secs(CAPTURE_TIMEOUT_SECS), poll).await {
                    Ok(r) => r,
                    Err(_) => {
                        cancel.notify_waiters();
                        (CaptureStatus::TimedOut, None)
                    }
                };
            state
                .agent
                .cc_capture_cancels
                .lock()
                .unwrap()
                .remove(&meta.id);
            let (lines, bytes) = *counts.lock().unwrap();
            state
                .agent
                .captures
                .finish(&meta.id, status, rc, lines, bytes, false);
            self.emit_capture_end(&meta.id, &scope.thread_id, status, lines, bytes, rc, false);

            let head = exec_c::reduce_remote(
                &handle,
                family,
                &path,
                &meta.id,
                &crate::agent::capture::reduce::ReduceOp::Head {
                    n: crate::agent::capture::SUMMARY_HEAD,
                },
            )
            .await
            .map(|r| r.text)
            .unwrap_or_default();
            let tail = exec_c::reduce_remote(
                &handle,
                family,
                &path,
                &meta.id,
                &crate::agent::capture::reduce::ReduceOp::Tail {
                    n: crate::agent::capture::SUMMARY_TAIL,
                },
            )
            .await
            .map(|r| r.text)
            .unwrap_or_default();
            return Ok(CallToolResult::success(vec![Content::text(
                capture_summary(&meta.id, status, rc, lines, bytes, false, &head, &tail),
            )]));
        }

        // ---- B path: independent channel / local child, Taomni-local file --
        let dir = state.agent.captures.thread_dir(&scope.thread_id);
        let meta = state.agent.captures.begin(
            &scope.thread_id,
            command,
            CaptureSource::LocalFile(dir.join("placeholder")),
        );
        let writer = crate::agent::capture::CaptureWriter::create(&dir, &meta.id)
            .map_err(|e| ErrorData::internal_error(format!("capture file: {e}"), None))?;
        state
            .agent
            .captures
            .set_source(&meta.id, CaptureSource::LocalFile(writer.path()));
        state
            .agent
            .cc_capture_cancels
            .lock()
            .unwrap()
            .insert(meta.id.clone(), cancel.clone());

        let progress = make_progress(meta.id.clone());
        let run = async {
            match target {
                Target::Ssh(handle, _) => {
                    exec_b::run_ssh(
                        &handle,
                        command,
                        cwd.as_deref(),
                        &writer,
                        cancel.clone(),
                        progress,
                    )
                    .await
                }
                Target::Local => {
                    exec_b::run_local(command, cwd.as_deref(), &writer, cancel.clone(), progress)
                        .await
                }
            }
        };
        let outcome =
            match tokio::time::timeout(Duration::from_secs(CAPTURE_TIMEOUT_SECS), run).await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    state.agent.captures.finish(
                        &meta.id,
                        CaptureStatus::Failed,
                        None,
                        writer.lines(),
                        writer.bytes(),
                        writer.truncated(),
                    );
                    state
                        .agent
                        .cc_capture_cancels
                        .lock()
                        .unwrap()
                        .remove(&meta.id);
                    return Err(ErrorData::internal_error(e, None));
                }
                Err(_) => {
                    cancel.notify_waiters();
                    exec_b::ExecOutcome {
                        status: CaptureStatus::TimedOut,
                        exit_code: None,
                    }
                }
            };

        state
            .agent
            .cc_capture_cancels
            .lock()
            .unwrap()
            .remove(&meta.id);
        let truncated = writer.truncated();
        state.agent.captures.finish(
            &meta.id,
            outcome.status,
            outcome.exit_code,
            writer.lines(),
            writer.bytes(),
            truncated,
        );
        self.emit_capture_end(
            &meta.id,
            &scope.thread_id,
            outcome.status,
            writer.lines(),
            writer.bytes(),
            outcome.exit_code,
            truncated,
        );

        let path = writer.path();
        let head = crate::agent::capture::reduce::reduce_file(
            &path,
            &crate::agent::capture::reduce::ReduceOp::Head {
                n: crate::agent::capture::SUMMARY_HEAD,
            },
        )
        .map(|r| r.text)
        .unwrap_or_default();
        let tail = crate::agent::capture::reduce::reduce_file(
            &path,
            &crate::agent::capture::reduce::ReduceOp::Tail {
                n: crate::agent::capture::SUMMARY_TAIL,
            },
        )
        .map(|r| r.text)
        .unwrap_or_default();
        // Mirror this run into the bound terminal as a read-only trace (the B
        // path is otherwise invisible there). `sid` is the terminal tab id.
        self.emit_terminal_echo(
            &sid,
            &scope.thread_id,
            &meta.id,
            command,
            &head,
            Some(&path),
            outcome.status,
            writer.lines(),
            writer.bytes(),
            outcome.exit_code,
            truncated,
        );
        Ok(CallToolResult::success(vec![Content::text(
            capture_summary(
                &meta.id,
                outcome.status,
                outcome.exit_code,
                writer.lines(),
                writer.bytes(),
                truncated,
                &head,
                &tail,
            ),
        )]))
    }

    /// Emit the capture-end event so the UI progress card clears.
    pub(super) fn emit_capture_end(
        &self,
        id: &str,
        thread_id: &str,
        status: crate::agent::capture::CaptureStatus,
        lines: u64,
        bytes: u64,
        exit_code: Option<i32>,
        truncated: bool,
    ) {
        let _ = self.app.emit(
            "agent-cc-capture-end",
            serde_json::json!({
                "captureId": id, "threadId": thread_id,
                "status": format!("{status:?}"), "lines": lines, "bytes": bytes,
                "exitCode": exit_code, "truncated": truncated,
            }),
        );
    }

    /// Mirror a finished B-path captured run into its bound terminal as a
    /// read-only trace. The default `run_captured` path runs in an independent
    /// channel and is invisible in the live terminal; this event lets the
    /// frontend paint the command + a head of the output + stats into that
    /// terminal so the user sees what CC ran. `session_id` is the terminal *tab
    /// id* (the frontend registry key), not the backend session id. Not emitted
    /// for the C path (already visible via `tee`) or `run_in_terminal` (writes
    /// to the live session directly).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn emit_terminal_echo(
        &self,
        session_id: &str,
        thread_id: &str,
        capture_id: &str,
        command: &str,
        head: &str,
        capture_path: Option<&std::path::Path>,
        status: crate::agent::capture::CaptureStatus,
        lines: u64,
        bytes: u64,
        exit_code: Option<i32>,
        truncated: bool,
    ) {
        let capture_path = capture_path.map(|p| p.to_string_lossy().to_string());
        let _ = self.app.emit(
            "agent-cc-terminal-echo",
            serde_json::json!({
                "sessionId": session_id, "threadId": thread_id, "captureId": capture_id,
                "command": command, "head": head, "capturePath": capture_path,
                "status": format!("{status:?}"), "lines": lines, "bytes": bytes,
                "exitCode": exit_code, "truncated": truncated,
            }),
        );
    }

    /// Reduce a previously-captured output (方案4). Read-only, thread-scoped.
    pub(super) async fn read_capture_impl(
        &self,
        scope: &TokenScope,
        p: &ReadCaptureParams,
    ) -> Result<CallToolResult, ErrorData> {
        use crate::agent::capture::CaptureSource;
        let meta = self
            .app_state()
            .agent
            .captures
            .get_scoped(&scope.thread_id, &p.capture_id)
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    format!("no capture '{}' for this thread", p.capture_id),
                    None,
                )
            })?;
        let op = parse_reduce_op(p).map_err(|e| ErrorData::invalid_params(e, None))?;
        match &meta.source {
            CaptureSource::LocalFile(path) => {
                let r = crate::agent::capture::reduce::reduce_file(path, &op)
                    .map_err(|e| ErrorData::internal_error(e, None))?;
                Ok(CallToolResult::success(vec![Content::text(
                    annotate_reduce(r),
                )]))
            }
            CaptureSource::RemoteFile {
                session_id,
                path,
                family,
            } => {
                use crate::terminal::ActiveTerminal;
                // Re-resolve the SSH handle (the run may have been turns ago).
                // `session_id` is the tab id stored at capture time; translate to
                // the live backend session id (the connection — and its key — may
                // have changed across a reconnect since the capture ran).
                let st = self.app_state();
                let backend_sid = resolve_backend_session_id(&st, session_id);
                let handle = {
                    let terms = st.terminal.terminals.read().await;
                    match terms.get(&backend_sid) {
                        Some(ActiveTerminal::Ssh { handle, .. }) => handle.clone(),
                        _ => {
                            return Err(ErrorData::internal_error(
                                "the session backing this capture is no longer connected"
                                    .to_string(),
                                None,
                            ));
                        }
                    }
                };
                let r = crate::agent::capture::exec_c::reduce_remote(
                    &handle, *family, path, &meta.id, &op,
                )
                .await
                .map_err(|e| ErrorData::internal_error(e, None))?;
                Ok(CallToolResult::success(vec![Content::text(
                    annotate_reduce(r),
                )]))
            }
        }
    }
}
