use super::*;

#[tauri::command]
pub async fn sockscap_stats_snapshot(
    state: State<'_, AppState>,
) -> Result<stats::StatsSnapshot, String> {
    let orch = state.sockscap.orch.read().await;
    Ok(orch.stats_snapshot())
}

#[tauri::command]
pub async fn sockscap_list_processes() -> Result<Vec<process::ProcessInfo>, String> {
    process::list_processes()
}

/// Map a listening process's image name to a `(client_id, client_label)`.
///
/// Pure and case-insensitive so it unit-tests on any platform. Order matters:
/// more specific families (mihomo, Clash Verge) are matched before the generic
/// "clash" fallback. Returns `("unknown", "")` when nothing matches.
pub(crate) fn classify_client(process_name: &str) -> (String, String) {
    let n = process_name.to_ascii_lowercase();
    let hit = |id: &str, label: &str| (id.to_string(), label.to_string());
    if n.contains("mihomo") {
        hit("mihomo", "Mihomo")
    } else if n.contains("verge") {
        hit("clash", "Clash Verge")
    } else if n.contains("clash") {
        hit("clash", "Clash")
    } else if n.contains("sing-box") || n.contains("sing_box") || n.contains("singbox") {
        hit("sing-box", "sing-box")
    } else if n.contains("nekoray") || n.contains("nekobox") {
        hit("nekoray", "NekoRay")
    } else if n.contains("v2rayn") {
        hit("v2rayn", "v2rayN")
    } else if n.contains("qv2ray") {
        hit("qv2ray", "Qv2ray")
    } else if n.contains("hysteria") {
        hit("hysteria", "Hysteria")
    } else if n.contains("xray") {
        hit("xray", "Xray")
    } else if n.contains("v2ray") {
        hit("v2ray", "V2Ray")
    } else if n.contains("shadowsocks") || n.contains("ss-local") || n == "sslocal" {
        hit("shadowsocks", "Shadowsocks")
    } else {
        ("unknown".to_string(), String::new())
    }
}

/// Probe a loopback port: return Some("socks5"|"http") if it speaks one, else
/// None. Sends a SOCKS5 no-auth greeting; on a valid `05 xx` reply it's SOCKS5.
/// Otherwise tries an HTTP CONNECT and treats any HTTP status line as HTTP.
pub(super) async fn probe_local_proxy_kind(port: u16) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let connect = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        TcpStream::connect(addr),
    );
    let mut s = connect.await.ok()?.ok()?;
    // SOCKS5 greeting: VER=5, NMETHODS=1, METHOD=0 (no auth).
    if s.write_all(&[0x05, 0x01, 0x00]).await.is_ok() {
        let mut buf = [0u8; 2];
        if tokio::time::timeout(
            std::time::Duration::from_millis(300),
            s.read_exact(&mut buf),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .is_some()
            && buf[0] == 0x05
        {
            return Some("socks5".into());
        }
    }
    // Not SOCKS5 — try a fresh connection for an HTTP CONNECT probe.
    let mut s = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        TcpStream::connect(addr),
    )
    .await
    .ok()?
    .ok()?;
    let req = "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";
    s.write_all(req.as_bytes()).await.ok()?;
    let mut buf = [0u8; 16];
    let n = tokio::time::timeout(std::time::Duration::from_millis(300), s.read(&mut buf))
        .await
        .ok()?
        .ok()?;
    let head = String::from_utf8_lossy(&buf[..n]);
    if head.starts_with("HTTP/") {
        return Some("http".into());
    }
    None
}

/// Detect running local proxies to offer as one-click upstreams.
///
/// Two sources are merged so the UI can list *actual* running proxies rather
/// than only a fixed port table:
///  1. Every loopback/wildcard TCP listener owned by a recognized circumvention
///     client (Clash/sing-box/Mihomo/v2rayN/xray/…), on whatever port it chose —
///     this catches non-default ports the user configured.
///  2. The `COMMON_PROXY_PORTS` fallback, so a proxy whose owning process we
///     could not identify (or on a platform without pid resolution) is still
///     surfaced when it sits on a well-known port.
///
/// Each port that passes a lightweight SOCKS5/HTTP handshake becomes a
/// candidate carrying its detected kind, owning pid, process name, and client
/// family (for grouping). Probing is restricted to identified-client ports plus
/// the common table, so unrelated loopback listeners (dev servers, databases)
/// are not probed.
#[tauri::command]
pub async fn sockscap_detect_local_proxies() -> Result<Vec<LocalProxyCandidate>, String> {
    use std::collections::HashMap;

    let procs = process::list_processes().unwrap_or_default();
    // pid -> display name. Prefer the (original-case) name from list_processes
    // (Windows/Linux); fall back to process_image_name for platforms where
    // list_processes is empty (macOS) or a pid it did not include.
    let name_of = |pid: u32| -> String {
        procs
            .iter()
            .find(|p| p.pid == pid)
            .map(|p| p.name.clone())
            .filter(|s| !s.is_empty())
            .or_else(|| process::process_image_name(pid))
            .unwrap_or_default()
    };

    // Metadata for a port we know a process is listening on.
    struct PortMeta {
        pid: u32,
        process: String,
        client: String,
        client_label: String,
    }

    // Build port -> metadata from the loopback listener enumeration. When two
    // listeners share a port (v4 + v6), prefer the one we could identify.
    let mut port_meta: HashMap<u16, PortMeta> = HashMap::new();
    for l in listener_pid::list_loopback_listeners() {
        let process = name_of(l.pid);
        let (client, client_label) = classify_client(&process);
        let meta = PortMeta {
            pid: l.pid,
            process,
            client,
            client_label,
        };
        match port_meta.get(&l.port) {
            Some(existing) if existing.client != "unknown" => {}
            _ => {
                port_meta.insert(l.port, meta);
            }
        }
    }

    // Ports to probe: the common table, plus any identified-client listener
    // ports not already in it (custom-port coverage).
    let mut ports: Vec<u16> = COMMON_PROXY_PORTS.to_vec();
    for (port, meta) in &port_meta {
        if meta.client != "unknown" && !ports.contains(port) {
            ports.push(*port);
        }
    }

    let mut out = Vec::new();
    for port in ports {
        // Something must be listening before we spend a handshake budget on it.
        // `port_meta` (from the cross-OS loopback enumeration) is the primary
        // gate on every platform; `resolve_listener_pids` is a Windows-only
        // secondary check. Common-table ports with nothing listening are skipped
        // rather than incurring a probe timeout each.
        let has_meta = port_meta.contains_key(&port);
        if !has_meta && listener_pid::resolve_listener_pids(port).is_empty() {
            continue;
        }
        let Some(kind) = probe_local_proxy_kind(port).await else {
            continue;
        };
        let (pid, process, client, client_label) = match port_meta.get(&port) {
            Some(m) => (
                m.pid,
                m.process.clone(),
                m.client.clone(),
                m.client_label.clone(),
            ),
            None => {
                let pid = listener_pid::resolve_listener_pids(port)
                    .into_iter()
                    .next()
                    .unwrap_or(0);
                let process = if pid != 0 {
                    name_of(pid)
                } else {
                    String::new()
                };
                let (client, client_label) = classify_client(&process);
                (pid, process, client, client_label)
            }
        };
        out.push(LocalProxyCandidate {
            kind,
            host: "127.0.0.1".into(),
            port,
            process,
            pid,
            client,
            client_label,
        });
    }

    // Identified clients first, then by port, so the UI's primary group leads.
    out.sort_by(|a, b| {
        let a_known = a.client != "unknown";
        let b_known = b.client != "unknown";
        b_known.cmp(&a_known).then(a.port.cmp(&b.port))
    });
    Ok(out)
}

/// Suspected proxy/VPN TUN adapters on this machine (Clash TUN, sing-box,
/// Wintun/TAP, WireGuard). A running L3 TUN client collides with SocksCap's
/// global capture, so the UI warns when this is non-empty. Empty = no conflict.
#[tauri::command]
pub async fn sockscap_detect_tun_conflicts() -> Result<Vec<String>, String> {
    Ok(tun_detect::detect_tun_adapters())
}

#[tauri::command]
pub async fn sockscap_get_domain_records(
    state: State<'_, AppState>,
) -> Result<Vec<DomainRecord>, String> {
    let orch = state.sockscap.orch.read().await;
    let guard = orch.domains.lock().map_err(|e| e.to_string())?;
    Ok(guard.snapshot())
}

#[tauri::command]
pub async fn sockscap_clear_domain_records(state: State<'_, AppState>) -> Result<(), String> {
    let orch = state.sockscap.orch.read().await;
    let mut guard = orch.domains.lock().map_err(|e| e.to_string())?;
    guard.clear();
    Ok(())
}
