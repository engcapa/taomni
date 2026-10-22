use crate::sockscap::config::SocksCapConfig;
use crate::sockscap::config::UpstreamKind;
use crate::sockscap::egress::ssh_pool::SshPool;
use crate::sockscap::helper;
use crate::sockscap::helper::HelperRegistry;
use crate::sockscap::policy::PolicyEngine;
use crate::sockscap::rules::CompiledRules;
use crate::sockscap::rules::dns_map::DnsMap;
use crate::sockscap::stats::StatsCounters;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct ResolvedUpstream {
    pub kind: UpstreamKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub ssh_pool: Option<Arc<SshPool>>,
    /// Loopback SOCKS port of this profile's xray-core sidecar, when the
    /// upstream kind is core-backed (shadowsocks/trojan/vmess/vless/wireguard).
    /// The relay dials this port through the plain socks5 egress.
    pub xray_port: Option<u16>,
}

pub struct RelayContext {
    pub config: SocksCapConfig,
    pub rules: Option<CompiledRules>,
    /// Policy engine compiled from `config` + `rules`.
    ///
    /// Built once per configuration, not once per connection. Building it clones
    /// the entire compiled rule set — thousands of `String`s and every compiled
    /// regex for a full GFWList — so doing it per flow was a large allocation
    /// burst on the connection-setup path. Keep in sync via [`Self::rebuild_engine`].
    pub engine: Arc<PolicyEngine>,
    pub helper: Arc<HelperRegistry>,
    /// Long-lived control channel to the elevated helper (Windows capture).
    /// `None` on backends that recover the destination locally, such as Linux's
    /// `SO_ORIGINAL_DST`.
    pub helper_client: Option<Arc<helper::HelperClient>>,
    pub stats: Arc<StatsCounters>,
    pub upstream_host: String,
    pub upstream_port: u16,
    pub upstream_user: String,
    pub upstream_pass: String,
    pub self_pid: u32,
    /// Shared SSH session when upstream kind is SSH.
    pub ssh_pool: Option<Arc<SshPool>>,
    /// Loopback SOCKS port of the global upstream's xray-core sidecar, when the
    /// global upstream kind is core-backed.
    pub xray_port: Option<u16>,
    pub profile_upstreams: std::collections::HashMap<String, ResolvedUpstream>,
    /// IP → hostname learned from SNI / HTTP Host.
    pub dns_map: Arc<Mutex<DnsMap>>,
    /// Domain & flow traffic tracker
    pub domains: Arc<Mutex<crate::sockscap::stats::DomainTracker>>,
}

impl RelayContext {
    /// Compile the policy engine for the current `config` + `rules`. Must be
    /// called after either is replaced, or flows keep using the old policy.
    pub fn rebuild_engine(&mut self) {
        self.engine = Arc::new(PolicyEngine::from_config(&self.config, self.rules.as_ref()));
    }

    /// Engine for a freshly built context.
    pub fn build_engine(
        config: &SocksCapConfig,
        rules: Option<&CompiledRules>,
    ) -> Arc<PolicyEngine> {
        Arc::new(PolicyEngine::from_config(config, rules))
    }
}

/// Metadata recovered by a capture backend before a connection enters the
/// shared policy relay. Windows obtains it from the WinDivert helper; Linux
/// reads `SO_ORIGINAL_DST` from the nftables-redirected socket; macOS receives
/// the destination and process identity in Redirector's `NewFlow` frame.
///
/// Transparent backends only ever learn an address, while a proxy handshake
/// carries the name the client actually asked for. `dest_host` therefore holds
/// an authoritative hostname when one is known, and at least one of
/// `dest_host` / `dest_ip` is always set.
#[derive(Debug, Clone)]
pub(crate) struct CapturedFlow {
    pub dest_ip: Option<IpAddr>,
    pub dest_host: Option<String>,
    pub dest_port: u16,
    pub process_path: Option<String>,
    pub pid: Option<u32>,
    pub origin: SocketAddr,
    pub profile_id_hint: Option<String>,
}

impl CapturedFlow {
    /// Build a flow whose destination was recovered as an address.
    pub(crate) fn from_destination(destination: SocketAddr, origin: SocketAddr) -> Self {
        Self {
            dest_ip: Some(destination.ip()),
            dest_host: None,
            dest_port: destination.port(),
            process_path: None,
            pid: None,
            origin,
            profile_id_hint: None,
        }
    }
}

/// Resolve manual upstream fields from config.
pub fn upstream_from_config(cfg: &SocksCapConfig) -> (String, u16, String, String) {
    (
        cfg.upstream.host.clone(),
        cfg.upstream.port,
        cfg.upstream.username.clone(),
        String::new(),
    )
}

pub fn upstream_from_config_ref(
    up: &crate::sockscap::config::UpstreamRef,
) -> (String, u16, String, String) {
    (up.host.clone(), up.port, up.username.clone(), String::new())
}

pub fn relay_loopback_ip() -> Ipv4Addr {
    Ipv4Addr::new(127, 0, 0, 1)
}
