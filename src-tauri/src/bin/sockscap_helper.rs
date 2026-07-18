//! sockscap-helper — elevated Windows capture helper (plan §4.1 PrivilegedHelper).
//!
//! Owns WinDivert only; never holds proxy/SSH secrets. Launched with UAC from
//! the non-elevated main process.
//!
//! Usage:
//!   sockscap-helper.exe --control-port <port> [--resources <dir>]
//!
//! Connects back to 127.0.0.1:<port> (JSON-lines AppToHelper / HelperToApp).

#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(not(windows))]
fn main() {
    eprintln!("sockscap-helper is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    if let Err(e) = run() {
        eprintln!("sockscap-helper error: {e}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn run() -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    use taomni_lib::sockscap::helper::{
        evaluate_handshake, AppToHelper, HandshakeOutcome, HeartbeatMonitor, HelperToApp,
        ProcessFilterSpec, HELPER_PROTOCOL_VERSION,
    };
    use taomni_lib::sockscap::windivert::{ProcessFilter, WinDivertEngine};
    use taomni_lib::sockscap::windows_install::{
        ensure_windivert_installed, find_bundled_windivert, is_process_elevated,
    };

    let mut control_port: u16 = 0;
    let mut resources: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--control-port" => {
                control_port = args
                    .next()
                    .ok_or("--control-port requires a value")?
                    .parse()
                    .map_err(|e| format!("bad port: {e}"))?;
            }
            "--resources" => {
                resources = Some(PathBuf::from(
                    args.next().ok_or("--resources requires a value")?,
                ));
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }
    if control_port == 0 {
        return Err("usage: sockscap-helper --control-port <port> [--resources <dir>]".into());
    }
    if !is_process_elevated() {
        return Err("sockscap-helper must run elevated (UAC from Taomni)".into());
    }

    let bundle = resources
        .as_deref()
        .and_then(|r| find_bundled_windivert(Some(r)))
        .or_else(|| find_bundled_windivert(None))
        .ok_or_else(|| "WinDivert bundle not found".to_string())?;
    ensure_windivert_installed(&bundle)?;

    // Connect back to the main process control socket.
    let stream = TcpStream::connect(("127.0.0.1", control_port))
        .map_err(|e| format!("connect control port {control_port}: {e}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .ok();
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(30)))
        .ok();
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut writer = stream;

    let engine: Arc<Mutex<Option<WinDivertEngine>>> = Arc::new(Mutex::new(None));
    let mut authed = false;
    let mut hb = HeartbeatMonitor::new(20_000, now_ms());

    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                eprintln!("sockscap-helper: read error: {e}");
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: AppToHelper = match serde_json::from_str(trimmed) {
            Ok(m) => m,
            Err(e) => {
                let _ = write_msg(
                    &mut writer,
                    &HelperToApp::Error {
                        message: format!("bad json: {e}"),
                    },
                );
                continue;
            }
        };

        if matches!(msg, AppToHelper::Heartbeat { .. }) || authed {
            hb.on_heartbeat(now_ms());
        }
        if authed && hb.is_expired(now_ms()) {
            eprintln!("sockscap-helper: heartbeat expired — fail open");
            break;
        }

        let reply = match msg {
            AppToHelper::Hello {
                protocol_version,
                caller_token,
            } => match evaluate_handshake(protocol_version, &caller_token, true) {
                HandshakeOutcome::Accept => {
                    authed = true;
                    HelperToApp::Welcome {
                        protocol_version: HELPER_PROTOCOL_VERSION,
                    }
                }
                HandshakeOutcome::Reject(reason) => HelperToApp::Rejected { reason },
            },
            AppToHelper::Heartbeat { seq } => {
                if !authed {
                    HelperToApp::Rejected {
                        reason: "not authenticated".into(),
                    }
                } else {
                    HelperToApp::HeartbeatAck { seq }
                }
            }
            AppToHelper::InstallCapture {
                plan_id,
                listen_port,
                filter,
                windivert_dir,
            } => {
                if !authed {
                    HelperToApp::Rejected {
                        reason: "not authenticated".into(),
                    }
                } else {
                    if let Ok(mut g) = engine.lock() {
                        if let Some(e) = g.take() {
                            e.stop();
                        }
                    }
                    let dir = PathBuf::from(&windivert_dir);
                    let pf = match filter {
                        ProcessFilterSpec::All => ProcessFilter::All,
                        ProcessFilterSpec::Executables { paths } => ProcessFilter::Executables(
                            paths
                                .into_iter()
                                .map(|p| p.replace('/', "\\").to_ascii_lowercase())
                                .collect(),
                        ),
                        ProcessFilterSpec::Pids { pids } => {
                            ProcessFilter::Pids(pids.into_iter().collect())
                        }
                    };
                    match WinDivertEngine::start(listen_port, Some(&dir), pf) {
                        Ok(eng) => {
                            *engine.lock().unwrap() = Some(eng);
                            HelperToApp::Installed { plan_id }
                        }
                        Err(e) => HelperToApp::Error {
                            message: format!("WinDivert start failed: {e}"),
                        },
                    }
                }
            }
            AppToHelper::RevokeCapture => {
                if let Ok(mut g) = engine.lock() {
                    if let Some(e) = g.take() {
                        e.stop();
                    }
                }
                HelperToApp::Revoked
            }
            AppToHelper::LookupConntrack { sport } => {
                if let Ok(g) = engine.lock() {
                    if let Some(eng) = g.as_ref() {
                        if let Some(info) = eng.conntrack.lock().unwrap().get(&sport).cloned() {
                            HelperToApp::ConntrackHit {
                                sport,
                                dst: info.dst.to_string(),
                                dport: info.dport,
                                pid: info.pid,
                                exe: info.exe,
                            }
                        } else {
                            HelperToApp::ConntrackMiss { sport }
                        }
                    } else {
                        HelperToApp::ConntrackMiss { sport }
                    }
                } else {
                    HelperToApp::ConntrackMiss { sport }
                }
            }
            AppToHelper::Shutdown => {
                let _ = write_msg(&mut writer, &HelperToApp::Revoked);
                break;
            }
        };

        if let Err(e) = write_msg(&mut writer, &reply) {
            eprintln!("sockscap-helper: write error: {e}");
            break;
        }
        if matches!(reply, HelperToApp::Rejected { .. }) && !authed {
            break;
        }
    }

    if let Ok(mut g) = engine.lock() {
        if let Some(e) = g.take() {
            e.stop();
        }
    }
    eprintln!("sockscap-helper: exit (fail-open)");
    Ok(())
}

#[cfg(windows)]
fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn write_msg(
    w: &mut impl std::io::Write,
    msg: &taomni_lib::sockscap::helper::HelperToApp,
) -> Result<(), String> {
    let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    line.push('\n');
    w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}
