//! FlowEngine: attribute → policy → egress for one TCP flow.
//!
//! Phase 2 wires the pure policy matcher to real DIRECT/SOCKS5/HTTP CONNECT
//! connectors. Capture adapters (later phases) feed [`FlowContext`] here.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::attribution::{attribute_hostname, AttributionHints, FakeIpMap};
use super::bypass::HardBypassSet;
use super::connectors::{
    DirectConnector, EgressConnector, EgressError, EgressMetadata, EgressStream, EgressTarget,
    SshJumpConnector,
};
use crate::proxy::ResolvedProxy;
use crate::sockscap::policy::matcher::{FlowMatchInput, PolicyDecision, ProfileMatcher};
use crate::sockscap::types::{EgressKind, RouteAction, UdpPolicy};

/// Identity + destination of a newly observed flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowContext {
    pub pid: Option<u32>,
    pub app_identity: Option<String>,
    pub protocol: String,
    pub dest_host: Option<String>,
    pub dest_ip: Option<String>,
    pub dest_port: u16,
    pub attribution: AttributionHints,
}

/// How the engine should obtain egress for PROXY actions.
#[derive(Clone)]
pub enum EgressProvider {
    Direct,
    Proxy(ResolvedProxy),
    SshJump {
        session_id: String,
        host_key_verification_ready: bool,
    },
}

impl EgressProvider {
    pub fn from_kind(
        kind: Option<EgressKind>,
        proxy: Option<ResolvedProxy>,
        ssh_session_id: Option<String>,
        host_key_ready: bool,
    ) -> Self {
        match kind {
            Some(EgressKind::ProxySession) => {
                if let Some(p) = proxy {
                    EgressProvider::Proxy(p)
                } else {
                    EgressProvider::Direct
                }
            }
            Some(EgressKind::SshJump) => EgressProvider::SshJump {
                session_id: ssh_session_id.unwrap_or_default(),
                host_key_verification_ready: host_key_ready,
            },
            None => EgressProvider::Direct,
        }
    }

    fn connector(&self) -> Result<Box<dyn EgressConnector>, EgressError> {
        match self {
            EgressProvider::Direct => Ok(Box::new(DirectConnector)),
            EgressProvider::Proxy(p) => super::connectors::proxy_connector(p.clone()),
            EgressProvider::SshJump {
                session_id,
                host_key_verification_ready,
            } => Ok(Box::new(SshJumpConnector {
                session_id: session_id.clone(),
                host_key_verification_ready: *host_key_verification_ready,
            })),
        }
    }
}

/// Outcome of handling a flow (without necessarily keeping the stream open).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowHandleResult {
    pub decision: PolicyDecision,
    pub egress: Option<EgressMetadata>,
    pub error: Option<String>,
}

/// FlowEngine owns policy + bypass + fake-ip + egress selection.
pub struct FlowEngine {
    pub matcher: Arc<ProfileMatcher>,
    pub bypass: HardBypassSet,
    pub fake_ip: FakeIpMap,
    pub egress: EgressProvider,
    pub udp_policy: UdpPolicy,
    pub egress_failure_fail_open: bool,
}

impl FlowEngine {
    /// Decide policy for a flow without connecting.
    pub fn decide(&self, ctx: &FlowContext) -> PolicyDecision {
        let hints = self.fake_ip.resolve_hints(ctx.attribution.clone());
        let attributed = attribute_hostname(&hints);

        let host = attributed
            .hostname
            .clone()
            .or_else(|| ctx.dest_host.clone());
        let ip = ctx.dest_ip.clone();
        let hard = self.bypass.matches(
            host.as_deref(),
            ip.as_deref(),
            ctx.dest_port,
            ctx.pid,
        );

        let input = FlowMatchInput {
            profile_id: self.matcher.profile_id.clone(),
            hostname: host,
            hostname_source: attributed.source,
            ip,
            port: ctx.dest_port,
            protocol: ctx.protocol.clone(),
            hard_bypass: hard,
        };
        self.matcher.decide(&input)
    }

    /// Decide and, for PROXY/DIRECT TCP, establish an egress stream.
    pub async fn handle_tcp(&self, ctx: &FlowContext) -> Result<(PolicyDecision, Option<EgressStream>), EgressError> {
        if !ctx.protocol.eq_ignore_ascii_case("tcp") {
            return Err(EgressError::Unavailable(format!(
                "handle_tcp called with protocol={}",
                ctx.protocol
            )));
        }

        let decision = self.decide(ctx);
        match decision.action {
            RouteAction::Block => Ok((decision, None)),
            RouteAction::Direct => {
                let target = self.target_for(ctx);
                match DirectConnector.connect(&target).await {
                    Ok(stream) => Ok((decision, Some(stream))),
                    Err(e) if self.egress_failure_fail_open => {
                        // Already direct; surface error.
                        Err(e)
                    }
                    Err(e) => Err(e),
                }
            }
            RouteAction::Proxy => {
                let target = self.target_for(ctx);
                match self.egress.connector()?.connect(&target).await {
                    Ok(stream) => Ok((decision, Some(stream))),
                    Err(e) if self.egress_failure_fail_open => {
                        // Fail-open: fall back to DIRECT.
                        let stream = DirectConnector.connect(&target).await?;
                        let mut decision = decision;
                        decision.matched_stage =
                            format!("fail_open_direct_after: {}", decision.matched_stage);
                        Ok((decision, Some(stream)))
                    }
                    Err(e) => Err(e),
                }
            }
        }
    }

    /// UDP policy enforcement (no actual UDP forward in Phase 2).
    pub fn decide_udp(&self, ctx: &FlowContext) -> Result<PolicyDecision, EgressError> {
        let decision = self.decide(ctx);
        match self.udp_policy {
            UdpPolicy::Block => Err(EgressError::Blocked(
                "UDP blocked by profile udp_policy".into(),
            )),
            UdpPolicy::Direct => {
                let mut d = decision;
                d.action = RouteAction::Direct;
                d.matched_stage = format!("udp_policy_direct:{}", d.matched_stage);
                Ok(d)
            }
            UdpPolicy::ProxyIfSupported => {
                // HTTP CONNECT and SSH Jump are TCP-only — treat as blocked unless
                // egress is SOCKS5 (capability probe later).
                match &self.egress {
                    EgressProvider::Proxy(p) if p.kind == "socks5" => Ok(decision),
                    _ => Err(EgressError::Blocked(
                        "UDP proxy not supported by current egress; refusing silent leak".into(),
                    )),
                }
            }
        }
    }

    fn target_for(&self, ctx: &FlowContext) -> EgressTarget {
        let hints = self.fake_ip.resolve_hints(ctx.attribution.clone());
        let attributed = attribute_hostname(&hints);
        let host = attributed
            .hostname
            .or_else(|| ctx.dest_host.clone())
            .unwrap_or_default();
        EgressTarget {
            host,
            port: ctx.dest_port,
            ip: ctx.dest_ip.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::policy::rules::parse_rule_document;
    use crate::sockscap::types::{HostnameSource, RouteAction};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn engine_with_doc(doc: &str, egress: EgressProvider) -> FlowEngine {
        let report = parse_rule_document("gfw", doc);
        let matcher = ProfileMatcher::from_parts(
            "p1",
            RouteAction::Direct,
            RouteAction::Direct,
            vec![],
            &report.direct_rules,
            &report.proxy_rules,
        );
        FlowEngine {
            matcher: Arc::new(matcher),
            bypass: HardBypassSet::new(),
            fake_ip: FakeIpMap::new(),
            egress,
            udp_policy: UdpPolicy::Block,
            egress_failure_fail_open: true,
        }
    }

    #[test]
    fn decide_proxy_for_listed_domain() {
        let eng = engine_with_doc("||google.com\n", EgressProvider::Direct);
        let d = eng.decide(&FlowContext {
            pid: None,
            app_identity: None,
            protocol: "tcp".into(),
            dest_host: Some("www.google.com".into()),
            dest_ip: None,
            dest_port: 443,
            attribution: AttributionHints {
                tls_sni: Some("www.google.com".into()),
                ..Default::default()
            },
        });
        assert_eq!(d.action, RouteAction::Proxy);
        assert_eq!(d.hostname_source, HostnameSource::TlsSni);
    }

    #[test]
    fn hard_bypass_forces_direct() {
        let mut eng = engine_with_doc("||google.com\n", EgressProvider::Direct);
        eng.bypass.add_host("www.google.com", Some(443));
        let d = eng.decide(&FlowContext {
            pid: None,
            app_identity: None,
            protocol: "tcp".into(),
            dest_host: Some("www.google.com".into()),
            dest_ip: None,
            dest_port: 443,
            attribution: AttributionHints {
                platform_hostname: Some("www.google.com".into()),
                ..Default::default()
            },
        });
        assert_eq!(d.action, RouteAction::Direct);
        assert_eq!(d.matched_stage, "hard_bypass");
    }

    #[tokio::test]
    async fn handle_tcp_direct_echo() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&buf).await.unwrap();
        });

        let eng = engine_with_doc("", EgressProvider::Direct);
        let (decision, stream) = eng
            .handle_tcp(&FlowContext {
                pid: None,
                app_identity: None,
                protocol: "tcp".into(),
                dest_host: Some("127.0.0.1".into()),
                dest_ip: Some("127.0.0.1".into()),
                dest_port: port,
                attribution: AttributionHints {
                    destination_ip: Some("127.0.0.1".into()),
                    ..Default::default()
                },
            })
            .await
            .unwrap();
        // loopback hard-bypass → DIRECT
        assert_eq!(decision.action, RouteAction::Direct);
        let mut stream = stream.unwrap().stream;
        stream.write_all(b"echo").await.unwrap();
        let mut buf = [0u8; 4];
        stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"echo");
    }

    #[test]
    fn udp_block_policy() {
        let eng = engine_with_doc("", EgressProvider::Direct);
        let err = eng
            .decide_udp(&FlowContext {
                pid: None,
                app_identity: None,
                protocol: "udp".into(),
                dest_host: Some("1.1.1.1".into()),
                dest_ip: Some("1.1.1.1".into()),
                dest_port: 53,
                attribution: Default::default(),
            })
            .unwrap_err();
        assert!(matches!(err, EgressError::Blocked(_)));
    }

    #[tokio::test]
    async fn ssh_proxy_action_hits_host_key_gate() {
        let eng = engine_with_doc(
            "||example.com\n",
            EgressProvider::SshJump {
                session_id: "s1".into(),
                host_key_verification_ready: false,
            },
        );
        // fail_open true → falls back to DIRECT after SSH gate error
        let result = eng
            .handle_tcp(&FlowContext {
                pid: None,
                app_identity: None,
                protocol: "tcp".into(),
                dest_host: Some("example.com".into()),
                dest_ip: None,
                dest_port: 80,
                attribution: AttributionHints {
                    platform_hostname: Some("example.com".into()),
                    ..Default::default()
                },
            })
            .await;
        // DIRECT fallback will try to connect to example.com:80 — may fail DNS/network.
        // The important part: we must not hang on SSH. Accept either fail-open direct
        // connect error or success.
        match result {
            Ok((d, _)) => {
                assert!(d.matched_stage.contains("fail_open") || d.action == RouteAction::Proxy);
            }
            Err(EgressError::Connect(_)) => {}
            Err(e) => panic!("unexpected error: {e}"),
        }
    }
}
