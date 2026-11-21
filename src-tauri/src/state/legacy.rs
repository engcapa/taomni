//! Temporary in-process owners. Delete each field only with its verified host migration.
//! This is 005-B debt; it is deliberately outside CoreState and PluginRegistry.
use super::mail::MailRuntime;
use crate::ai::AppAiCtx;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

pub struct RemoteDesktopRuntime {
    pub vnc_sessions: Arc<RwLock<HashMap<String, crate::vnc::DesktopVncSession>>>,
    pub vnc_detach_claims: Arc<RwLock<HashMap<String, crate::vnc::VncDetachClaim>>>,
    pub(crate) rdp_sessions: Arc<RwLock<HashMap<String, crate::rdp::DesktopRdpSession>>>,
}

pub struct LegacyFeatureRuntime {
    // TASK-014: the in-process MFA backend remains a temporary owner until the
    // signed MFA host takes over every production command and migration path.
    pub(crate) mfa: crate::mfa::backend::MfaBackend,
    pub(crate) mail: MailRuntime,
    // TASK-019: privileged helper/recovery/xray owner.
    pub sockscap: Arc<crate::sockscap::SocksCapRuntime>,
    // TASK-017/018: split real service and approval owners, not just this wrapper.
    pub servers: Arc<crate::servers::ServerRegistry>,
    pub servers_tab_lock: Mutex<Option<crate::servers::HeldServersTabLock>>,
    // TASK-021: includes local AsrManager model state; not a core-only AI context.
    pub ai_ctx: Arc<RwLock<AppAiCtx>>,
    // TASK-016: includes VNC detach claims and relay lifetime owners.
    pub remote_desktop: RemoteDesktopRuntime,
    // TASK-022 / DEC-2: explicitly retained until the mobile go/no-go gate.
    pub mobile: Arc<crate::mobile::MobileRuntime>,
}

impl LegacyFeatureRuntime {
    pub(crate) fn new(
        ai_ctx: AppAiCtx,
        mfa: crate::mfa::backend::MfaBackend,
        mail: MailRuntime,
    ) -> Self {
        Self {
            mfa,
            mail,
            sockscap: Arc::new(crate::sockscap::SocksCapRuntime::new()),
            servers: Arc::new(crate::servers::ServerRegistry::new()),
            servers_tab_lock: Mutex::new(None),
            ai_ctx: Arc::new(RwLock::new(ai_ctx)),
            remote_desktop: RemoteDesktopRuntime {
                vnc_sessions: Arc::new(RwLock::new(HashMap::new())),
                vnc_detach_claims: Arc::new(RwLock::new(HashMap::new())),
                rdp_sessions: Arc::new(RwLock::new(HashMap::new())),
            },
            mobile: Arc::new(crate::mobile::MobileRuntime::default()),
        }
    }
}

/// Existing monolith-only tables stay explicit until TASK-016/018 migration.
/// New hosts receive readonly legacy exports, never this core connection.
pub(crate) fn initialize_legacy_tables(db: &rusqlite::Connection) -> Result<(), String> {
    crate::servers::db::init_server_tables(db).map_err(|e| e.to_string())?;
    crate::rdp::tls::init_trust_table(db).map_err(|e| e.to_string())
}
