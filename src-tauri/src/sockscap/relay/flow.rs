use super::bridge::bridge_any;
use super::bridge::bridge_tcp;
use super::bridge::write_prefix;
use super::context::CapturedFlow;
use super::context::RelayContext;
use super::limits::HOSTNAME_SNIFF_OPPORTUNISTIC;
use super::limits::HOSTNAME_SNIFF_REQUIRED;
use super::limits::RELAY_DIAL_TIMEOUT;
use super::sniffing::peek_for_hostname;
use crate::sockscap::config::Decision;
use crate::sockscap::config::UpstreamKind;
use crate::sockscap::egress;
use crate::sockscap::policy::PolicyInput;
use std::sync::Arc;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::net::TcpStream;
use tokio::sync::RwLock;

/// Apply shared hostname/policy/egress processing to any captured byte stream.
///
/// Redirector hands macOS flows over AF_UNIX after its protobuf handshake, so
/// requiring `TcpStream` here would force the backend to wrap the flow in a
/// fake local SOCKS connection and lose its process metadata.
pub(crate) async fn handle_captured_stream<S>(
    mut client: S,
    flow: CapturedFlow,
    ctx: Arc<RwLock<RelayContext>>,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let dest_ip = flow.dest_ip;
    let dest_port = flow.dest_port;
    let authoritative_host = flow.dest_host;
    let process_path = flow.process_path;
    let pid = flow.pid;
    let origin = flow.origin;
    let profile_id_hint = flow.profile_id_hint;

    if dest_ip.is_none() && authoritative_host.is_none() {
        return Err("captured flow carried neither a destination address nor a hostname".into());
    }

    let (preliminary_engine, cached_hostname) = {
        let context = ctx.read().await;
        let cached_hostname = dest_ip.and_then(|ip| {
            context
                .dns_map
                .lock()
                .ok()
                .and_then(|mut map| map.lookup(ip))
        });
        (Arc::clone(&context.engine), cached_hostname)
    };
    let hostname_free_decision = if authoritative_host.is_none() && cached_hostname.is_none() {
        preliminary_engine.decide_without_hostname(
            &PolicyInput {
                host: None,
                ip: dest_ip,
                port: dest_port,
                process_path: process_path.clone(),
                pid,
            },
            profile_id_hint.as_deref(),
        )
    } else {
        None
    };
    let sniff_budget = if cached_hostname.is_some() || hostname_free_decision.is_some() {
        HOSTNAME_SNIFF_OPPORTUNISTIC
    } else {
        HOSTNAME_SNIFF_REQUIRED
    };

    let (prefix, observed_hostname) = match authoritative_host {
        // A proxy handshake already named the target. Skipping the sniff also
        // avoids stalling server-first protocols (SMTP, IMAP, SSH), where the
        // client sends nothing until the server has greeted it.
        Some(host) => (Vec::new(), Some(host)),
        // Multi-read peek for SNI / HTTP Host (ClientHello may span packets).
        None => peek_for_hostname(&mut client, dest_port, sniff_budget).await,
    };

    let snap = {
        let g = ctx.read().await;
        // Learn IP→host from this flow for later pure-IP connections.
        if let (Some(host), Some(ip)) = (observed_hostname.as_ref(), dest_ip) {
            if let Ok(mut map) = g.dns_map.lock() {
                map.insert(ip, host.clone(), None);
            }
        }

        // Prefer authoritative/live SNI/Host, then the observed DNS response.
        // DNS attribution is especially important for TLS ECH, where SNI is
        // intentionally unavailable to a transparent, non-MITM relay.
        let host_for_policy = observed_hostname
            .clone()
            .or_else(|| cached_hostname.clone())
            .or_else(|| {
                dest_ip.and_then(|ip| g.dns_map.lock().ok().and_then(|mut m| m.lookup(ip)))
            });

        let engine = Arc::clone(&g.engine);
        let input = PolicyInput {
            host: host_for_policy.clone(),
            ip: dest_ip,
            port: dest_port,
            process_path: process_path.clone(),
            pid,
        };
        let trace = if host_for_policy.is_none() {
            hostname_free_decision.unwrap_or_else(|| {
                engine.decide_with_profile_hint(&input, profile_id_hint.as_deref())
            })
        } else {
            engine.decide_with_profile_hint(&input, profile_id_hint.as_deref())
        };

        let (kind, up_host, up_port, up_user, up_pass, ssh_pool, xray_port) =
            match trace.profile_id.as_deref() {
                Some(pid) if g.profile_upstreams.contains_key(pid) => {
                    let up = &g.profile_upstreams[pid];
                    (
                        up.kind,
                        up.host.clone(),
                        up.port,
                        up.user.clone(),
                        up.pass.clone(),
                        up.ssh_pool.clone(),
                        up.xray_port,
                    )
                }
                _ => (
                    g.config.upstream.kind,
                    g.upstream_host.clone(),
                    g.upstream_port,
                    g.upstream_user.clone(),
                    g.upstream_pass.clone(),
                    g.ssh_pool.clone(),
                    g.xray_port,
                ),
            };

        (
            observed_hostname,
            host_for_policy,
            trace,
            kind,
            up_host,
            up_port,
            up_user,
            up_pass,
            Arc::clone(&g.stats),
            ssh_pool,
            Arc::clone(&g.domains),
            xray_port,
        )
    };

    let (
        observed_hostname,
        policy_hostname,
        trace,
        kind,
        up_host,
        up_port,
        up_user,
        up_pass,
        stats,
        ssh_pool,
        domains,
        xray_port,
    ) = snap;

    // A direct transparent flow already has the exact destination address; do
    // not repeat local DNS and possibly select a different CDN edge. Proxied
    // flows prefer the recovered hostname so the upstream performs DNS and is
    // not constrained by a locally poisoned answer.
    let dial_host = match trace.decision {
        Decision::Proxy => observed_hostname
            .clone()
            .or_else(|| policy_hostname.clone())
            .or_else(|| dest_ip.map(|ip| ip.to_string())),
        Decision::Direct | Decision::Block => dest_ip
            .map(|ip| ip.to_string())
            .or_else(|| observed_hostname.clone())
            .or_else(|| policy_hostname.clone()),
    };
    let dial_host =
        dial_host.ok_or_else(|| "captured flow had no dialable destination".to_string())?;
    let record_host = policy_hostname.clone().unwrap_or_else(|| dial_host.clone());

    let res = match trace.decision {
        Decision::Block => {
            stats.record_decision(false, true);
            if let Ok(mut doms) = domains.lock() {
                doms.record(
                    record_host.clone(),
                    trace.decision,
                    trace.matched_rule.clone(),
                    trace.profile_name.clone(),
                    process_path.clone(),
                    pid,
                    0,
                    0,
                );
            }
            return Err(format!(
                "blocked {record_host}:{dest_port} ({})",
                trace.reason
            ));
        }
        Decision::Direct => {
            stats.record_decision(false, false);
            let mut remote = tokio::time::timeout(
                RELAY_DIAL_TIMEOUT,
                TcpStream::connect((dial_host.as_str(), dest_port)),
            )
            .await
            .map_err(|_| {
                format!(
                    "direct connect {dial_host}:{dest_port}: timed out after {}s",
                    RELAY_DIAL_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("direct connect {dial_host}:{dest_port}: {e}"))?;
            write_prefix(&mut remote, &prefix).await?;
            bridge_tcp(&mut client, &mut remote).await
        }
        Decision::Proxy => {
            stats.record_decision(true, false);
            match kind {
                UpstreamKind::Http => {
                    let mut remote = tokio::time::timeout(
                        RELAY_DIAL_TIMEOUT,
                        egress::http_connect::dial(
                            &up_host, up_port, &dial_host, dest_port, &up_user, &up_pass,
                        ),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "HTTP proxy {up_host}:{up_port} connect to {dial_host}:{dest_port}: timed out after {}s",
                            RELAY_DIAL_TIMEOUT.as_secs()
                        )
                    })??;
                    write_prefix(&mut remote, &prefix).await?;
                    bridge_tcp(&mut client, &mut remote).await
                }
                UpstreamKind::Socks5 => {
                    let mut remote = tokio::time::timeout(
                        RELAY_DIAL_TIMEOUT,
                        egress::socks5::dial(
                            &up_host, up_port, &dial_host, dest_port, &up_user, &up_pass,
                        ),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "SOCKS5 proxy {up_host}:{up_port} connect to {dial_host}:{dest_port}: timed out after {}s",
                            RELAY_DIAL_TIMEOUT.as_secs()
                        )
                    })??;
                    write_prefix(&mut remote, &prefix).await?;
                    bridge_tcp(&mut client, &mut remote).await
                }
                UpstreamKind::Ssh => {
                    let pool = ssh_pool.ok_or_else(|| "SSH pool not initialized".to_string())?;
                    let origin_ip = origin.ip().to_string();
                    let mut remote = tokio::time::timeout(
                        RELAY_DIAL_TIMEOUT,
                        pool.dial(&dial_host, dest_port, &origin_ip, origin.port()),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "SSH connect to {dial_host}:{dest_port}: timed out after {}s",
                            RELAY_DIAL_TIMEOUT.as_secs()
                        )
                    })??;
                    write_prefix(&mut remote, &prefix).await?;
                    bridge_any(&mut client, &mut remote).await
                }
                // xray-core–backed kinds (shadowsocks/trojan/vmess/vless/
                // wireguard): dial the per-profile local SOCKS inbound the
                // XrayManager opened for this upstream. All protocol/crypto/
                // transport work happens inside xray; the relay just bridges.
                other if other.requires_core() => {
                    let port = xray_port.ok_or_else(|| {
                        format!(
                            "{} upstream has no running xray core (check core provisioning / config)",
                            other.as_tag()
                        )
                    })?;
                    let mut remote = tokio::time::timeout(
                        RELAY_DIAL_TIMEOUT,
                        egress::socks5::dial(
                            "127.0.0.1", port, &dial_host, dest_port, "", "",
                        ),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "{} core (127.0.0.1:{port}) connect to {dial_host}:{dest_port}: timed out after {}s",
                            other.as_tag(),
                            RELAY_DIAL_TIMEOUT.as_secs()
                        )
                    })??;
                    write_prefix(&mut remote, &prefix).await?;
                    bridge_tcp(&mut client, &mut remote).await
                }
                other => {
                    return Err(format!("unhandled upstream kind {}", other.as_tag()));
                }
            }
        }
    };

    match res {
        Ok((bytes_a, bytes_b)) => {
            let up = bytes_a + prefix.len() as u64;
            let down = bytes_b;
            stats.add_bytes(up, down);
            if let Ok(mut doms) = domains.lock() {
                doms.record(
                    record_host,
                    trace.decision,
                    trace.matched_rule,
                    trace.profile_name,
                    process_path,
                    pid,
                    up,
                    down,
                );
            }
        }
        Err(e) => return Err(e),
    }

    Ok(())
}
