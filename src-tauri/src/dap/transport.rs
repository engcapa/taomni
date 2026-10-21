use super::adapter::DapTransport;

/// A spawned adapter: the child to retain plus its stderr pipe, which
/// MUST be drained (see [`run_stderr_pump`]).
pub(super) type AdapterChild = (tokio::process::Child, Option<tokio::process::ChildStderr>);

/// Establish the read/write streams for a transport (spawn a process or connect
/// a socket). Returns the reader, the writer, and — for stdio — the child.
pub(super) async fn connect_transport(
    transport: &DapTransport,
) -> Result<
    (
        Box<dyn tokio::io::AsyncRead + Send + Unpin>,
        Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
        Option<AdapterChild>,
    ),
    String,
> {
    match transport {
        DapTransport::Stdio { command, args, cwd } => {
            let mut cmd = tokio::process::Command::new(command);
            cmd.args(args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            if let Some(cwd) = cwd {
                cmd.current_dir(cwd);
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("failed to start debug adapter `{command}`: {e}"))?;
            let stdout = child.stdout.take().ok_or("adapter has no stdout")?;
            let stdin = child.stdin.take().ok_or("adapter has no stdin")?;
            let stderr = child.stderr.take();
            Ok((Box::new(stdout), Box::new(stdin), Some((child, stderr))))
        }
        DapTransport::Tcp { host, port } => {
            let stream = tokio::net::TcpStream::connect((host.as_str(), *port))
                .await
                .map_err(|e| format!("failed to connect to debug adapter {host}:{port}: {e}"))?;
            let (read, write) = stream.into_split();
            Ok((Box::new(read), Box::new(write), None))
        }
        DapTransport::ManagedTcp {
            command,
            args,
            cwd,
            host,
            ready_timeout_ms,
        } => {
            let listener = tokio::net::TcpListener::bind((host.as_str(), 0))
                .await
                .map_err(|error| format!("failed to allocate a debug adapter port: {error}"))?;
            let port = listener
                .local_addr()
                .map_err(|error| format!("failed to inspect debug adapter port: {error}"))?
                .port();
            drop(listener);
            let resolved_args = args
                .iter()
                .map(|arg| arg.replace("${port}", &port.to_string()))
                .collect::<Vec<_>>();
            let mut process = tokio::process::Command::new(command);
            process
                .args(&resolved_args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            if let Some(cwd) = cwd {
                process.current_dir(cwd);
            }
            let mut child = process.spawn().map_err(|error| {
                format!("failed to start managed debug adapter `{command}`: {error}")
            })?;
            let stderr = child.stderr.take();
            let deadline =
                tokio::time::Instant::now() + std::time::Duration::from_millis(*ready_timeout_ms);
            loop {
                match tokio::net::TcpStream::connect((host.as_str(), port)).await {
                    Ok(stream) => {
                        let (read, write) = stream.into_split();
                        break Ok((Box::new(read), Box::new(write), Some((child, stderr))));
                    }
                    Err(error) if tokio::time::Instant::now() >= deadline => {
                        let _ = child.start_kill();
                        break Err(format!(
                            "debug adapter `{command}` did not listen on {host}:{port} within {ready_timeout_ms}ms: {error}"
                        ));
                    }
                    Err(_) => {
                        if let Some(status) = child.try_wait().map_err(|error| {
                            format!("failed to inspect debug adapter `{command}`: {error}")
                        })? {
                            break Err(format!(
                                "debug adapter `{command}` exited with {status} before listening on {host}:{port}"
                            ));
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }
}
