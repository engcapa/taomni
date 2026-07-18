//! Local SOCKS5 capture backend + flow router (plan §4 FlowEngine, §7).
//!
//! This is a real, driver-free `CaptureAdapter`: a local SOCKS5 (CONNECT)
//! listener that drives the full engine end-to-end — parse target → build a
//! FlowContext → PolicyEngine decision → connect via the selected
//! EgressConnector → bridge, counting bytes. Apps pointed at this local SOCKS
//! port are routed by the same profiles/rules as transparent capture would use.
//! It needs no kernel driver, so it runs and is integration-tested on this
//! machine; the transparent per-app/PID backends (Windows/macOS/Linux) plug
//! into the same `CaptureAdapter` trait and `FlowRouter` (see the ADRs).
//!
//! A SOCKS front-end has no OS process identity for the peer, so only a `Global`
//! profile applies here (app/PID scoping needs transparent capture). That is
//! surfaced honestly rather than guessed.

use std::net::IpAddr;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

use super::attribution::{attribute, AttributionInputs};
use super::egress::{DirectConnector, EgressConnector, Endpoint};
use super::flow::{dispatch, StatsAggregator};
use super::policy::{CompiledProfile, Decision, FlowTarget, HardBypass};
use super::{Action, Protocol};

/// Routes one captured flow to a decision + the connector that should carry it.
pub struct FlowRouter {
    /// The active global profile snapshot, if any (None ⇒ everything DIRECT).
    compiled: Option<CompiledProfile>,
    bypass: HardBypass,
    /// The upstream connector for PROXY decisions (Socks5/HttpConnect/SshJump).
    /// None ⇒ PROXY decisions fall back per egress-failure policy (here: direct).
    upstream: Option<Arc<dyn EgressConnector>>,
    direct: DirectConnector,
    pub stats: Arc<StatsAggregator>,
}

impl FlowRouter {
    pub fn new(
        compiled: Option<CompiledProfile>,
        upstream: Option<Arc<dyn EgressConnector>>,
        bypass: HardBypass,
        stats: Arc<StatsAggregator>,
    ) -> FlowRouter {
        FlowRouter {
            compiled,
            bypass,
            upstream,
            direct: DirectConnector,
            stats,
        }
    }

    /// Decide the action for a target (TCP; SOCKS CONNECT is TCP only).
    pub fn decide(&self, host: Option<&str>, ip: Option<IpAddr>, port: u16) -> Decision {
        let (attr_host, source) = attribute(&AttributionInputs {
            platform_hostname: host.map(|h| h.to_string()),
            has_ip: ip.is_some(),
            ..Default::default()
        });
        let target = FlowTarget {
            host: attr_host,
            hostname_source: source,
            ip,
            port,
            protocol: Protocol::Tcp,
        };
        match &self.compiled {
            Some(cp) => cp.decide(&self.bypass, &target),
            None => Decision {
                action: Action::Direct,
                reason: super::policy::DecisionReason::DefaultAction,
                hostname_source: source,
                matched_source_id: None,
                matched_pattern: None,
                note: Some("no global profile — direct".into()),
            },
        }
    }

    /// The connector for a decided action: DIRECT/BLOCK use direct-or-none;
    /// PROXY uses the upstream if present, else DIRECT (fail-open). `None` ⇒
    /// BLOCK (drop the flow). Public so transparent backends can reuse routing.
    pub fn connector_for(&self, action: Action) -> Option<&dyn EgressConnector> {
        match action {
            Action::Direct => Some(&self.direct),
            Action::Block => None,
            Action::Proxy => match &self.upstream {
                Some(c) => Some(c.as_ref()),
                None => Some(&self.direct), // fail-open when no upstream wired
            },
        }
    }
}

/// Serve SOCKS5 CONNECT on `listener` until `cancel` is notified. Each
/// connection is routed through `router`.
pub async fn serve_socks5(listener: TcpListener, router: Arc<FlowRouter>, cancel: Arc<Notify>) {
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let router = router.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_conn(stream, router).await {
                                tracing::debug!("sockscap listener conn ended: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!("sockscap listener accept failed: {e}");
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_conn(mut stream: TcpStream, router: Arc<FlowRouter>) -> Result<(), String> {
    // Greeting: VER, NMETHODS, methods.
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await.map_err(|e| e.to_string())?;
    if head[0] != 0x05 {
        return Err("not SOCKS5".into());
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await.map_err(|e| e.to_string())?;
    // No authentication.
    stream.write_all(&[0x05, 0x00]).await.map_err(|e| e.to_string())?;

    // Request: VER, CMD, RSV, ATYP, addr, port.
    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await.map_err(|e| e.to_string())?;
    if req[1] != 0x01 {
        // Only CONNECT is supported.
        reply(&mut stream, 0x07).await;
        return Err("unsupported SOCKS command".into());
    }
    let (host, ip) = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            (None, Some(IpAddr::from(a)))
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(|e| e.to_string())?;
            let mut h = vec![0u8; len[0] as usize];
            stream.read_exact(&mut h).await.map_err(|e| e.to_string())?;
            let host = String::from_utf8_lossy(&h).to_string();
            (Some(host), None)
        }
        0x04 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            (None, Some(IpAddr::from(a)))
        }
        _ => {
            reply(&mut stream, 0x08).await;
            return Err("bad ATYP".into());
        }
    };
    let mut portb = [0u8; 2];
    stream.read_exact(&mut portb).await.map_err(|e| e.to_string())?;
    let port = u16::from_be_bytes(portb);

    let decision = router.decide(host.as_deref(), ip, port);
    router.stats.record_decision(decision.action);

    let connector = match router.connector_for(decision.action) {
        Some(c) => c,
        None => {
            // BLOCK — SOCKS "connection not allowed by ruleset".
            reply(&mut stream, 0x02).await;
            return Ok(());
        }
    };

    let endpoint = match (&host, ip) {
        (Some(h), _) => Endpoint::from_host(h.clone(), port),
        (None, Some(ip)) => Endpoint::from_ip(ip, port),
        _ => {
            reply(&mut stream, 0x01).await;
            return Err("no target".into());
        }
    };

    // Success reply (BND 0.0.0.0:0) then bridge client ↔ egress.
    reply(&mut stream, 0x00).await;
    dispatch(connector, &endpoint, &mut stream, &router.stats).await?;
    Ok(())
}

async fn reply(stream: &mut TcpStream, rep: u8) {
    let _ = stream
        .write_all(&[0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await;
}

use async_trait::async_trait;
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex as AsyncMutex;

use super::capability::{detect, Capabilities};
use super::capture::CaptureAdapter;

/// A real, driver-free capture backend: a local SOCKS5 listener driving the
/// FlowRouter. `install` binds the listener and starts serving; `uninstall`
/// stops it and restores nothing (there is no system state to revert — a clean
/// fail-open, plan §9). The router is set by the command layer from the current
/// profiles/rules before `install`.
pub struct LocalCaptureAdapter {
    listen_host: String,
    listen_port: u16,
    router: StdMutex<Option<Arc<FlowRouter>>>,
    task: AsyncMutex<Option<(tokio::task::JoinHandle<()>, Arc<Notify>)>>,
    bound_port: StdMutex<Option<u16>>,
}

impl LocalCaptureAdapter {
    pub fn new(listen_host: impl Into<String>, listen_port: u16) -> LocalCaptureAdapter {
        LocalCaptureAdapter {
            listen_host: listen_host.into(),
            listen_port,
            router: StdMutex::new(None),
            task: AsyncMutex::new(None),
            bound_port: StdMutex::new(None),
        }
    }

    /// Set the router built from the current profiles/rules (call before start).
    pub fn set_router(&self, router: Arc<FlowRouter>) {
        *self.router.lock().unwrap() = Some(router);
    }

    /// The port the listener actually bound (for the UI / tests).
    pub fn bound_port(&self) -> Option<u16> {
        *self.bound_port.lock().unwrap()
    }
}

#[async_trait]
impl CaptureAdapter for LocalCaptureAdapter {
    fn capabilities(&self) -> Capabilities {
        // The local SOCKS front-end supports global routing on every platform;
        // per-app/PID scoping needs a transparent backend, reported elsewhere.
        let mut caps = detect();
        caps.notes.insert(
            0,
            format!(
                "Local SOCKS5 capture active on {}:{} — point apps here for global routing",
                self.listen_host, self.listen_port
            ),
        );
        caps
    }

    fn is_ready(&self) -> bool {
        true
    }

    async fn install(&self) -> Result<(), String> {
        let router = self
            .router
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "router not configured".to_string())?;
        let listener = TcpListener::bind((self.listen_host.as_str(), self.listen_port))
            .await
            .map_err(|e| format!("bind {}:{}: {e}", self.listen_host, self.listen_port))?;
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(self.listen_port);
        *self.bound_port.lock().unwrap() = Some(port);
        let cancel = Arc::new(Notify::new());
        let cancel_task = cancel.clone();
        let handle = tokio::spawn(async move {
            serve_socks5(listener, router, cancel_task).await;
        });
        *self.task.lock().await = Some((handle, cancel));
        Ok(())
    }

    async fn uninstall(&self) -> Result<(), String> {
        if let Some((handle, cancel)) = self.task.lock().await.take() {
            cancel.notify_waiters();
            handle.abort();
        }
        *self.bound_port.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::Action as A;
    use crate::sockscap::autoproxy;
    use crate::sockscap::model::{
        DnsMode, EgressFailureAction, EgressKind, LocalNetworkPolicy, RoutingProfile, Scope,
        StatsPrivacy, UdpPolicy,
    };
    use crate::sockscap::policy::CompiledProfile;

    fn global_profile(default_action: A) -> RoutingProfile {
        RoutingProfile {
            id: "g".into(),
            name: "g".into(),
            enabled: true,
            priority: 0,
            scope: Scope::Global,
            app_selectors: vec![],
            runtime_processes: vec![],
            include_children: true,
            egress_kind: EgressKind::ProxySession,
            egress_ref_id: "".into(),
            egress_failure_action: EgressFailureAction::FailOpen,
            rule_source_ids: vec![],
            default_action,
            dns_mode: DnsMode::SystemCapture,
            unknown_domain_action: A::Direct,
            udp_policy: UdpPolicy::Block,
            local_network_policy: LocalNetworkPolicy::ByRule,
            ssh_pool_options: None,
            stats_privacy: StatsPrivacy::default(),
        }
    }

    async fn echo_server() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 256];
                    loop {
                        match s.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if s.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        port
    }

    /// Drive a SOCKS5 CONNECT to `host:port` through the adapter port; returns
    /// the socket after a successful reply, or the SOCKS reply code on refusal.
    async fn socks_connect(proxy: u16, host: &str, port: u16) -> Result<TcpStream, u8> {
        let mut s = TcpStream::connect(("127.0.0.1", proxy)).await.unwrap();
        s.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut m = [0u8; 2];
        s.read_exact(&mut m).await.unwrap();
        let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
        req.extend_from_slice(host.as_bytes());
        req.extend_from_slice(&port.to_be_bytes());
        s.write_all(&req).await.unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).await.unwrap();
        if rep[1] == 0x00 {
            Ok(s)
        } else {
            Err(rep[1])
        }
    }

    fn router(profile: RoutingProfile) -> Arc<FlowRouter> {
        let cp = CompiledProfile::new(profile, vec![], vec![]);
        Arc::new(FlowRouter::new(
            Some(cp),
            None,
            HardBypass::default(),
            Arc::new(StatsAggregator::new()),
        ))
    }

    #[tokio::test]
    async fn direct_flow_routes_through_local_socks_to_echo() {
        let echo = echo_server().await;
        let adapter = LocalCaptureAdapter::new("127.0.0.1", 0);
        adapter.set_router(router(global_profile(A::Direct)));
        adapter.install().await.unwrap();
        let proxy = adapter.bound_port().unwrap();

        let mut s = socks_connect(proxy, "127.0.0.1", echo).await.unwrap();
        s.write_all(b"hello-sockscap").await.unwrap();
        let mut buf = [0u8; 14];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello-sockscap");

        adapter.uninstall().await.unwrap();
        assert!(adapter.bound_port().is_none());
    }

    #[tokio::test]
    async fn block_default_refuses_the_connection() {
        // A global profile that blocks unmatched hosts (strict) rejects the flow.
        // Target a non-loopback host so the loopback hard-bypass doesn't force
        // DIRECT; BLOCK closes before any real connection is attempted.
        let adapter = LocalCaptureAdapter::new("127.0.0.1", 0);
        adapter.set_router(router(global_profile(A::Block)));
        adapter.install().await.unwrap();
        let proxy = adapter.bound_port().unwrap();

        let err = socks_connect(proxy, "blocked.example", 443).await.unwrap_err();
        assert_eq!(err, 0x02); // connection not allowed by ruleset
        adapter.uninstall().await.unwrap();
    }

    #[tokio::test]
    async fn subscription_proxy_decision_uses_gfwlist() {
        // Verify the router decides PROXY for a gfwlist host (connector wiring
        // is covered by egress tests; here we assert the decision path).
        let mut p = global_profile(A::Direct);
        p.rule_source_ids = vec!["gfwlist-official".into()];
        let src = autoproxy::parse_decoded("||blocked.example").compile("gfwlist-official");
        let cp = CompiledProfile::new(p, vec![], vec![src]);
        let r = FlowRouter::new(None, None, HardBypass::default(), Arc::new(StatsAggregator::new()));
        // No compiled profile → direct.
        assert_eq!(r.decide(Some("blocked.example"), None, 443).action, A::Direct);
        // With the compiled profile → proxy for the listed host.
        let r2 = FlowRouter::new(Some(cp), None, HardBypass::default(), Arc::new(StatsAggregator::new()));
        assert_eq!(r2.decide(Some("blocked.example"), None, 443).action, A::Proxy);
        assert_eq!(r2.decide(Some("other.example"), None, 443).action, A::Direct);
    }
}
