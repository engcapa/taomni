//! OpenSSH owns GSSAPI authentication using the current OS ticket cache. It is
//! isolated from password authentication: a failed ticket never downgrades auth.
use crate::database::forward::{self, ForwardGuard};
use crate::terminal::network::NetworkSettings;
use std::pin::Pin;
use std::process::Stdio;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::process::{Child, Command};

pub(crate) struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub route: ForwardGuard,
}

fn executable() -> Result<String, String> {
    // Use a GSSAPI-enabled OpenSSH installation. On Windows this can be the
    // enterprise/Cygwin client added to PATH; Microsoft's inbox build may not
    // include GSSAPI and reports an actionable unsupported-option error.
    which::which("ssh")
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| "GSSAPI requires a GSSAPI-enabled OpenSSH client (ssh) on PATH".into())
}

fn proxy_command(port: u16) -> Result<String, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = executable.to_string_lossy();
    #[cfg(windows)]
    let quoted = format!("\"{}\"", path.replace('%', "%%"));
    #[cfg(not(windows))]
    let quoted = format!("'{}'", path.replace('\'', "'\\''").replace('%', "%%"));
    Ok(format!("{quoted} --ssh-stdio-forward {port}"))
}

pub(crate) async fn launch(
    host: &str,
    port: u16,
    username: &str,
    network: Option<&NetworkSettings>,
) -> Result<Launch, String> {
    if host.trim().is_empty()
        || host.starts_with('-')
        || host.chars().any(char::is_control)
        || username.chars().any(char::is_control)
    {
        return Err("Invalid GSSAPI SSH host or user".into());
    }
    let mut args = vec![
        "-F".into(),
        "none".into(),
        "-oBatchMode=yes".into(),
        "-oPreferredAuthentications=gssapi-with-mic".into(),
        "-oGSSAPIAuthentication=yes".into(),
        "-oGSSAPIDelegateCredentials=no".into(),
        "-oPasswordAuthentication=no".into(),
        "-oPubkeyAuthentication=no".into(),
        "-oKbdInteractiveAuthentication=no".into(),
        "-oStrictHostKeyChecking=accept-new".into(),
        "-oConnectTimeout=15".into(),
        "-oConnectionAttempts=1".into(),
        "-p".into(),
        port.to_string(),
        "-l".into(),
        username.into(),
    ];
    let mut route = ForwardGuard(None);
    if let Some(net) = network {
        if net.compression {
            args.push("-C".into());
        }
        if net.keep_alive && net.keep_alive_interval_secs > 0 {
            args.push(format!(
                "-oServerAliveInterval={}",
                net.keep_alive_interval_secs
            ));
            args.push("-oServerAliveCountMax=3".into());
        }
        if net.ip_version == "ipv4" {
            args.push("-4".into());
        }
        if net.ip_version == "ipv6" {
            args.push("-6".into());
        }
        if let Some(expert) = &net.ssh_expert {
            for (option, value) in [
                ("KexAlgorithms", &expert.kex),
                ("Ciphers", &expert.cipher),
                ("MACs", &expert.mac),
            ] {
                if !value.trim().is_empty() {
                    args.push(format!("-o{option}={}", value.trim()));
                }
            }
        }
        if !matches!(net.proxy_kind.as_str(), "" | "none") {
            let forward = forward::start(host.into(), port, net.clone()).await?;
            args.push(format!(
                "-oProxyCommand={}",
                proxy_command(forward.local_port)?
            ));
            route.0 = Some(forward.task);
        }
    }
    args.push(host.into());
    Ok(Launch {
        program: executable()?,
        args,
        route,
    })
}

pub(crate) async fn probe(
    host: &str,
    port: u16,
    username: &str,
    network: Option<&NetworkSettings>,
) -> Result<String, String> {
    let launch = launch(host, port, username, network).await?;
    let mut command = Command::new(&launch.program);
    command
        .args(&launch.args)
        .arg("true")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(25), command.output())
        .await
        .map_err(|_| "GSSAPI authentication timed out")?
        .map_err(|e| format!("Start OpenSSH: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "GSSAPI authentication failed. Obtain a Kerberos ticket and check the OpenSSH client: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok("SSH GSSAPI connection OK".into())
}

/// Own the process and proxy route until SFTP closes; child pipes implement
/// the async byte stream expected by russh-sftp without changing its protocol.
pub(crate) struct Subsystem {
    child: Child,
    input: tokio::process::ChildStdin,
    output: tokio::process::ChildStdout,
    _route: ForwardGuard,
}
impl Drop for Subsystem {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
impl AsyncRead for Subsystem {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().output).poll_read(cx, buf)
    }
}
impl AsyncWrite for Subsystem {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.get_mut().input).poll_write(cx, data)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().input).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().input).poll_shutdown(cx)
    }
}

pub(crate) async fn subsystem(
    host: &str,
    port: u16,
    username: &str,
    network: Option<&NetworkSettings>,
) -> Result<Subsystem, String> {
    exec_stream(host, port, username, network, "sftp", true).await
}

pub(crate) async fn exec_stream(
    host: &str,
    port: u16,
    username: &str,
    network: Option<&NetworkSettings>,
    command: &str,
    subsystem: bool,
) -> Result<Subsystem, String> {
    let mut launch = launch(host, port, username, network).await?;
    // Options precede the destination. -s tells ssh to request a subsystem.
    if subsystem {
        launch.args.insert(0, "-s".into());
    }
    let mut child = Command::new(&launch.program)
        .args(&launch.args)
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Start GSSAPI SFTP: {e}"))?;
    let input = child.stdin.take().ok_or("OpenSSH stdin unavailable")?;
    let output = child.stdout.take().ok_or("OpenSSH stdout unavailable")?;
    Ok(Subsystem {
        child,
        input,
        output,
        _route: launch.route,
    })
}

/// OpenSSH ProxyCommand helper. Only loopback is accepted; the parent owns the
/// authenticated upstream route. This path never initializes the desktop app.
pub fn stdio_forward() -> i32 {
    let result = (|| -> std::io::Result<()> {
        let port: u16 = std::env::args()
            .nth(2)
            .ok_or(std::io::ErrorKind::InvalidInput)?
            .parse()
            .map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let mut stream = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))?;
        let mut writer = stream.try_clone()?;
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut writer);
            let _ = writer.shutdown(std::net::Shutdown::Write);
        });
        std::io::copy(&mut stream, &mut std::io::stdout().lock())?;
        Ok(())
    })();
    if result.is_ok() { 0 } else { 1 }
}
