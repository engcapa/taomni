//! Main-process client for elevated sockscap-helper (Windows).
//!
//! Control plane: main binds 127.0.0.1:0, UAC-launches helper with
//! `--control-port`, helper connects back. JSON-lines protocol.

#![cfg(windows)]

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::helper::{
    AppToHelper, HelperToApp, ProcessFilterSpec, HELPER_PROTOCOL_VERSION,
};
use super::windows_install::shell_execute_runas_status;

/// Client session to an elevated helper.
pub struct HelperClient {
    reader: Mutex<BufReader<TcpStream>>,
    writer: Mutex<TcpStream>,
}

impl HelperClient {
    pub fn find_helper_exe() -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("sockscap-helper.exe"));
                candidates.push(dir.join("sockscap-helper"));
                candidates.push(dir.join("sockscap-helper-x86_64-pc-windows-msvc.exe"));
            }
        }
        // `cargo tauri dev` / staged externalBin layouts.
        candidates.push(PathBuf::from("target/debug/sockscap-helper.exe"));
        candidates.push(PathBuf::from("target/release/sockscap-helper.exe"));
        candidates.push(PathBuf::from("src-tauri/target/debug/sockscap-helper.exe"));
        candidates.push(PathBuf::from("src-tauri/target/release/sockscap-helper.exe"));
        candidates.push(PathBuf::from(
            "binaries/sockscap-helper-x86_64-pc-windows-msvc.exe",
        ));
        candidates.push(PathBuf::from(
            "src-tauri/binaries/sockscap-helper-x86_64-pc-windows-msvc.exe",
        ));
        candidates.into_iter().find_map(|p| {
            if !p.exists() {
                return None;
            }
            // ShellExecute "runas" needs an absolute path; relative paths
            // resolve against System32 under elevation and fail silently.
            let abs = std::fs::canonicalize(&p).unwrap_or_else(|_| {
                if p.is_absolute() {
                    p
                } else {
                    std::env::current_dir()
                        .map(|cwd| cwd.join(&p))
                        .unwrap_or(p)
                }
            });
            Some(strip_verbatim_prefix(abs))
        })
    }

    /// Bind control socket, UAC-spawn helper, accept connection, handshake.
    pub fn spawn_elevated(resources: Option<&Path>) -> Result<HelperClient, String> {
        let helper = Self::find_helper_exe().ok_or_else(|| {
            "sockscap-helper.exe not found. Build with:\n  cargo build --bin sockscap-helper\n\
             then: scripts/stage-sockscap-helper.ps1\n\
             (or package it as a Tauri externalBin next to the main exe)"
                .to_string()
        })?;
        // Refuse placeholder staged files (a few dozen bytes of ASCII).
        if let Ok(meta) = std::fs::metadata(&helper) {
            if meta.len() < 1024 {
                return Err(format!(
                    "sockscap-helper at {} looks like a placeholder ({} bytes). \
                     Run: scripts/stage-sockscap-helper.ps1",
                    helper.display(),
                    meta.len()
                ));
            }
        }

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("bind control socket: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|e| e.to_string())?;

        let mut args = format!("--control-port {port}");
        if let Some(r) = resources {
            let res = std::fs::canonicalize(r).unwrap_or_else(|_| r.to_path_buf());
            args.push_str(&format!(" --resources \"{}\"", res.display()));
        }

        tracing::info!(
            "sockscap: elevating helper {} with {}",
            helper.display(),
            args
        );
        let status = shell_execute_runas_status(&helper.to_string_lossy(), &args)?;
        if status < 32 {
            return Err(format!(
                "UAC elevation for sockscap-helper failed (status {status}). \
                 Allow the prompt to enable transparent capture without elevating Taomni."
            ));
        }

        // Accept the helper connection (blocking with timeout).
        let stream = wait_accept(&listener, Duration::from_secs(60))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .ok();
        stream
            .set_write_timeout(Some(Duration::from_secs(30)))
            .ok();
        stream.set_nonblocking(false).ok();

        let reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let writer = stream;

        let mut client = HelperClient {
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
        };

        let welcome = client.roundtrip(&AppToHelper::Hello {
            protocol_version: HELPER_PROTOCOL_VERSION,
            caller_token: format!("taomni-pid-{}", std::process::id()),
        })?;
        match welcome {
            HelperToApp::Welcome { .. } => Ok(client),
            HelperToApp::Rejected { reason } => Err(format!("helper rejected handshake: {reason}")),
            other => Err(format!("unexpected handshake reply: {other:?}")),
        }
    }

    pub fn install_capture(
        &self,
        plan_id: &str,
        listen_port: u16,
        filter: ProcessFilterSpec,
        windivert_dir: &Path,
    ) -> Result<(), String> {
        let reply = self.roundtrip(&AppToHelper::InstallCapture {
            plan_id: plan_id.into(),
            listen_port,
            filter,
            windivert_dir: windivert_dir.to_string_lossy().into_owned(),
        })?;
        match reply {
            HelperToApp::Installed { .. } => Ok(()),
            HelperToApp::Error { message } => Err(message),
            other => Err(format!("unexpected install reply: {other:?}")),
        }
    }

    pub fn revoke_capture(&self) -> Result<(), String> {
        let reply = self.roundtrip(&AppToHelper::RevokeCapture)?;
        match reply {
            HelperToApp::Revoked | HelperToApp::Error { .. } => Ok(()),
            other => Err(format!("unexpected revoke reply: {other:?}")),
        }
    }

    pub fn lookup_conntrack(&self, sport: u16) -> Result<Option<ConntrackInfo>, String> {
        let reply = self.roundtrip(&AppToHelper::LookupConntrack { sport })?;
        match reply {
            HelperToApp::ConntrackHit {
                dst,
                dport,
                pid,
                exe,
                ..
            } => Ok(Some(ConntrackInfo {
                dst,
                dport,
                pid,
                exe,
            })),
            HelperToApp::ConntrackMiss { .. } => Ok(None),
            HelperToApp::Error { message } => Err(message),
            other => Err(format!("unexpected lookup reply: {other:?}")),
        }
    }

    pub fn heartbeat(&self, seq: u64) -> Result<(), String> {
        let reply = self.roundtrip(&AppToHelper::Heartbeat { seq })?;
        match reply {
            HelperToApp::HeartbeatAck { .. } => Ok(()),
            other => Err(format!("unexpected heartbeat reply: {other:?}")),
        }
    }

    pub fn shutdown(&self) {
        let _ = self.roundtrip(&AppToHelper::Shutdown);
    }

    fn roundtrip(&self, msg: &AppToHelper) -> Result<HelperToApp, String> {
        let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        line.push('\n');
        {
            let mut w = self.writer.lock().map_err(|_| "writer lock".to_string())?;
            w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            w.flush().map_err(|e| e.to_string())?;
        }
        let mut buf = String::new();
        {
            let mut r = self.reader.lock().map_err(|_| "reader lock".to_string())?;
            r.read_line(&mut buf).map_err(|e| e.to_string())?;
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            return Err("helper closed the control connection".into());
        }
        serde_json::from_str(trimmed).map_err(|e| format!("helper reply parse: {e} ({trimmed})"))
    }
}

impl Drop for HelperClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Debug, Clone)]
pub struct ConntrackInfo {
    pub dst: String,
    pub dport: u16,
    pub pid: Option<u32>,
    pub exe: Option<String>,
}

/// `fs::canonicalize` on Windows returns `\\?\C:\...` which ShellExecute can
/// reject; strip the verbatim prefix for elevation.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        // `\\?\UNC\server\share` → `\\server\share`
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path
}

fn wait_accept(listener: &TcpListener, timeout: Duration) -> Result<TcpStream, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((s, _)) => return Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(
                        "timed out waiting for sockscap-helper to connect (UAC cancelled?)"
                            .into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("accept helper: {e}")),
        }
    }
}
