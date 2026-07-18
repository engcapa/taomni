//! Sockscap runtime state managed by Tauri (plan §4.1, §12).
//!
//! Holds the orchestrator, the `sockscap.db` connection, the SSH known_hosts
//! store, and the compiled rule cache. Managed as a single Tauri state so the
//! commands in `commands.rs` can reach everything. Contains no secrets.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use rusqlite::Connection;

use super::autoproxy::{ProjectionStats, UnsupportedRule};
use super::capture::CaptureMode;
use super::db;
use super::engine::{EngineState, RecoveryJournal, SockscapOrchestrator};
use super::known_hosts::HostKeyStore;
use super::listener::FlowRouter;
use super::matcher::CompiledRuleSource;
use super::model::{CustomRule, RoutingProfile, Scope};
use super::platform::{self, CaptureBackend};
use super::policy::{select_profile, AppIdentity, CompiledCustomRule, CompiledProfile, HardBypass};

/// A shared, lockable SQLite connection to `sockscap.db`.
pub type SharedConn = Arc<StdMutex<Connection>>;

/// DB-backed recovery journal (plan §9). Writes/clears the active marker in
/// `sockscap.db`.
pub struct DbRecoveryJournal {
    conn: SharedConn,
}

impl RecoveryJournal for DbRecoveryJournal {
    fn write_marker(&self, state_json: &str) -> Result<(), String> {
        db::write_recovery_marker(&self.conn.lock().unwrap(), state_json)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn clear(&self) -> Result<(), String> {
        db::clear_recovery(&self.conn.lock().unwrap()).map_err(|e| e.to_string())
    }
}

/// UI-facing metadata about a compiled rule source's last successful update.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSourceMeta {
    pub stats: Option<CompiledStatsView>,
    pub sha256: Option<String>,
    pub mirror_url: Option<String>,
    pub last_good_at: Option<i64>,
    pub last_error: Option<String>,
    pub unsupported_examples: Vec<String>,
}

/// Serializable projection of `ProjectionStats` for the UI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledStatsView {
    pub total_lines: usize,
    pub domain_rules: usize,
    pub exception_rules: usize,
    pub ip_rules: usize,
    pub unsupported: usize,
}

impl From<&ProjectionStats> for CompiledStatsView {
    fn from(s: &ProjectionStats) -> Self {
        CompiledStatsView {
            total_lines: s.total_lines,
            domain_rules: s.domain_rules,
            exception_rules: s.exception_rules,
            ip_rules: s.ip_rules,
            unsupported: s.unsupported,
        }
    }
}

/// Compiled last-good rule sources keyed by source id, plus their UI metadata.
#[derive(Default)]
pub struct RuleCache {
    pub sources: HashMap<String, CompiledRuleSource>,
    pub meta: HashMap<String, RuleSourceMeta>,
}

impl RuleCache {
    /// Store a freshly compiled source and its metadata.
    pub fn put(
        &mut self,
        source_id: String,
        compiled: CompiledRuleSource,
        meta: RuleSourceMeta,
    ) {
        self.sources.insert(source_id.clone(), compiled);
        self.meta.insert(source_id, meta);
    }

    pub fn record_error(&mut self, source_id: &str, error: String) {
        self.meta.entry(source_id.to_string()).or_default().last_error = Some(error);
    }
}

/// Build a [`CompiledProfile`] from a profile, its custom rules and whatever
/// compiled sources are currently cached. Sources not yet refreshed are simply
/// absent (test_target surfaces that) — never fabricated.
pub fn compile_profile(
    profile: RoutingProfile,
    custom: &[CustomRule],
    cache: &RuleCache,
) -> CompiledProfile {
    let compiled_custom: Vec<CompiledCustomRule> =
        custom.iter().filter_map(CompiledCustomRule::compile).collect();
    let sources: Vec<CompiledRuleSource> = profile
        .rule_source_ids
        .iter()
        .filter_map(|id| cache.sources.get(id).cloned())
        .collect();
    CompiledProfile::new(profile, compiled_custom, sources)
}

/// Default local SOCKS5 capture port (plan §7 — apps point here for routing).
pub const DEFAULT_LOCAL_CAPTURE_PORT: u16 = 1080;

/// The single Tauri-managed Sockscap runtime.
pub struct SockscapState {
    pub conn: SharedConn,
    pub orchestrator: Arc<SockscapOrchestrator>,
    /// Selected capture plane (local SOCKS5 and/or platform transparent).
    pub backend: CaptureBackend,
    pub host_keys: Arc<StdMutex<HostKeyStore>>,
    pub rule_cache: Arc<StdMutex<RuleCache>>,
    /// Directory for downloaded/compiled rule files (atomic replace).
    pub rules_dir: PathBuf,
}

impl SockscapState {
    /// Open `sockscap.db`, initialize the schema, load the known_hosts store and
    /// wire the orchestrator with the best available capture adapter (plan
    /// Phases 5–7 selection; always has a ready local-SOCKS fallback).
    pub fn new(
        db_path: PathBuf,
        known_hosts_path: PathBuf,
        rules_dir: PathBuf,
    ) -> Result<SockscapState, String> {
        let conn = Connection::open(&db_path).map_err(|e| format!("open sockscap.db: {e}"))?;
        db::init_db(&conn).map_err(|e| format!("init sockscap.db: {e}"))?;
        let conn: SharedConn = Arc::new(StdMutex::new(conn));

        let recovery = Arc::new(DbRecoveryJournal { conn: conn.clone() });
        let backend = platform::select_backend();
        let orchestrator = Arc::new(SockscapOrchestrator::new(backend.adapter(), recovery));

        let host_keys = HostKeyStore::load(&known_hosts_path)
            .map_err(|e| format!("load known_hosts: {e}"))?;

        std::fs::create_dir_all(&rules_dir).ok();

        Ok(SockscapState {
            conn,
            orchestrator,
            backend,
            host_keys: Arc::new(StdMutex::new(host_keys)),
            rule_cache: Arc::new(StdMutex::new(RuleCache::default())),
            rules_dir,
        })
    }

    pub fn capture_mode(&self) -> CaptureMode {
        self.backend.mode()
    }

    /// Build the FlowRouter from the current profiles + rule cache: the enabled
    /// global profile (the only scope a SOCKS front-end can attribute) is
    /// compiled with its cached sources. `None` when no global profile is
    /// enabled (everything routes DIRECT). Called before `install` so capture
    /// uses the committed config.
    pub fn build_router(&self) -> FlowRouter {
        let (global, custom) = {
            let conn = self.conn.lock().unwrap();
            let profiles = db::list_profiles(&conn).unwrap_or_default();
            let global = select_profile(&profiles, &AppIdentity::default())
                .filter(|p| p.scope == Scope::Global)
                .cloned();
            let custom = match &global {
                Some(p) => db::list_custom_rules(&conn, &p.id).unwrap_or_default(),
                None => Vec::new(),
            };
            (global, custom)
        };
        let compiled = global.map(|p| {
            let cache = self.rule_cache.lock().unwrap();
            compile_profile(p, &custom, &cache)
        });
        FlowRouter::new(
            compiled,
            None,
            HardBypass::default(),
            self.orchestrator.stats.clone(),
        )
    }

    /// Build the router from committed config, hand it to the capture adapter,
    /// and start the engine. Shared by the Tauri command and the tray.
    pub async fn start_engine(&self) -> Result<EngineState, String> {
        let profiles = {
            let conn = self.conn.lock().unwrap();
            db::list_profiles(&conn).map_err(|e| e.to_string())?
        };
        self.backend.set_router(Arc::new(self.build_router()));
        self.orchestrator.start(&profiles).await?;
        Ok(self.orchestrator.state())
    }

    pub async fn stop_engine(&self) -> Result<EngineState, String> {
        self.orchestrator.stop().await?;
        Ok(self.orchestrator.state())
    }

    pub async fn recover_engine(&self) -> Result<EngineState, String> {
        self.orchestrator.recover().await?;
        Ok(self.orchestrator.state())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::Action;
    use crate::sockscap::autoproxy;
    use crate::sockscap::model::{
        DnsMode, EgressFailureAction, EgressKind, LocalNetworkPolicy, Scope, StatsPrivacy,
        UdpPolicy,
    };

    fn profile_with_source(src_id: &str) -> RoutingProfile {
        RoutingProfile {
            id: "p".into(),
            name: "p".into(),
            enabled: true,
            priority: 100,
            scope: Scope::Global,
            app_selectors: vec![],
            runtime_processes: vec![],
            include_children: true,
            egress_kind: EgressKind::ProxySession,
            egress_ref_id: "proxy".into(),
            egress_failure_action: EgressFailureAction::FailOpen,
            rule_source_ids: vec![src_id.into()],
            default_action: Action::Direct,
            dns_mode: DnsMode::SystemCapture,
            unknown_domain_action: Action::Direct,
            udp_policy: UdpPolicy::Block,
            local_network_policy: LocalNetworkPolicy::Direct,
            ssh_pool_options: None,
            stats_privacy: StatsPrivacy::default(),
        }
    }

    #[test]
    fn compile_profile_includes_cached_source() {
        let mut cache = RuleCache::default();
        let compiled = autoproxy::parse_decoded("||google.com").compile("gfwlist-official");
        cache.put("gfwlist-official".into(), compiled, RuleSourceMeta::default());
        let cp = compile_profile(profile_with_source("gfwlist-official"), &[], &cache);
        assert_eq!(cp.sources.len(), 1);
    }

    #[test]
    fn compile_profile_tolerates_missing_source() {
        let cache = RuleCache::default();
        let cp = compile_profile(profile_with_source("not-refreshed-yet"), &[], &cache);
        // Source absent from cache → not compiled in, but no error/fabrication.
        assert_eq!(cp.sources.len(), 0);
    }
}
