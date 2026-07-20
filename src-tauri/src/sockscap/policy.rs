//! Policy decision engine (plan §6.3, §16.2, §16.3).
//!
//! Given a flow (attributed host / IP / protocol) and the compiled snapshot of
//! the profile that owns it, produce a [`Decision`] with full provenance so the
//! UI's "test target" can show the matched profile, rule source, rule text,
//! hostname source and final action (plan §6.3, §16.3-13).
//!
//! Decision order (immutable):
//!   1. Engine safety hard-bypass (loopback, helper, Taomni's own upstream).
//!   2. User ordered override rules — first-match wins.
//!   3. LAN policy short-circuit (DIRECT/BLOCK) unless `by-rule`.
//!   4. Subscription exception rules (all sources) ⇒ DIRECT.
//!   5. Subscription proxy rules (all sources) ⇒ PROXY.
//!   6. `unknown_domain_action` (host unattributed) or `default_action`.
//! UDP/ICMP protocol policy is then layered onto the chosen action.

use std::net::IpAddr;
use std::path::Path;

use super::matcher::{CompiledRuleSource, IpCidr};
use super::model::{
    AppSelector, CustomRule, LocalNetworkPolicy, RoutingProfile, RuleDirection, RulePattern,
    RuntimeProcessSelector, Scope, UdpPolicy,
};
use super::{Action, HostnameSource, Protocol};

/// The attributed flow a decision is made about.
#[derive(Debug, Clone)]
pub struct FlowTarget {
    pub host: Option<String>,
    pub hostname_source: HostnameSource,
    pub ip: Option<IpAddr>,
    pub port: u16,
    pub protocol: Protocol,
}

/// Why a particular action was chosen (for explainability).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionReason {
    HardBypass,
    CustomRule,
    LocalNetwork,
    SubscriptionException,
    SubscriptionProxy,
    UnknownDomainAction,
    DefaultAction,
    ProtocolPolicy,
}

/// A fully explained routing decision.
#[derive(Debug, Clone)]
pub struct Decision {
    pub action: Action,
    pub reason: DecisionReason,
    pub hostname_source: HostnameSource,
    pub matched_source_id: Option<String>,
    pub matched_pattern: Option<String>,
    /// Human note, e.g. how the protocol policy altered the base action.
    pub note: Option<String>,
}

/// Forced-DIRECT endpoints that must never be captured: loopback (always),
/// plus the Taomni/helper process endpoints and the active upstream endpoints
/// (proxy server / SSH jump host) so the engine can't recursively capture its
/// own control traffic (plan §6.3 step 1, §16.2-7).
#[derive(Debug, Clone, Default)]
pub struct HardBypass {
    pub endpoints: Vec<IpAddr>,
    pub hostnames: Vec<String>,
}

impl HardBypass {
    pub fn is_bypassed(&self, target: &FlowTarget) -> bool {
        if let Some(ip) = target.ip {
            if ip.is_loopback() || self.endpoints.contains(&ip) {
                return true;
            }
        }
        if let Some(host) = &target.host {
            let h = host.trim_end_matches('.').to_ascii_lowercase();
            if h == "localhost" || self.hostnames.iter().any(|x| x.eq_ignore_ascii_case(&h)) {
                return true;
            }
        }
        false
    }
}

/// The resolved identity of the process that opened a flow, used to pick the
/// owning profile (plan §5, §16.4). Every field is optional so one struct works
/// across platforms — a Windows flow simply won't populate the macOS/Linux
/// fields, and a macOS-only selector won't match it.
#[derive(Debug, Clone, Default)]
pub struct AppIdentity {
    pub windows_exe: Option<String>,
    pub macos_signing_id: Option<String>,
    pub macos_app_path: Option<String>,
    pub linux_path: Option<String>,
    pub linux_cgroup: Option<String>,
    pub pid: Option<u32>,
    pub process_start_time: Option<String>,
}

/// Normalize Windows paths for comparison: `/` → `\`, ASCII lowercase.
pub fn normalize_windows_path(path: &str) -> String {
    path.replace('/', "\\").to_ascii_lowercase()
}

/// Match Windows executables: full path (normalized) or same file name.
///
/// Real Edge may live under `Program Files` while the profile was saved with
/// `Program Files (x86)` (or vice versa). Basename matching keeps capture
/// working; full-path match still preferred when both sides agree.
pub fn windows_exe_paths_match(actual: &str, selector: &str) -> bool {
    let a = normalize_windows_path(actual);
    let s = normalize_windows_path(selector);
    if a == s {
        return true;
    }
    let a_name = Path::new(&a).file_name().and_then(|n| n.to_str());
    let s_name = Path::new(&s).file_name().and_then(|n| n.to_str());
    matches!((a_name, s_name), (Some(x), Some(y)) if x == y)
}

impl AppIdentity {
    fn matches_selector(&self, sel: &AppSelector) -> bool {
        match sel {
            AppSelector::WindowsExecutable(p) => self
                .windows_exe
                .as_deref()
                .map(|e| windows_exe_paths_match(e, p))
                .unwrap_or(false),
            AppSelector::MacosSigningIdentity(s) => {
                self.macos_signing_id.as_deref() == Some(s.as_str())
            }
            AppSelector::MacosAppPath(p) => self.macos_app_path.as_deref() == Some(p.as_str()),
            AppSelector::LinuxPath(p) => self.linux_path.as_deref() == Some(p.as_str()),
            AppSelector::LinuxCgroup(c) => self
                .linux_cgroup
                .as_deref()
                .map(|x| x.contains(c.as_str()))
                .unwrap_or(false),
        }
    }

    /// Runtime-process match requires BOTH the PID and its recorded start time,
    /// so a recycled PID cannot silently capture a different process
    /// (plan §5, §16.4-17).
    fn matches_runtime(&self, sel: &RuntimeProcessSelector) -> bool {
        self.pid == Some(sel.pid)
            && self.process_start_time.as_deref() == Some(sel.process_start_time.as_str())
    }
}

/// Select the profile that owns a flow: an application/runtime profile whose
/// selector matches wins by lowest `priority` number; if none match, the
/// enabled `Global` profile (if any) applies. `None` means no profile applies
/// and the flow is left uncaptured / direct (plan §5, §16.4-15).
pub fn select_profile<'a>(
    profiles: &'a [RoutingProfile],
    app: &AppIdentity,
) -> Option<&'a RoutingProfile> {
    let mut best: Option<&RoutingProfile> = None;
    for p in profiles.iter().filter(|p| p.enabled) {
        let matched = match p.scope {
            Scope::Global => false,
            Scope::Applications => p.app_selectors.iter().any(|s| app.matches_selector(s)),
            Scope::RuntimeProcesses => {
                p.runtime_processes.iter().any(|s| app.matches_runtime(s))
            }
        };
        if matched {
            best = match best {
                Some(cur) if cur.priority <= p.priority => Some(cur),
                _ => Some(p),
            };
        }
    }
    best.or_else(|| {
        profiles
            .iter()
            .find(|p| p.enabled && p.scope == Scope::Global)
    })
}

/// A custom override rule compiled into a cheap matchable form.
#[derive(Debug, Clone)]
pub struct CompiledCustomRule {
    pub id: String,
    pub action: RuleDirection,
    matcher: CustomMatcher,
    pub original: String,
}

#[derive(Debug, Clone)]
enum CustomMatcher {
    Suffix(String),
    Exact(String),
    Ip(IpCidr),
}

impl CompiledCustomRule {
    /// Compile a [`CustomRule`], skipping disabled rules and unparseable IPs.
    pub fn compile(rule: &CustomRule) -> Option<CompiledCustomRule> {
        if !rule.enabled {
            return None;
        }
        let matcher = match &rule.pattern {
            RulePattern::DomainSuffix(d) => CustomMatcher::Suffix(normalize(d)),
            RulePattern::DomainExact(d) => CustomMatcher::Exact(normalize(d)),
            RulePattern::Ip(s) | RulePattern::Cidr(s) => CustomMatcher::Ip(IpCidr::parse(s)?),
        };
        let original = match &rule.pattern {
            RulePattern::DomainSuffix(d) => format!("suffix:{d}"),
            RulePattern::DomainExact(d) => format!("exact:{d}"),
            RulePattern::Ip(s) => format!("ip:{s}"),
            RulePattern::Cidr(s) => format!("cidr:{s}"),
        };
        Some(CompiledCustomRule {
            id: rule.id.clone(),
            action: rule.action,
            matcher,
            original,
        })
    }

    fn matches(&self, target: &FlowTarget) -> bool {
        match &self.matcher {
            CustomMatcher::Suffix(d) => target
                .host
                .as_deref()
                .map(|h| host_has_suffix(&normalize(h), d))
                .unwrap_or(false),
            CustomMatcher::Exact(d) => target
                .host
                .as_deref()
                .map(|h| normalize(h) == *d)
                .unwrap_or(false),
            CustomMatcher::Ip(cidr) => target.ip.map(|ip| cidr.contains(ip)).unwrap_or(false),
        }
    }
}

fn normalize(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// True when `host` equals `suffix` or is a subdomain of it.
fn host_has_suffix(host: &str, suffix: &str) -> bool {
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

/// A profile compiled into its immutable decision snapshot: config + ordered
/// custom rules + rule sources in profile order. Built once; swapped atomically
/// on rule update (plan §16.4-14).
pub struct CompiledProfile {
    pub profile: RoutingProfile,
    /// Custom override rules, ascending `order`, disabled ones dropped.
    pub custom_rules: Vec<CompiledCustomRule>,
    /// Compiled subscription sources in `profile.rule_source_ids` order.
    pub sources: Vec<CompiledRuleSource>,
}

impl CompiledProfile {
    pub fn new(
        profile: RoutingProfile,
        mut custom_rules: Vec<CompiledCustomRule>,
        sources: Vec<CompiledRuleSource>,
    ) -> CompiledProfile {
        // Stable sort so equal `order` keeps insertion order (the caller passes
        // them pre-parsed; we re-sort defensively). Order is captured before
        // compile so we can't sort here — callers must sort input rules. We
        // keep the given order.
        let _ = &mut custom_rules;
        CompiledProfile {
            profile,
            custom_rules,
            sources,
        }
    }

    /// Decide the action for `target` under this profile, fully explained.
    pub fn decide(&self, bypass: &HardBypass, target: &FlowTarget) -> Decision {
        // Step 1: hard bypass.
        if bypass.is_bypassed(target) {
            return self.protocol_layer(
                target,
                Action::Direct,
                DecisionReason::HardBypass,
                None,
                None,
            );
        }

        // Step 2: user override rules, first-match wins.
        for rule in &self.custom_rules {
            if rule.matches(target) {
                let action = direction_to_action(rule.action);
                return self.protocol_layer(
                    target,
                    action,
                    DecisionReason::CustomRule,
                    None,
                    Some(rule.original.clone()),
                );
            }
        }

        // Step 3: LAN policy short-circuit (unless by-rule).
        if let Some(ip) = target.ip {
            if is_lan(ip) {
                match self.profile.local_network_policy {
                    LocalNetworkPolicy::Direct => {
                        return self.protocol_layer(
                            target,
                            Action::Direct,
                            DecisionReason::LocalNetwork,
                            None,
                            None,
                        );
                    }
                    LocalNetworkPolicy::Block => {
                        return self.protocol_layer(
                            target,
                            Action::Block,
                            DecisionReason::LocalNetwork,
                            None,
                            None,
                        );
                    }
                    LocalNetworkPolicy::ByRule => { /* fall through to rules */ }
                }
            }
        }

        let host = target.host.as_deref();

        // Step 4: subscription exceptions across ALL sources (⇒ DIRECT).
        for src in &self.sources {
            if let Some(hit) = src.lookup_exception(host, target.ip) {
                return self.protocol_layer(
                    target,
                    Action::Direct,
                    DecisionReason::SubscriptionException,
                    Some(hit.source_id),
                    Some(hit.pattern),
                );
            }
        }

        // Step 5: subscription proxy rules; earliest source wins.
        for src in &self.sources {
            if let Some(hit) = src.lookup_proxy(host, target.ip) {
                return self.protocol_layer(
                    target,
                    Action::Proxy,
                    DecisionReason::SubscriptionProxy,
                    Some(hit.source_id),
                    Some(hit.pattern),
                );
            }
        }

        // Step 6: nothing matched — unknown vs default.
        if target.hostname_source.is_unknown() {
            return self.protocol_layer(
                target,
                self.profile.unknown_domain_action,
                DecisionReason::UnknownDomainAction,
                None,
                None,
            );
        }
        self.protocol_layer(
            target,
            self.profile.default_action,
            DecisionReason::DefaultAction,
            None,
            None,
        )
    }

    /// Layer UDP / ICMP / other-protocol policy onto the base action. TCP is
    /// unchanged. This never silently downgrades — a UDP flow that a TCP-only
    /// upstream can't carry becomes an explicit DIRECT/BLOCK per policy
    /// (plan §7, §16.2-6/9).
    fn protocol_layer(
        &self,
        target: &FlowTarget,
        base: Action,
        reason: DecisionReason,
        source_id: Option<String>,
        pattern: Option<String>,
    ) -> Decision {
        let mut action = base;
        let mut note = None;
        match target.protocol {
            Protocol::Tcp => {}
            Protocol::Udp => {
                if base == Action::Proxy {
                    match self.profile.udp_policy {
                        UdpPolicy::ProxyIfSupported => {
                            note = Some("udp: proxy if upstream supports UDP".into());
                        }
                        UdpPolicy::Direct => {
                            action = Action::Direct;
                            note = Some("udp policy: direct (potential leak)".into());
                        }
                        UdpPolicy::Block => {
                            action = Action::Block;
                            note = Some("udp policy: block (push app to TCP)".into());
                        }
                    }
                }
            }
            Protocol::Icmp | Protocol::Other => {
                // ICMP / non-TCP-UDP: DIRECT, or BLOCK in a strict profile.
                if base == Action::Proxy {
                    action = if self.is_strict() {
                        Action::Block
                    } else {
                        Action::Direct
                    };
                    note = Some("non-tcp/udp protocol: not proxyable".into());
                }
            }
        }
        Decision {
            action,
            reason,
            hostname_source: target.hostname_source,
            matched_source_id: source_id,
            matched_pattern: pattern,
            note,
        }
    }

    /// A profile is "strict" when it prefers to block rather than leak: either
    /// unknown traffic is blocked or the egress fails closed (plan §16.2-8).
    fn is_strict(&self) -> bool {
        self.profile.unknown_domain_action == Action::Block
            || matches!(
                self.profile.egress_failure_action,
                super::model::EgressFailureAction::FailClosed
            )
    }
}

fn direction_to_action(d: RuleDirection) -> Action {
    match d {
        RuleDirection::Proxy => Action::Proxy,
        RuleDirection::Direct => Action::Direct,
        RuleDirection::Block => Action::Block,
    }
}

/// Whether an IP is LAN / private / link-local (loopback is handled earlier by
/// hard-bypass). CGNAT (100.64/10) is treated as LAN too.
pub fn is_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local() || {
                let o = v4.octets();
                o[0] == 100 && (o[1] & 0xC0) == 0x40 // 100.64.0.0/10
            }
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            (seg[0] & 0xFE00) == 0xFC00 // fc00::/7 ULA
                || (seg[0] & 0xFFC0) == 0xFE80 // fe80::/10 link-local
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::autoproxy;
    use crate::sockscap::model::{
        DnsMode, EgressFailureAction, EgressKind, Scope, StatsPrivacy,
    };

    fn profile(default_action: Action) -> RoutingProfile {
        RoutingProfile {
            id: "p1".into(),
            name: "test".into(),
            enabled: true,
            priority: 100,
            scope: Scope::Global,
            app_selectors: vec![],
            runtime_processes: vec![],
            include_children: true,
            egress_kind: EgressKind::ProxySession,
            egress_ref_id: "proxy-1".into(),
            egress_failure_action: EgressFailureAction::FailOpen,
            rule_source_ids: vec![],
            default_action,
            dns_mode: DnsMode::SystemCapture,
            unknown_domain_action: Action::Direct,
            udp_policy: UdpPolicy::Block,
            local_network_policy: LocalNetworkPolicy::Direct,
            ssh_pool_options: None,
            stats_privacy: StatsPrivacy::default(),
        }
    }

    fn tcp_target(host: &str) -> FlowTarget {
        FlowTarget {
            host: Some(host.into()),
            hostname_source: HostnameSource::TlsSni,
            ip: None,
            port: 443,
            protocol: Protocol::Tcp,
        }
    }

    fn gfwlist_source() -> CompiledRuleSource {
        autoproxy::parse_decoded("||google.com\n@@||cache.google.com").compile("gfwlist-official")
    }

    #[test]
    fn subscription_proxy_and_exception_order() {
        let cp = CompiledProfile::new(profile(Action::Direct), vec![], vec![gfwlist_source()]);
        let bypass = HardBypass::default();

        let d = cp.decide(&bypass, &tcp_target("mail.google.com"));
        assert_eq!(d.action, Action::Proxy);
        assert_eq!(d.reason, DecisionReason::SubscriptionProxy);

        let d2 = cp.decide(&bypass, &tcp_target("x.cache.google.com"));
        assert_eq!(d2.action, Action::Direct);
        assert_eq!(d2.reason, DecisionReason::SubscriptionException);
    }

    #[test]
    fn custom_override_beats_subscription() {
        let rule = CustomRule {
            id: "c1".into(),
            order: 0,
            pattern: RulePattern::DomainSuffix("google.com".into()),
            action: RuleDirection::Direct,
            note: None,
            enabled: true,
        };
        let compiled = vec![CompiledCustomRule::compile(&rule).unwrap()];
        let cp = CompiledProfile::new(profile(Action::Direct), compiled, vec![gfwlist_source()]);
        let d = cp.decide(&HardBypass::default(), &tcp_target("mail.google.com"));
        assert_eq!(d.action, Action::Direct);
        assert_eq!(d.reason, DecisionReason::CustomRule);
    }

    #[test]
    fn hard_bypass_forces_direct() {
        let cp = CompiledProfile::new(profile(Action::Proxy), vec![], vec![]);
        let mut t = tcp_target("localhost");
        t.hostname_source = HostnameSource::PlatformRemote;
        let d = cp.decide(&HardBypass::default(), &t);
        assert_eq!(d.action, Action::Direct);
        assert_eq!(d.reason, DecisionReason::HardBypass);
    }

    #[test]
    fn unknown_host_uses_unknown_action_not_default() {
        let mut p = profile(Action::Proxy);
        p.unknown_domain_action = Action::Direct;
        let cp = CompiledProfile::new(p, vec![], vec![]);
        let t = FlowTarget {
            host: None,
            hostname_source: HostnameSource::Unknown,
            ip: Some("8.8.8.8".parse().unwrap()),
            port: 443,
            protocol: Protocol::Tcp,
        };
        let d = cp.decide(&HardBypass::default(), &t);
        assert_eq!(d.action, Action::Direct);
        assert_eq!(d.reason, DecisionReason::UnknownDomainAction);
    }

    #[test]
    fn lan_direct_short_circuits_before_default_proxy() {
        let cp = CompiledProfile::new(profile(Action::Proxy), vec![], vec![]);
        let t = FlowTarget {
            host: None,
            hostname_source: HostnameSource::IpRule,
            ip: Some("192.168.1.10".parse().unwrap()),
            port: 22,
            protocol: Protocol::Tcp,
        };
        let d = cp.decide(&HardBypass::default(), &t);
        assert_eq!(d.action, Action::Direct);
        assert_eq!(d.reason, DecisionReason::LocalNetwork);
    }

    #[test]
    fn udp_policy_block_downgrades_proxy_to_block() {
        let mut p = profile(Action::Proxy);
        p.udp_policy = UdpPolicy::Block;
        let cp = CompiledProfile::new(p, vec![], vec![]);
        let mut t = tcp_target("example.com");
        t.protocol = Protocol::Udp;
        t.hostname_source = HostnameSource::TlsSni;
        let d = cp.decide(&HardBypass::default(), &t);
        assert_eq!(d.action, Action::Block);
        assert_eq!(d.reason, DecisionReason::DefaultAction);
        assert!(d.note.is_some());
    }

    #[test]
    fn default_action_when_known_host_unmatched() {
        let cp = CompiledProfile::new(profile(Action::Proxy), vec![], vec![gfwlist_source()]);
        let d = cp.decide(&HardBypass::default(), &tcp_target("unmatched.example.org"));
        assert_eq!(d.action, Action::Proxy);
        assert_eq!(d.reason, DecisionReason::DefaultAction);
    }

    #[test]
    fn app_profile_selected_by_lowest_priority() {
        use crate::sockscap::model::AppSelector;
        let mut low = profile(Action::Proxy);
        low.id = "low".into();
        low.scope = Scope::Applications;
        low.priority = 10;
        low.app_selectors = vec![AppSelector::WindowsExecutable("C:/App/foo.exe".into())];
        let mut high = profile(Action::Direct);
        high.id = "high".into();
        high.scope = Scope::Applications;
        high.priority = 50;
        high.app_selectors = vec![AppSelector::WindowsExecutable("C:/App/foo.exe".into())];
        let global = {
            let mut g = profile(Action::Block);
            g.id = "global".into();
            g
        };

        let set = vec![high, low, global];
        let app = AppIdentity {
            windows_exe: Some("c:/app/FOO.exe".into()),
            ..Default::default()
        };
        assert_eq!(select_profile(&set, &app).unwrap().id, "low");
    }

    #[test]
    fn windows_exe_matches_by_basename_when_install_dir_differs() {
        // Edge often ships under Program Files; UI may have saved x86 path.
        let mut p = profile(Action::Proxy);
        p.id = "edge".into();
        p.scope = Scope::Applications;
        p.app_selectors = vec![AppSelector::WindowsExecutable(
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe".into(),
        )];
        let set = vec![p];
        let app = AppIdentity {
            windows_exe: Some(
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe".into(),
            ),
            ..Default::default()
        };
        assert_eq!(select_profile(&set, &app).unwrap().id, "edge");
        assert!(windows_exe_paths_match(
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        ));
    }

    #[test]
    fn windows_exe_matches_filename_only_selector() {
        // Users may type just "msedge.exe" without a full install path.
        assert!(windows_exe_paths_match(
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            "msedge.exe",
        ));
        assert!(windows_exe_paths_match(
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            "MSEDGE.EXE",
        ));
        assert!(!windows_exe_paths_match(
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            "chrome.exe",
        ));

        let mut p = profile(Action::Proxy);
        p.id = "by-name".into();
        p.scope = Scope::Applications;
        p.app_selectors = vec![AppSelector::WindowsExecutable("msedge.exe".into())];
        let app = AppIdentity {
            windows_exe: Some(
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe".into(),
            ),
            ..Default::default()
        };
        assert_eq!(select_profile(&[p], &app).unwrap().id, "by-name");
    }

    #[test]
    fn global_profile_is_fallback_when_no_selector_matches() {
        let mut app_profile = profile(Action::Proxy);
        app_profile.id = "app".into();
        app_profile.scope = Scope::Applications;
        app_profile.app_selectors =
            vec![crate::sockscap::model::AppSelector::WindowsExecutable("C:/x.exe".into())];
        let mut global = profile(Action::Direct);
        global.id = "global".into();
        let set = vec![app_profile, global];
        let unrelated = AppIdentity {
            windows_exe: Some("C:/other.exe".into()),
            ..Default::default()
        };
        assert_eq!(select_profile(&set, &unrelated).unwrap().id, "global");
    }

    #[test]
    fn runtime_pid_requires_matching_start_time() {
        let mut p = profile(Action::Proxy);
        p.id = "rt".into();
        p.scope = Scope::RuntimeProcesses;
        p.runtime_processes = vec![RuntimeProcessSelector {
            pid: 4242,
            process_start_time: "t-original".into(),
            label: None,
        }];
        let set = vec![p];
        // Same PID, different start time (recycled PID) → no match.
        let recycled = AppIdentity {
            pid: Some(4242),
            process_start_time: Some("t-different".into()),
            ..Default::default()
        };
        assert!(select_profile(&set, &recycled).is_none());
        // Exact PID + start time → match.
        let same = AppIdentity {
            pid: Some(4242),
            process_start_time: Some("t-original".into()),
            ..Default::default()
        };
        assert_eq!(select_profile(&set, &same).unwrap().id, "rt");
    }
}
