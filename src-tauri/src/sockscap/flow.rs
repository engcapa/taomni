//! FlowEngine glue and statistics (plan §4 FlowEngine/StatsAggregator).
//!
//! Ties the pieces together for one captured flow: build a [`FlowContext`] from
//! the capture adapter, select the owning profile, attribute the hostname,
//! decide the action, and (for PROXY/DIRECT) connect via an
//! [`EgressConnector`] and bridge bytes. Statistics are hot-path atomics only —
//! no payload, no full URLs (plan §10). The live capture adapters that feed
//! `FlowContext` arrive in later phases; this module is testable in isolation.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};

use super::attribution::{attribute, AttributionInputs};
use super::egress::{EgressConnector, Endpoint};
use super::policy::{
    select_profile, AppIdentity, CompiledProfile, Decision, DecisionReason, FlowTarget, HardBypass,
};
use super::model::RoutingProfile;
use super::{Action, Protocol};

/// Everything known about a captured flow before a decision (plan §4 FlowEngine
/// FlowContext). The capture adapter fills `app`, `dest_ip`, `dest_port` and
/// whatever hostname signals it has; `attribution` may be enriched (SNI/Host)
/// once the first bytes are seen.
#[derive(Debug, Clone)]
pub struct FlowContext {
    pub app: AppIdentity,
    pub protocol: Protocol,
    pub dest_ip: Option<IpAddr>,
    pub dest_port: u16,
    pub attribution: AttributionInputs,
}

/// The decision for a flow plus the profile it was made under and the resolved
/// destination endpoint (for the egress connector).
#[derive(Debug, Clone)]
pub struct ResolvedFlow {
    pub profile_id: Option<String>,
    pub decision: Decision,
    pub endpoint: Endpoint,
}

/// Resolve a flow to an action: select profile → attribute hostname → decide.
/// When no profile applies (nothing selected, or its snapshot is missing) the
/// flow is left DIRECT / uncaptured rather than guessing.
pub fn resolve_flow(
    profiles: &[RoutingProfile],
    compiled: &HashMap<String, CompiledProfile>,
    bypass: &HardBypass,
    ctx: &FlowContext,
) -> ResolvedFlow {
    let (host, hostname_source) = attribute(&ctx.attribution);
    let target = FlowTarget {
        host: host.clone(),
        hostname_source,
        ip: ctx.dest_ip,
        port: ctx.dest_port,
        protocol: ctx.protocol,
    };
    let endpoint = Endpoint {
        host,
        ip: ctx.dest_ip,
        port: ctx.dest_port,
    };
    let selected = select_profile(profiles, &ctx.app).and_then(|p| compiled.get(&p.id));
    match selected {
        Some(cp) => ResolvedFlow {
            profile_id: Some(cp.profile.id.clone()),
            decision: cp.decide(bypass, &target),
            endpoint,
        },
        None => ResolvedFlow {
            profile_id: None,
            decision: Decision {
                action: Action::Direct,
                reason: DecisionReason::DefaultAction,
                hostname_source,
                matched_source_id: None,
                matched_pattern: None,
                note: Some("no profile applies — left direct/uncaptured".into()),
            },
            endpoint,
        },
    }
}

/// Hot-path traffic counters. Updated with relaxed atomics on the data path;
/// snapshotted for the dashboard at a bounded rate (plan §4 StatsAggregator,
/// §10 — no payload, no URLs).
#[derive(Default)]
pub struct StatsAggregator {
    bytes_up: AtomicU64,
    bytes_down: AtomicU64,
    connections: AtomicU64,
    direct: AtomicU64,
    proxy: AtomicU64,
    block: AtomicU64,
    errors: AtomicU64,
}

/// A point-in-time stats snapshot for a `sockscap://traffic-summary` event.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub connections: u64,
    pub direct: u64,
    pub proxy: u64,
    pub block: u64,
    pub errors: u64,
}

impl StatsAggregator {
    pub fn new() -> StatsAggregator {
        StatsAggregator::default()
    }

    /// Count a decision toward the direct/proxy/block distribution.
    pub fn record_decision(&self, action: Action) {
        let counter = match action {
            Action::Direct => &self.direct,
            Action::Proxy => &self.proxy,
            Action::Block => &self.block,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_connection_open(&self) {
        self.connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_up(&self, n: u64) {
        self.bytes_up.fetch_add(n, Ordering::Relaxed);
    }

    pub fn add_down(&self, n: u64) {
        self.bytes_down.fetch_add(n, Ordering::Relaxed);
    }

    pub fn record_error(&self) {
        self.errors.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            bytes_up: self.bytes_up.load(Ordering::Relaxed),
            bytes_down: self.bytes_down.load(Ordering::Relaxed),
            connections: self.connections.load(Ordering::Relaxed),
            direct: self.direct.load(Ordering::Relaxed),
            proxy: self.proxy.load(Ordering::Relaxed),
            block: self.block.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
        }
    }
}

/// Connect a flow through `connector` and bridge it to the captured `client`
/// stream, counting bytes. Returns `(bytes_up, bytes_down)`. `client` is the
/// intercepted application socket; `bytes_up` is client→egress.
pub async fn dispatch<C>(
    connector: &dyn EgressConnector,
    target: &Endpoint,
    client: &mut C,
    stats: &StatsAggregator,
) -> Result<(u64, u64), String>
where
    C: AsyncRead + AsyncWrite + Unpin + ?Sized,
{
    stats.record_connection_open();
    let (mut egress, _meta) = connector.connect_tcp(target).await.map_err(|e| {
        stats.record_error();
        e
    })?;
    match tokio::io::copy_bidirectional(client, &mut *egress).await {
        Ok((up, down)) => {
            stats.add_up(up);
            stats.add_down(down);
            Ok((up, down))
        }
        Err(e) => {
            stats.record_error();
            Err(format!("bridge: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::autoproxy;
    use crate::sockscap::egress::DirectConnector;
    use crate::sockscap::Action as A;
    use crate::sockscap::model::{
        AppSelector, DnsMode, EgressFailureAction, EgressKind, LocalNetworkPolicy, RoutingProfile,
        Scope, StatsPrivacy, UdpPolicy,
    };
    use crate::sockscap::HostnameSource;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn profile(id: &str, scope: Scope, default_action: A) -> RoutingProfile {
        RoutingProfile {
            id: id.into(),
            name: id.into(),
            enabled: true,
            priority: 100,
            scope,
            app_selectors: vec![],
            runtime_processes: vec![],
            include_children: true,
            egress_kind: EgressKind::ProxySession,
            egress_ref_id: "proxy-1".into(),
            egress_failure_action: EgressFailureAction::FailOpen,
            rule_source_ids: vec![],
            default_action,
            dns_mode: DnsMode::SystemCapture,
            unknown_domain_action: A::Direct,
            udp_policy: UdpPolicy::Block,
            local_network_policy: LocalNetworkPolicy::Direct,
            ssh_pool_options: None,
            stats_privacy: StatsPrivacy::default(),
        }
    }

    fn compiled_map(p: RoutingProfile, gfwlist: &str) -> HashMap<String, CompiledProfile> {
        let src = autoproxy::parse_decoded(gfwlist).compile("gfwlist-official");
        let mut m = HashMap::new();
        m.insert(p.id.clone(), CompiledProfile::new(p, vec![], vec![src]));
        m
    }

    #[test]
    fn resolve_flow_uses_selected_profile_and_sni() {
        let mut p = profile("app", Scope::Applications, A::Direct);
        p.app_selectors = vec![AppSelector::WindowsExecutable("C:/app.exe".into())];
        let profiles = vec![p.clone()];
        let compiled = compiled_map(p, "||google.com");
        let ctx = FlowContext {
            app: AppIdentity {
                windows_exe: Some("C:/app.exe".into()),
                ..Default::default()
            },
            protocol: Protocol::Tcp,
            dest_ip: Some("142.250.1.1".parse().unwrap()),
            dest_port: 443,
            attribution: AttributionInputs {
                tls_sni: Some("mail.google.com".into()),
                has_ip: true,
                ..Default::default()
            },
        };
        let r = resolve_flow(&profiles, &compiled, &HardBypass::default(), &ctx);
        assert_eq!(r.profile_id.as_deref(), Some("app"));
        assert_eq!(r.decision.action, Action::Proxy);
        assert_eq!(r.decision.hostname_source, HostnameSource::TlsSni);
    }

    #[test]
    fn resolve_flow_no_profile_is_direct() {
        let profiles: Vec<RoutingProfile> = vec![];
        let compiled = HashMap::new();
        let ctx = FlowContext {
            app: AppIdentity::default(),
            protocol: Protocol::Tcp,
            dest_ip: Some("1.2.3.4".parse().unwrap()),
            dest_port: 80,
            attribution: AttributionInputs {
                has_ip: true,
                ..Default::default()
            },
        };
        let r = resolve_flow(&profiles, &compiled, &HardBypass::default(), &ctx);
        assert_eq!(r.profile_id, None);
        assert_eq!(r.decision.action, Action::Direct);
    }

    #[test]
    fn stats_aggregate_and_snapshot() {
        let s = StatsAggregator::new();
        s.record_decision(Action::Proxy);
        s.record_decision(Action::Proxy);
        s.record_decision(Action::Block);
        s.record_connection_open();
        s.add_up(100);
        s.add_down(250);
        s.record_error();
        let snap = s.snapshot();
        assert_eq!(snap.proxy, 2);
        assert_eq!(snap.block, 1);
        assert_eq!(snap.connections, 1);
        assert_eq!(snap.bytes_up, 100);
        assert_eq!(snap.bytes_down, 250);
        assert_eq!(snap.errors, 1);
    }

    #[tokio::test]
    async fn dispatch_bridges_client_to_egress_and_counts_bytes() {
        // Echo server standing in for the destination.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 64];
            let n = sock.read(&mut buf).await.unwrap();
            sock.write_all(&buf[..n]).await.unwrap();
        });

        // Duplex: `app` is the test-side app socket, `client` is what the engine
        // bridges to the egress.
        let (mut app, mut client) = tokio::io::duplex(1024);
        let stats = StatsAggregator::new();
        let target = Endpoint::from_ip("127.0.0.1".parse().unwrap(), port);

        let engine = async {
            dispatch(&DirectConnector, &target, &mut client, &stats).await
        };
        let driver = async {
            app.write_all(b"ping").await.unwrap();
            let mut buf = [0u8; 4];
            app.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"ping");
            // Close the app side so copy_bidirectional completes.
            app.shutdown().await.unwrap();
            drop(app);
        };
        let (res, _) = tokio::join!(engine, driver);
        let (up, down) = res.unwrap();
        assert_eq!(up, 4);
        assert_eq!(down, 4);
        assert_eq!(stats.snapshot().connections, 1);
    }
}
