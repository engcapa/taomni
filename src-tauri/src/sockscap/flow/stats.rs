//! Privacy-bounded flow statistics events and an in-memory hot-path sink.
//!
//! Events contain policy/effective actions and aggregate timing only. They do
//! not contain payload, URLs, hostnames, usernames, credentials, or MFA data.

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Hard memory bound for privacy-safe recent flow outcomes.
pub const MAX_LIVE_CONNECTION_SAMPLES: usize = 256;
/// IPC callers cannot request an arbitrarily large projection of the ring.
pub const MAX_LIVE_CONNECTION_QUERY_LIMIT: u16 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConnectionsQuery {
    #[serde(default)]
    pub since_unix: Option<u64>,
    pub limit: u16,
}

impl LiveConnectionsQuery {
    fn validate(&self) -> Result<(), String> {
        if self.limit == 0 || self.limit > MAX_LIVE_CONNECTION_QUERY_LIMIT {
            return Err(format!(
                "LIVE_CONNECTIONS_INVALID_LIMIT: limit must be between 1 and {MAX_LIVE_CONNECTION_QUERY_LIMIT}"
            ));
        }
        Ok(())
    }
}

/// A completed or rejected flow outcome, deliberately excluding endpoint and
/// application identity. This is not packet capture or current-socket state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConnectionSample {
    pub sample_id: u64,
    pub observed_at_unix: u64,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConnectionsSnapshot {
    pub generated_at_unix: u64,
    pub capacity: u16,
    pub dropped_samples: u64,
    pub samples: Vec<LiveConnectionSample>,
}

/// Session-memory sampler for the Dashboard's bounded recent-outcomes view.
///
/// It starts with no enabled profiles. A capture runtime must explicitly opt
/// in profiles whose statistics mode is not `disabled` before handing this
/// sampler to a `FlowEngine`.
#[derive(Debug, Default)]
pub struct LiveFlowSampler {
    enabled_profiles: RwLock<HashSet<String>>,
    next_sample_id: AtomicU64,
    dropped_samples: AtomicU64,
    samples: Mutex<VecDeque<LiveConnectionSample>>,
}

impl LiveFlowSampler {
    pub fn set_enabled_profiles<I>(&self, profile_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        let next = profile_ids.into_iter().collect();
        match self.enabled_profiles.write() {
            Ok(mut guard) => *guard = next,
            Err(poisoned) => *poisoned.into_inner() = next,
        }
    }

    pub fn disable(&self) {
        self.set_enabled_profiles(std::iter::empty());
    }

    pub fn snapshot(
        &self,
        query: &LiveConnectionsQuery,
    ) -> Result<LiveConnectionsSnapshot, String> {
        query.validate()?;
        let samples = match self.samples.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let samples = samples
            .iter()
            .filter(|sample| {
                query
                    .since_unix
                    .is_none_or(|since| sample.observed_at_unix >= since)
            })
            .take(usize::from(query.limit))
            .cloned()
            .collect();
        Ok(LiveConnectionsSnapshot {
            generated_at_unix: unix_now(),
            capacity: MAX_LIVE_CONNECTION_SAMPLES as u16,
            dropped_samples: self.dropped_samples.load(Ordering::Relaxed),
            samples,
        })
    }

    pub fn clear(&self) -> u64 {
        let mut samples = match self.samples.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let removed = samples.len() as u64;
        samples.clear();
        self.dropped_samples.store(0, Ordering::Relaxed);
        removed
    }

    fn profile_enabled(&self, profile_id: &str) -> bool {
        match self.enabled_profiles.read() {
            Ok(guard) => guard.contains(profile_id),
            Err(poisoned) => poisoned.into_inner().contains(profile_id),
        }
    }
}

impl FlowStatsSink for LiveFlowSampler {
    fn record(&self, event: FlowStatsEvent) {
        if !self.profile_enabled(&event.profile_id) {
            return;
        }
        let sample = LiveConnectionSample {
            sample_id: self.next_sample_id.fetch_add(1, Ordering::Relaxed) + 1,
            observed_at_unix: unix_now(),
            profile_id: event.profile_id,
            protocol: event.protocol,
            hostname_source: event.hostname_source,
            policy_action: event.policy_action,
            effective_action: event.effective_action,
            outcome: event.outcome,
            connector: event.connector,
            error_code: event.error_code,
            connect_millis: event.connect_millis,
        };
        let mut samples = match self.samples.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        samples.push_front(sample);
        if samples.len() > MAX_LIVE_CONNECTION_SAMPLES {
            samples.pop_back();
            self.dropped_samples.fetch_add(1, Ordering::Relaxed);
        }
    }
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

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
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

    #[test]
    fn live_sampler_is_opt_in_bounded_filterable_and_privacy_safe() {
        let sampler = LiveFlowSampler::default();
        let event = || FlowStatsEvent {
            profile_id: "profile-1".into(),
            protocol: "tcp".into(),
            hostname_source: HostnameSource::TlsSni,
            policy_action: RouteAction::Proxy,
            effective_action: RouteAction::Proxy,
            outcome: FlowOutcomeKind::Established,
            connector: Some("socks5".into()),
            error_code: None,
            connect_millis: 3,
        };

        sampler.record(event());
        assert!(
            sampler
                .snapshot(&LiveConnectionsQuery {
                    since_unix: None,
                    limit: 10,
                })
                .unwrap()
                .samples
                .is_empty()
        );

        sampler.set_enabled_profiles(["profile-1".to_string()]);
        for _ in 0..MAX_LIVE_CONNECTION_SAMPLES + 3 {
            sampler.record(event());
        }
        let snapshot = sampler
            .snapshot(&LiveConnectionsQuery {
                since_unix: Some(0),
                limit: MAX_LIVE_CONNECTION_QUERY_LIMIT,
            })
            .unwrap();
        assert_eq!(snapshot.samples.len(), 200);
        assert_eq!(snapshot.capacity, 256);
        assert_eq!(snapshot.dropped_samples, 3);
        assert!(
            snapshot
                .samples
                .windows(2)
                .all(|pair| pair[0].sample_id > pair[1].sample_id)
        );

        let serialized = serde_json::to_value(&snapshot.samples[0]).unwrap();
        for forbidden in [
            "hostname",
            "domain",
            "application",
            "executablePath",
            "username",
            "password",
            "payload",
            "url",
        ] {
            assert!(serialized.get(forbidden).is_none(), "found {forbidden}");
        }
        assert_eq!(sampler.clear(), MAX_LIVE_CONNECTION_SAMPLES as u64);
        assert!(
            sampler
                .snapshot(&LiveConnectionsQuery {
                    since_unix: None,
                    limit: 1
                })
                .unwrap()
                .samples
                .is_empty()
        );
    }

    #[test]
    fn live_sampler_rejects_unbounded_queries() {
        let sampler = LiveFlowSampler::default();
        for limit in [0, MAX_LIVE_CONNECTION_QUERY_LIMIT + 1] {
            let error = sampler
                .snapshot(&LiveConnectionsQuery {
                    since_unix: None,
                    limit,
                })
                .expect_err("invalid limit must fail");
            assert!(error.contains("LIVE_CONNECTIONS_INVALID_LIMIT"));
        }
    }
}
