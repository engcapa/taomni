//! FlowEngine: attribute → policy → controlled egress for one flow.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::attribution::{AttributedHost, AttributionHints, FakeIpMap, attribute_hostname};
use super::bypass::HardBypassSet;
use super::connectors::{
    ConnectControl, DirectConnector, EgressConnector, EgressError, EgressMetadata, EgressStream,
    EgressTarget, UdpEgressCapability, connect_controlled, proxy_connector,
};
use super::stats::{FlowOutcomeKind, FlowStatsEvent, FlowStatsSink, NoopFlowStatsSink};
use crate::proxy::ResolvedProxy;
use crate::sockscap::policy::matcher::{FlowMatchInput, PolicyDecision, ProfileMatcher};
use crate::sockscap::policy::rules::normalize_hostname;
use crate::sockscap::types::{
    AppSelectorKind, CapturePlatform, EgressFailureAction, EgressKind, HostnameSource,
    LocalNetworkAction, LocalNetworkPolicy, RouteAction, UdpPolicy,
};

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Identity, source, destination, and attribution signals for a new flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowContext {
    #[serde(default = "CapturePlatform::current")]
    pub platform: CapturePlatform,
    pub pid: Option<u32>,
    pub process_start_time: Option<u64>,
    pub app_selector_kind: Option<AppSelectorKind>,
    pub app_identity: Option<String>,
    pub protocol: String,
    pub source_ip: Option<String>,
    pub source_port: Option<u16>,
    pub dest_host: Option<String>,
    pub dest_ip: Option<String>,
    pub dest_port: u16,
    #[serde(default)]
    pub attribution: AttributionHints,
}

/// Validated provider for a profile's PROXY action. DIRECT is deliberately not
/// a provider variant because a missing upstream must never silently become
/// direct.
#[derive(Clone)]
pub enum EgressProvider {
    Configured(Arc<dyn EgressConnector>),
    Unavailable(Arc<str>),
}

impl std::fmt::Debug for EgressProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Configured(connector) => formatter
                .debug_tuple("Configured")
                .field(&connector.name())
                .finish(),
            Self::Unavailable(_) => formatter
                .debug_tuple("Unavailable")
                .field(&"provider not configured")
                .finish(),
        }
    }
}

impl EgressProvider {
    pub fn from_kind(
        kind: Option<EgressKind>,
        proxy: Option<ResolvedProxy>,
    ) -> Result<Self, EgressError> {
        let connector = match kind {
            Some(EgressKind::ProxySession) => proxy_connector(proxy.ok_or_else(|| {
                EgressError::Unavailable("referenced Proxy session could not be resolved".into())
            })?)?,
            Some(EgressKind::SshJump) => {
                return Err(EgressError::Unavailable(
                    "SSH Jump requires a resolved shared SSH channel pool".into(),
                ));
            }
            None => {
                return Err(EgressError::Unavailable(
                    "profile has no egress configured for PROXY actions".into(),
                ));
            }
        };
        Ok(Self::Configured(connector))
    }

    pub fn from_connector(connector: Arc<dyn EgressConnector>) -> Self {
        Self::Configured(connector)
    }

    pub fn unavailable(reason: impl Into<Arc<str>>) -> Self {
        Self::Unavailable(reason.into())
    }

    fn connector(&self) -> Result<Arc<dyn EgressConnector>, EgressError> {
        match self {
            Self::Configured(connector) => Ok(connector.clone()),
            Self::Unavailable(reason) => Err(EgressError::Unavailable(reason.to_string())),
        }
    }

    fn udp_capability(&self) -> UdpEgressCapability {
        match self {
            Self::Configured(connector) => connector.udp_capability(),
            Self::Unavailable(_) => UdpEgressCapability::Unsupported,
        }
    }
}

/// Serializable result projected to runtime/IPC. `decision.action` is the
/// original policy result; `effective_action` is what actually happened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowHandleResult {
    pub decision: PolicyDecision,
    pub effective_action: RouteAction,
    pub egress: Option<EgressMetadata>,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

/// TCP outcome plus the live transport when one was established.
#[derive(Debug)]
pub struct TcpFlowOutcome {
    pub result: FlowHandleResult,
    pub stream: Option<EgressStream>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpFlowOutcome {
    pub decision: PolicyDecision,
    pub effective_action: RouteAction,
    pub egress_capability: UdpEgressCapability,
    pub reason: Option<String>,
}

/// Per-profile immutable policy and egress runtime.
pub struct FlowEngine {
    pub matcher: Arc<ProfileMatcher>,
    bypass: HardBypassSet,
    fake_ip: FakeIpMap,
    egress: EgressProvider,
    direct: Arc<dyn EgressConnector>,
    udp_policy: UdpPolicy,
    egress_failure_action: EgressFailureAction,
    local_network_policy: LocalNetworkPolicy,
    connect_timeout: Duration,
    stats: Arc<dyn FlowStatsSink>,
}

impl FlowEngine {
    pub fn new(
        matcher: Arc<ProfileMatcher>,
        mut bypass: HardBypassSet,
        fake_ip: FakeIpMap,
        egress: EgressProvider,
        udp_policy: UdpPolicy,
        egress_failure_action: EgressFailureAction,
        local_network_policy: LocalNetworkPolicy,
    ) -> Self {
        if let EgressProvider::Configured(connector) = &egress {
            if let Some(endpoint) = connector.upstream_endpoint() {
                bypass.add_endpoint(&endpoint);
            }
        }
        Self {
            matcher,
            bypass,
            fake_ip,
            egress,
            direct: Arc::new(DirectConnector),
            udp_policy,
            egress_failure_action,
            local_network_policy,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            stats: Arc::new(NoopFlowStatsSink),
        }
    }

    pub fn with_connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    pub fn with_direct_connector(mut self, connector: Arc<dyn EgressConnector>) -> Self {
        self.direct = connector;
        self
    }

    pub fn with_stats_sink(mut self, stats: Arc<dyn FlowStatsSink>) -> Self {
        self.stats = stats;
        self
    }

    /// Decide policy without touching the network.
    pub fn decide(&self, context: &FlowContext) -> PolicyDecision {
        let (attributed, ip) = self.attribute(context);
        let hard_bypass = self.bypass.matches(
            attributed.hostname.as_deref(),
            ip.as_deref(),
            context.dest_port,
            context.pid,
        );

        if hard_bypass {
            return self.matcher.decide(&FlowMatchInput {
                profile_id: self.matcher.profile_id.clone(),
                hostname: attributed.hostname,
                hostname_source: attributed.source,
                ip,
                port: context.dest_port,
                protocol: context.protocol.clone(),
                hard_bypass: true,
            });
        }

        if ip
            .as_deref()
            .and_then(|value| value.parse::<IpAddr>().ok())
            .is_some_and(is_local_network_ip)
        {
            match self.local_network_policy.lan_action {
                LocalNetworkAction::Direct => {
                    return self.fixed_decision(
                        RouteAction::Direct,
                        "local_network_direct",
                        attributed.source,
                    );
                }
                LocalNetworkAction::Block => {
                    return self.fixed_decision(
                        RouteAction::Block,
                        "local_network_block",
                        attributed.source,
                    );
                }
                LocalNetworkAction::Rules => {}
            }
        }

        self.matcher.decide(&FlowMatchInput {
            profile_id: self.matcher.profile_id.clone(),
            hostname: attributed.hostname,
            hostname_source: attributed.source,
            ip,
            port: context.dest_port,
            protocol: context.protocol.clone(),
            hard_bypass: false,
        })
    }

    /// Decide and establish a TCP flow with a fresh cancellation token.
    pub async fn handle_tcp(&self, context: &FlowContext) -> Result<TcpFlowOutcome, EgressError> {
        self.handle_tcp_with_cancel(context, &CancellationToken::new())
            .await
    }

    /// Decide and establish a TCP flow under an explicit cancellation token.
    pub async fn handle_tcp_with_cancel(
        &self,
        context: &FlowContext,
        cancellation: &CancellationToken,
    ) -> Result<TcpFlowOutcome, EgressError> {
        if !context.protocol.eq_ignore_ascii_case("tcp") {
            return Err(EgressError::Unavailable(format!(
                "handle_tcp called with protocol={}",
                context.protocol
            )));
        }

        let decision = self.decide(context);
        let started = Instant::now();
        match decision.action {
            RouteAction::Block => {
                self.emit(
                    context,
                    &decision,
                    RouteAction::Block,
                    FlowOutcomeKind::Blocked,
                    None,
                    None,
                    started,
                );
                Ok(TcpFlowOutcome {
                    result: FlowHandleResult {
                        decision,
                        effective_action: RouteAction::Block,
                        egress: None,
                        error_code: None,
                        error: None,
                    },
                    stream: None,
                })
            }
            RouteAction::Direct => {
                let target = self.target_for(context);
                match self
                    .connect(self.direct.as_ref(), &target, cancellation)
                    .await
                {
                    Ok(stream) => {
                        let metadata = stream.meta.clone();
                        self.emit(
                            context,
                            &decision,
                            RouteAction::Direct,
                            FlowOutcomeKind::Established,
                            Some(&metadata),
                            None,
                            started,
                        );
                        Ok(TcpFlowOutcome {
                            result: FlowHandleResult {
                                decision,
                                effective_action: RouteAction::Direct,
                                egress: Some(metadata),
                                error_code: None,
                                error: None,
                            },
                            stream: Some(stream),
                        })
                    }
                    Err(error) => {
                        self.emit(
                            context,
                            &decision,
                            RouteAction::Direct,
                            FlowOutcomeKind::Failed,
                            None,
                            Some(&error),
                            started,
                        );
                        Err(error)
                    }
                }
            }
            RouteAction::Proxy => {
                self.handle_proxy(context, decision, cancellation, started)
                    .await
            }
        }
    }

    async fn handle_proxy(
        &self,
        context: &FlowContext,
        decision: PolicyDecision,
        cancellation: &CancellationToken,
        started: Instant,
    ) -> Result<TcpFlowOutcome, EgressError> {
        let target = self.target_for(context);
        let proxy_result = match self.egress.connector() {
            Ok(connector) => {
                self.connect(connector.as_ref(), &target, cancellation)
                    .await
            }
            Err(error) => Err(error),
        };

        match proxy_result {
            Ok(stream) => {
                let metadata = stream.meta.clone();
                self.emit(
                    context,
                    &decision,
                    RouteAction::Proxy,
                    FlowOutcomeKind::Established,
                    Some(&metadata),
                    None,
                    started,
                );
                Ok(TcpFlowOutcome {
                    result: FlowHandleResult {
                        decision,
                        effective_action: RouteAction::Proxy,
                        egress: Some(metadata),
                        error_code: None,
                        error: None,
                    },
                    stream: Some(stream),
                })
            }
            Err(error) if matches!(error, EgressError::Cancelled { .. }) => {
                self.emit(
                    context,
                    &decision,
                    RouteAction::Block,
                    FlowOutcomeKind::Failed,
                    None,
                    Some(&error),
                    started,
                );
                Err(error)
            }
            Err(error) if self.egress_failure_action == EgressFailureAction::FailClosed => {
                self.emit(
                    context,
                    &decision,
                    RouteAction::Block,
                    FlowOutcomeKind::Blocked,
                    None,
                    Some(&error),
                    started,
                );
                Ok(TcpFlowOutcome {
                    result: FlowHandleResult {
                        decision,
                        effective_action: RouteAction::Block,
                        egress: None,
                        error_code: Some(error.code().into()),
                        error: Some(error.to_string()),
                    },
                    stream: None,
                })
            }
            Err(proxy_error) => {
                let direct = self
                    .connect(self.direct.as_ref(), &target, cancellation)
                    .await;
                match direct {
                    Ok(stream) => {
                        let metadata = stream.meta.clone();
                        self.emit(
                            context,
                            &decision,
                            RouteAction::Direct,
                            FlowOutcomeKind::FallbackDirect,
                            Some(&metadata),
                            Some(&proxy_error),
                            started,
                        );
                        Ok(TcpFlowOutcome {
                            result: FlowHandleResult {
                                decision,
                                effective_action: RouteAction::Direct,
                                egress: Some(metadata),
                                error_code: Some(proxy_error.code().into()),
                                error: Some(proxy_error.to_string()),
                            },
                            stream: Some(stream),
                        })
                    }
                    Err(direct_error) if matches!(direct_error, EgressError::Cancelled { .. }) => {
                        self.emit(
                            context,
                            &decision,
                            RouteAction::Block,
                            FlowOutcomeKind::Failed,
                            None,
                            Some(&direct_error),
                            started,
                        );
                        Err(direct_error)
                    }
                    Err(direct_error) => {
                        let combined = EgressError::Connect(format!(
                            "proxy attempt failed ({}); direct fallback failed ({})",
                            proxy_error.code(),
                            direct_error.code()
                        ));
                        self.emit(
                            context,
                            &decision,
                            RouteAction::Block,
                            FlowOutcomeKind::Failed,
                            None,
                            Some(&combined),
                            started,
                        );
                        Err(combined)
                    }
                }
            }
        }
    }

    /// Decide the effective UDP action. No UDP stream is opened here.
    pub fn decide_udp(&self, context: &FlowContext) -> Result<UdpFlowOutcome, EgressError> {
        if !context.protocol.eq_ignore_ascii_case("udp") {
            return Err(EgressError::Unavailable(format!(
                "decide_udp called with protocol={}",
                context.protocol
            )));
        }

        let decision = self.decide(context);
        let capability = self.egress.udp_capability();
        let (effective_action, reason) = match decision.action {
            RouteAction::Block => (RouteAction::Block, Some("route_policy_block".into())),
            // Explicit DIRECT/hard-bypass/local-network decisions stay direct.
            RouteAction::Direct => (RouteAction::Direct, None),
            RouteAction::Proxy => match self.udp_policy {
                UdpPolicy::Direct => (
                    RouteAction::Direct,
                    Some("udp_policy_direct_potential_leak".into()),
                ),
                UdpPolicy::Block => (
                    RouteAction::Block,
                    Some("udp_policy_block_for_tcp_only_egress".into()),
                ),
                UdpPolicy::ProxyIfSupported if capability == UdpEgressCapability::Supported => {
                    (RouteAction::Proxy, None)
                }
                UdpPolicy::ProxyIfSupported => (
                    RouteAction::Block,
                    Some("udp_proxy_capability_not_ready".into()),
                ),
            },
        };

        Ok(UdpFlowOutcome {
            decision,
            effective_action,
            egress_capability: capability,
            reason,
        })
    }

    async fn connect(
        &self,
        connector: &dyn EgressConnector,
        target: &EgressTarget,
        cancellation: &CancellationToken,
    ) -> Result<EgressStream, EgressError> {
        connect_controlled(
            connector,
            target,
            &ConnectControl::new(self.connect_timeout, cancellation.clone()),
        )
        .await
    }

    fn attribute(&self, context: &FlowContext) -> (AttributedHost, Option<String>) {
        let ip = context
            .dest_ip
            .as_deref()
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
            .map(|ip| ip.to_string());
        let mut hints = context.attribution.clone();
        // The capture adapter's canonical destination is authoritative. This
        // prevents a mismatched hint from selecting a different Fake-IP entry.
        hints.destination_ip = ip.clone();
        let hints = self.fake_ip.resolve_hints(hints);
        let mut attributed = attribute_hostname(&hints);
        if attributed.hostname.is_none() {
            attributed.hostname = context.dest_host.as_deref().and_then(normalize_hostname);
            if attributed.hostname.is_some() {
                attributed.source = HostnameSource::Unknown;
            }
        }
        (attributed, ip)
    }

    fn target_for(&self, context: &FlowContext) -> EgressTarget {
        let (attributed, ip) = self.attribute(context);
        EgressTarget {
            host: attributed.hostname.unwrap_or_default(),
            port: context.dest_port,
            ip,
        }
    }

    fn fixed_decision(
        &self,
        action: RouteAction,
        stage: &str,
        hostname_source: HostnameSource,
    ) -> PolicyDecision {
        PolicyDecision {
            action,
            matched_rule_original: None,
            matched_rule_source_id: None,
            matched_stage: stage.into(),
            hostname_source,
            profile_id: self.matcher.profile_id.clone(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit(
        &self,
        context: &FlowContext,
        decision: &PolicyDecision,
        effective_action: RouteAction,
        outcome: FlowOutcomeKind,
        metadata: Option<&EgressMetadata>,
        error: Option<&EgressError>,
        started: Instant,
    ) {
        self.stats.record(FlowStatsEvent {
            profile_id: decision.profile_id.clone(),
            protocol: context.protocol.to_ascii_lowercase(),
            hostname_source: decision.hostname_source,
            policy_action: decision.action,
            effective_action,
            outcome,
            connector: metadata.map(|metadata| metadata.connector.clone()),
            error_code: error.map(|error| error.code().into()),
            connect_millis: elapsed_millis(started),
        });
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn is_local_network_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_private()
                || ip.is_link_local()
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(ip) => {
            let octets = ip.octets();
            (octets[0] & 0xfe) == 0xfc || (octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use tokio::io::duplex;

    use super::*;
    use crate::sockscap::flow::stats::InMemoryFlowStats;
    use crate::sockscap::policy::rules::parse_rule_document;

    fn matcher(document: &str) -> Arc<ProfileMatcher> {
        let report = parse_rule_document("gfw", document);
        Arc::new(ProfileMatcher::from_parts(
            "profile-1",
            RouteAction::Direct,
            RouteAction::Direct,
            vec![],
            &report.direct_rules,
            &report.proxy_rules,
        ))
    }

    fn engine(document: &str, egress: EgressProvider) -> FlowEngine {
        FlowEngine::new(
            matcher(document),
            HardBypassSet::new(),
            FakeIpMap::new(),
            egress,
            UdpPolicy::Block,
            EgressFailureAction::FailOpen,
            LocalNetworkPolicy {
                lan_action: LocalNetworkAction::Rules,
            },
        )
    }

    fn context(host: &str, protocol: &str) -> FlowContext {
        FlowContext {
            platform: CapturePlatform::Linux,
            pid: Some(123),
            process_start_time: Some(456),
            app_selector_kind: Some(AppSelectorKind::ExecutablePath),
            app_identity: Some("/usr/bin/test-app".into()),
            protocol: protocol.into(),
            source_ip: Some("192.0.2.10".into()),
            source_port: Some(50_000),
            dest_host: Some(host.into()),
            dest_ip: Some("203.0.113.10".into()),
            dest_port: 443,
            attribution: AttributionHints {
                tls_sni: Some(host.into()),
                ..Default::default()
            },
        }
    }

    struct MemoryConnector {
        name: &'static str,
        fail: Option<EgressError>,
        upstream: Option<super::super::bypass::BypassEndpoint>,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl EgressConnector for MemoryConnector {
        fn name(&self) -> &'static str {
            self.name
        }

        fn upstream_endpoint(&self) -> Option<super::super::bypass::BypassEndpoint> {
            self.upstream.clone()
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = &self.fail {
                return Err(error.clone());
            }
            let (stream, _peer) = duplex(64);
            Ok(EgressStream {
                stream: Box::new(stream),
                meta: EgressMetadata {
                    connector: self.name.into(),
                    remote_dns: self.name != "direct",
                    tcp_only: true,
                    detail: "test connector".into(),
                },
            })
        }
    }

    fn memory_connector(
        name: &'static str,
        fail: Option<EgressError>,
    ) -> (Arc<dyn EgressConnector>, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        (
            Arc::new(MemoryConnector {
                name,
                fail,
                upstream: None,
                calls: calls.clone(),
            }),
            calls,
        )
    }

    #[test]
    fn flow_context_serializes_complete_capture_identity() {
        let value = serde_json::to_value(context("example.com", "tcp")).unwrap();
        assert_eq!(value["platform"], "linux");
        assert_eq!(value["processStartTime"], 456);
        assert_eq!(value["appSelectorKind"], "executable_path");
        assert_eq!(value["sourcePort"], 50_000);
    }

    #[test]
    fn domain_attribution_drives_proxy_policy() {
        let engine = engine(
            "||google.com\n",
            EgressProvider::unavailable("not needed for decision"),
        );
        let decision = engine.decide(&context("WWW.GOOGLE.COM", "tcp"));
        assert_eq!(decision.action, RouteAction::Proxy);
        assert_eq!(decision.hostname_source, HostnameSource::TlsSni);
    }

    #[test]
    fn configured_upstream_endpoint_is_automatically_hard_bypassed() {
        let calls = Arc::new(AtomicUsize::new(0));
        let connector = Arc::new(MemoryConnector {
            name: "proxy",
            fail: None,
            upstream: Some(super::super::bypass::BypassEndpoint {
                host: "proxy.example".into(),
                port: Some(1080),
            }),
            calls,
        });
        let engine = engine(
            "||proxy.example\n",
            EgressProvider::from_connector(connector),
        );
        let mut flow = context("proxy.example", "tcp");
        flow.dest_port = 1080;
        assert_eq!(engine.decide(&flow).matched_stage, "hard_bypass");
        flow.dest_port = 1081;
        assert_eq!(engine.decide(&flow).action, RouteAction::Proxy);
    }

    #[test]
    fn local_network_policy_is_explicit() {
        let mut flow = context("nas.example", "tcp");
        flow.dest_ip = Some("192.168.1.10".into());

        let direct = FlowEngine::new(
            matcher("||nas.example\n"),
            HardBypassSet::new(),
            FakeIpMap::new(),
            EgressProvider::unavailable("unused"),
            UdpPolicy::Block,
            EgressFailureAction::FailOpen,
            LocalNetworkPolicy {
                lan_action: LocalNetworkAction::Direct,
            },
        );
        assert_eq!(direct.decide(&flow).matched_stage, "local_network_direct");

        let block = FlowEngine::new(
            matcher(""),
            HardBypassSet::new(),
            FakeIpMap::new(),
            EgressProvider::unavailable("unused"),
            UdpPolicy::Block,
            EgressFailureAction::FailOpen,
            LocalNetworkPolicy {
                lan_action: LocalNetworkAction::Block,
            },
        );
        assert_eq!(block.decide(&flow).action, RouteAction::Block);
    }

    #[test]
    fn missing_proxy_configuration_is_rejected_not_direct() {
        let error = EgressProvider::from_kind(Some(EgressKind::ProxySession), None).unwrap_err();
        assert!(matches!(error, EgressError::Unavailable(_)));
        assert!(EgressProvider::from_kind(None, None).is_err());
    }

    #[tokio::test]
    async fn fail_open_reports_effective_direct_and_counts_it_as_direct() {
        let (proxy, proxy_calls) = memory_connector(
            "proxy",
            Some(EgressError::Connect("upstream unavailable".into())),
        );
        let (direct, direct_calls) = memory_connector("direct", None);
        let stats = Arc::new(InMemoryFlowStats::default());
        let engine = engine("||example.com\n", EgressProvider::from_connector(proxy))
            .with_direct_connector(direct)
            .with_stats_sink(stats.clone());

        let outcome = engine
            .handle_tcp(&context("example.com", "tcp"))
            .await
            .unwrap();
        assert_eq!(outcome.result.decision.action, RouteAction::Proxy);
        assert_eq!(outcome.result.effective_action, RouteAction::Direct);
        assert_eq!(outcome.result.egress.unwrap().connector, "direct");
        assert_eq!(outcome.result.error_code.as_deref(), Some("connect_failed"));
        assert_eq!(proxy_calls.load(Ordering::SeqCst), 1);
        assert_eq!(direct_calls.load(Ordering::SeqCst), 1);
        let snapshot = stats.snapshot();
        assert_eq!(snapshot.direct, 1);
        assert_eq!(snapshot.proxy, 0);
        assert_eq!(snapshot.fallback_direct, 1);
    }

    #[tokio::test]
    async fn fail_closed_returns_an_explicit_block_outcome() {
        let (proxy, _) = memory_connector(
            "proxy",
            Some(EgressError::Connect("upstream unavailable".into())),
        );
        let mut engine = engine("||example.com\n", EgressProvider::from_connector(proxy));
        engine.egress_failure_action = EgressFailureAction::FailClosed;

        let outcome = engine
            .handle_tcp(&context("example.com", "tcp"))
            .await
            .unwrap();
        assert_eq!(outcome.result.decision.action, RouteAction::Proxy);
        assert_eq!(outcome.result.effective_action, RouteAction::Block);
        assert!(outcome.stream.is_none());
    }

    struct PendingConnector;

    #[async_trait]
    impl EgressConnector for PendingConnector {
        fn name(&self) -> &'static str {
            "pending"
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            pending().await
        }
    }

    #[tokio::test]
    async fn cancellation_never_triggers_fail_open_direct() {
        let (direct, direct_calls) = memory_connector("direct", None);
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let engine = engine(
            "||example.com\n",
            EgressProvider::from_connector(Arc::new(PendingConnector)),
        )
        .with_direct_connector(direct);

        let error = engine
            .handle_tcp_with_cancel(&context("example.com", "tcp"), &cancellation)
            .await
            .unwrap_err();
        assert!(matches!(error, EgressError::Cancelled { .. }));
        assert_eq!(direct_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn proxy_timeout_honors_fail_closed() {
        let mut engine = engine(
            "||example.com\n",
            EgressProvider::from_connector(Arc::new(PendingConnector)),
        )
        .with_connect_timeout(Duration::from_millis(5));
        engine.egress_failure_action = EgressFailureAction::FailClosed;

        let outcome = engine
            .handle_tcp(&context("example.com", "tcp"))
            .await
            .unwrap();
        assert_eq!(outcome.result.effective_action, RouteAction::Block);
        assert_eq!(outcome.result.error_code.as_deref(), Some("timeout"));
    }

    #[test]
    fn udp_never_overrides_route_block_or_claims_unprobed_proxy() {
        let blocked_matcher = {
            Arc::new(ProfileMatcher::from_parts(
                "profile-1",
                RouteAction::Direct,
                RouteAction::Direct,
                vec![crate::sockscap::policy::rules::CompiledRule {
                    action: RouteAction::Block,
                    kind: crate::sockscap::policy::rules::RuleKind::DomainSuffix,
                    pattern: "blocked.example".into(),
                    original: "BLOCK blocked.example".into(),
                    source_id: "manual".into(),
                }],
                &[],
                &[],
            ))
        };
        let (socks_like, _) = memory_connector("socks5", None);
        let blocked_engine = FlowEngine::new(
            blocked_matcher,
            HardBypassSet::new(),
            FakeIpMap::new(),
            EgressProvider::from_connector(socks_like),
            UdpPolicy::Direct,
            EgressFailureAction::FailOpen,
            LocalNetworkPolicy {
                lan_action: LocalNetworkAction::Rules,
            },
        );
        let blocked = blocked_engine
            .decide_udp(&context("blocked.example", "udp"))
            .unwrap();
        assert_eq!(blocked.decision.action, RouteAction::Block);
        assert_eq!(blocked.effective_action, RouteAction::Block);

        let explicit_direct = engine("", EgressProvider::unavailable("no UDP provider"))
            .decide_udp(&context("direct.example", "udp"))
            .unwrap();
        assert_eq!(explicit_direct.decision.action, RouteAction::Direct);
        assert_eq!(explicit_direct.effective_action, RouteAction::Direct);

        let mut proxy_engine = engine(
            "||proxy.example\n",
            EgressProvider::unavailable("no UDP provider"),
        );
        proxy_engine.udp_policy = UdpPolicy::ProxyIfSupported;
        let proxied = proxy_engine
            .decide_udp(&context("proxy.example", "udp"))
            .unwrap();
        assert_eq!(proxied.decision.action, RouteAction::Proxy);
        assert_eq!(proxied.effective_action, RouteAction::Block);
        assert_eq!(
            proxied.reason.as_deref(),
            Some("udp_proxy_capability_not_ready")
        );
    }
}
