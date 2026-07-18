//! Privacy-bounded flow statistics events and an in-memory hot-path sink.
//!
//! Events contain policy/effective actions and aggregate timing only. They do
//! not contain payload, URLs, hostnames, usernames, credentials, or MFA data.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::sockscap::types::{HostnameSource, RouteAction};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowOutcomeKind {
    Established,
    Blocked,
    Failed,
    FallbackDirect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStatsEvent {
    pub profile_id: String,
    pub protocol: String,
    pub hostname_source: HostnameSource,
    pub policy_action: RouteAction,
    pub effective_action: RouteAction,
    pub outcome: FlowOutcomeKind,
    pub connector: Option<String>,
    pub error_code: Option<String>,
    pub connect_millis: u64,
}

pub trait FlowStatsSink: Send + Sync {
    fn record(&self, event: FlowStatsEvent);
}

#[derive(Debug, Default)]
pub struct NoopFlowStatsSink;

impl FlowStatsSink for NoopFlowStatsSink {
    fn record(&self, _event: FlowStatsEvent) {}
}

#[derive(Debug, Default)]
pub struct InMemoryFlowStats {
    established: AtomicU64,
    direct: AtomicU64,
    proxy: AtomicU64,
    blocked: AtomicU64,
    failed: AtomicU64,
    fallback_direct: AtomicU64,
    unknown_hostname: AtomicU64,
    connect_millis_total: AtomicU64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStatsSnapshot {
    pub established: u64,
    pub direct: u64,
    pub proxy: u64,
    pub blocked: u64,
    pub failed: u64,
    pub fallback_direct: u64,
    pub unknown_hostname: u64,
    pub connect_millis_total: u64,
}

impl InMemoryFlowStats {
    pub fn snapshot(&self) -> FlowStatsSnapshot {
        FlowStatsSnapshot {
            established: self.established.load(Ordering::Relaxed),
            direct: self.direct.load(Ordering::Relaxed),
            proxy: self.proxy.load(Ordering::Relaxed),
            blocked: self.blocked.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            fallback_direct: self.fallback_direct.load(Ordering::Relaxed),
            unknown_hostname: self.unknown_hostname.load(Ordering::Relaxed),
            connect_millis_total: self.connect_millis_total.load(Ordering::Relaxed),
        }
    }
}

impl FlowStatsSink for InMemoryFlowStats {
    fn record(&self, event: FlowStatsEvent) {
        if matches!(
            event.hostname_source,
            HostnameSource::Unknown | HostnameSource::IpOnly
        ) {
            self.unknown_hostname.fetch_add(1, Ordering::Relaxed);
        }
        self.connect_millis_total
            .fetch_add(event.connect_millis, Ordering::Relaxed);

        match event.outcome {
            FlowOutcomeKind::Established => {
                self.established.fetch_add(1, Ordering::Relaxed);
                match event.effective_action {
                    RouteAction::Direct => {
                        self.direct.fetch_add(1, Ordering::Relaxed);
                    }
                    RouteAction::Proxy => {
                        self.proxy.fetch_add(1, Ordering::Relaxed);
                    }
                    RouteAction::Block => {
                        self.blocked.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            FlowOutcomeKind::Blocked => {
                self.blocked.fetch_add(1, Ordering::Relaxed);
            }
            FlowOutcomeKind::Failed => {
                self.failed.fetch_add(1, Ordering::Relaxed);
            }
            FlowOutcomeKind::FallbackDirect => {
                self.established.fetch_add(1, Ordering::Relaxed);
                self.direct.fetch_add(1, Ordering::Relaxed);
                self.fallback_direct.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_counts_effective_action_without_sensitive_fields() {
        let stats = InMemoryFlowStats::default();
        stats.record(FlowStatsEvent {
            profile_id: "profile-1".into(),
            protocol: "tcp".into(),
            hostname_source: HostnameSource::Unknown,
            policy_action: RouteAction::Proxy,
            effective_action: RouteAction::Direct,
            outcome: FlowOutcomeKind::FallbackDirect,
            connector: Some("direct".into()),
            error_code: Some("connect_failed".into()),
            connect_millis: 12,
        });

        assert_eq!(
            stats.snapshot(),
            FlowStatsSnapshot {
                established: 1,
                direct: 1,
                proxy: 0,
                blocked: 0,
                failed: 0,
                fallback_direct: 1,
                unknown_hostname: 1,
                connect_millis_total: 12,
            }
        );

        let event_fields = serde_json::to_value(FlowStatsEvent {
            profile_id: "profile-1".into(),
            protocol: "tcp".into(),
            hostname_source: HostnameSource::TlsSni,
            policy_action: RouteAction::Proxy,
            effective_action: RouteAction::Proxy,
            outcome: FlowOutcomeKind::Established,
            connector: Some("socks5".into()),
            error_code: None,
            connect_millis: 3,
        })
        .unwrap();
        assert!(event_fields.get("hostname").is_none());
        assert!(event_fields.get("username").is_none());
        assert!(event_fields.get("payload").is_none());
    }
}
