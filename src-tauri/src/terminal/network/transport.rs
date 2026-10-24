use super::http::http_connect_handshake;
use super::model::NetworkSettings;
use super::socks::socks5_handshake;
use tokio::net::TcpStream;
use tokio::net::lookup_host;

/// Resolve `host:port` honouring the IP-version preference, then connect
/// to the first address that succeeds. Returns the underlying TCP stream;
/// the caller is expected to layer SSH (or a proxy hop) on top.
pub(super) async fn open_tcp_filtered(
    host: &str,
    port: u16,
    ip_version: &str,
) -> Result<TcpStream, String> {
    let mut addrs: Vec<std::net::SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|e| format!("DNS lookup for {}:{} failed: {}", host, port, e))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("No addresses resolved for {}:{}", host, port));
    }
    match ip_version {
        "ipv4" => addrs.retain(|a| a.is_ipv4()),
        "ipv6" => addrs.retain(|a| a.is_ipv6()),
        _ => addrs.sort_by_key(|a| !a.is_ipv4()), // auto: prefer v4 first
    }
    if addrs.is_empty() {
        return Err(format!(
            "No matching IP{} addresses for {}",
            ip_version, host
        ));
    }
    let mut last_err: Option<std::io::Error> = None;
    for a in addrs {
        match TcpStream::connect(a).await {
            Ok(s) => return Ok(s),
            Err(e) => last_err = Some(e),
        }
    }
    Err(format!(
        "Could not connect to {}:{}: {}",
        host,
        port,
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no addresses".into()),
    ))
}

/// Resolve the destination host into a single deterministic identifier
/// to send across a proxy hop, honoring the IP-version preference.
///
/// Semantics:
/// - `ip_version == "auto"`: pass the original hostname to the proxy and
///   let the proxy do its own resolution (preserves split-DNS / proxy-side
///   resolution, the standard behavior for HTTP CONNECT and SOCKS5).
/// - `ip_version == "ipv4"` or `"ipv6"`: resolve locally to a matching IP
///   literal and pass that to the proxy. This makes the policy
///   deterministic end-to-end even through a proxy hop.
pub(super) async fn resolve_destination_for_proxy(
    host: &str,
    port: u16,
    ip_version: &str,
) -> Result<String, String> {
    if ip_version != "ipv4" && ip_version != "ipv6" {
        return Ok(host.to_string());
    }
    // Already an IP literal? respect it as-is so no surprise re-resolution.
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(host.to_string());
    }
    let addrs: Vec<std::net::SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|e| format!("DNS lookup for {}:{} failed: {}", host, port, e))?
        .filter(|a| match ip_version {
            "ipv4" => a.is_ipv4(),
            "ipv6" => a.is_ipv6(),
            _ => true,
        })
        .collect();
    let chosen = addrs
        .into_iter()
        .next()
        .ok_or_else(|| format!("No matching IP{} addresses for {}", ip_version, host))?;
    Ok(chosen.ip().to_string())
}

/// Establish the TCP transport for an SSH connection, applying proxy hop
/// (HTTP CONNECT or SOCKS5), TCP_NODELAY, and IP-version preference per
/// the supplied `NetworkSettings`. When `network` is `None` this is a
/// direct TCP connect with `nodelay=true`.
///
/// IP-version policy under proxy: when the user picked `ipv4` / `ipv6`,
/// the destination hostname is pre-resolved locally to a matching IP
/// literal and that literal is sent to the proxy. With `auto`, the
/// hostname is forwarded as-is and the proxy performs its own
/// resolution (the standard CONNECT/SOCKS5 behavior).
pub async fn establish_transport(
    host: &str,
    port: u16,
    network: Option<&NetworkSettings>,
) -> Result<TcpStream, String> {
    let resolved;
    let network = if let Some(settings) = network.filter(|n| n.proxy_kind == "system") {
        resolved = super::proxy_selection::resolve_system(settings, host)?;
        Some(&resolved)
    } else {
        network
    };
    let ip_pref = network.map(|n| n.ip_version.as_str()).unwrap_or("auto");
    let proxy_kind = network.map(|n| n.proxy_kind.as_str()).unwrap_or("none");
    let nodelay = network.map(|n| n.tcp_nodelay).unwrap_or(true);

    let stream = match proxy_kind {
        "" | "none" => open_tcp_filtered(host, port, ip_pref).await?,
        "http" => {
            let n = network.unwrap();
            require_proxy(n)?;
            let dest = resolve_destination_for_proxy(host, port, ip_pref).await?;
            let mut s = open_tcp_filtered(&n.proxy_host, n.proxy_port, ip_pref).await?;
            s.set_nodelay(nodelay)
                .map_err(|e| format!("set_nodelay: {}", e))?;
            http_connect_handshake(&mut s, &dest, port, &n.proxy_user, &n.proxy_pass).await?;
            s
        }
        "socks5" => {
            let n = network.unwrap();
            require_proxy(n)?;
            let dest = resolve_destination_for_proxy(host, port, ip_pref).await?;
            let mut s = open_tcp_filtered(&n.proxy_host, n.proxy_port, ip_pref).await?;
            s.set_nodelay(nodelay)
                .map_err(|e| format!("set_nodelay: {}", e))?;
            socks5_handshake(&mut s, &dest, port, &n.proxy_user, &n.proxy_pass).await?;
            s
        }
        other => {
            return Err(format!(
                "Proxy type '{}' is not implemented in this build (supported: none, http, socks5).",
                other,
            ));
        }
    };

    stream
        .set_nodelay(nodelay)
        .map_err(|e| format!("set_nodelay: {}", e))?;
    Ok(stream)
}

pub(super) fn require_proxy(n: &NetworkSettings) -> Result<(), String> {
    if n.proxy_host.trim().is_empty() {
        return Err("Proxy host is empty".into());
    }
    if n.proxy_port == 0 {
        return Err("Proxy port must be greater than 0".into());
    }
    Ok(())
}
