//! Construction opens stores only after profile recovery and starts no background work.
use super::{
    ApplicationRuntime,
    paths::ProfilePaths,
    profile::{ProfileRuntimeLeases, ProfileStartupError, StartupMode},
};
use crate::{
    ai::{AppAiCtx, config::AiConfig},
    state::{AppState, CoreState, LegacyFeatureRuntime, MailRuntime},
};
use std::sync::Arc;
#[cfg(test)]
mod tests;

pub(crate) struct BootstrappedApplication {
    pub(crate) state: AppState,
    pub(crate) runtime: ApplicationRuntime,
}

pub(crate) fn desktop(
    app: &tauri::AppHandle,
) -> Result<BootstrappedApplication, ProfileStartupError> {
    let paths = ProfilePaths::desktop(app)?;
    bootstrap(paths, StartupMode::Desktop, None, true)
}

pub(crate) fn bootstrap(
    paths: ProfilePaths,
    mode: StartupMode,
    config: Option<AiConfig>,
    migrate_default_roots: bool,
) -> Result<BootstrappedApplication, ProfileStartupError> {
    // The previous bundle identifier can be moved only before opening locks in
    // the replacement directory. An occupied profile already has lock files.
    crate::migrate::migrate_app_data_dir(&paths.data);
    let leases = Arc::new(ProfileRuntimeLeases::acquire(&paths.data, mode)?);
    if migrate_default_roots {
        crate::migrate::migrate_default_roots();
    }
    let state = construct(paths, leases, config)?;
    let runtime = ApplicationRuntime::new(state.plugins.clone());
    Ok(BootstrappedApplication { state, runtime })
}

/// Compatibility construction for in-process mobile fixtures. There is no
/// supervision thread or listener until its caller explicitly starts one.
pub(crate) fn isolated_state(data: &std::path::Path, config: AiConfig) -> Result<AppState, String> {
    let paths = ProfilePaths::isolated(data);
    let leases = Arc::new(
        ProfileRuntimeLeases::acquire(data, StartupMode::Headless)
            .map_err(|error| error.to_string())?,
    );
    construct(paths, leases, Some(config))
}

fn construct(
    paths: ProfilePaths,
    leases: Arc<ProfileRuntimeLeases>,
    config: Option<AiConfig>,
) -> Result<AppState, String> {
    let db = rusqlite::Connection::open(paths.data.join("taomni.db")).map_err(|e| e.to_string())?;
    crate::session::db::init_db(&db).map_err(|e| e.to_string())?;
    crate::terminal::local_directories::init_tables(&db).map_err(|e| e.to_string())?;
    crate::state::legacy::initialize_legacy_tables(&db)?;
    let notes =
        rusqlite::Connection::open(paths.data.join("notes.db")).map_err(|e| e.to_string())?;
    crate::notes::init_db(&notes).map_err(|e| e.to_string())?;
    let vault = Arc::new(
        crate::vault::Vault::open(&paths.data.join("vault.db")).map_err(|e| e.to_string())?,
    );
    let mail = MailRuntime::new(&paths.data);
    let config = config.unwrap_or_else(|| AiConfig::load(&paths.config.join("taomni/ai.json")));
    let ai_ctx = AppAiCtx::from_config_with_proxy_db(config, vault.clone(), Some(&db));
    let mfa = crate::mfa::backend::MfaBackend::load(&paths.data);
    let legacy = LegacyFeatureRuntime::new(ai_ctx, mfa, mail);
    let services = Arc::new(crate::plugin::services::PluginCoreServices::new(
        &paths.data,
        vault.clone(),
        leases.clone(),
    )?);
    let plugins = Arc::new(
        crate::plugin::PluginRegistry::with_services(paths.plugins.clone(), services)
            .with_module_cleanup(crate::sockscap::ModuleCleanup::new(
                &legacy.sockscap,
                &paths.data,
            )),
    );
    // Optional malformed packages are disabled records, never startup failures.
    let _ = plugins.scan();
    let plugin_downloads = Arc::new(crate::plugin::download::DownloadManager::persistent(
        crate::plugin::download::HttpDownloadService::new(
            &crate::plugin::download::ProxyRoute::NoProxy,
        )
        .map_err(|e| e.to_string())?,
        paths.plugins.join(".downloads"),
    ));
    let core = Arc::new(CoreState::new(paths, db, notes, vault, leases.clone()));
    let observer: Arc<dyn crate::terminal::observation::TerminalObserver> =
        legacy.mobile.broker.clone();
    core.terminal
        .terminal_outputs
        .observations
        .subscribe(&observer);
    Ok(AppState {
        core,
        plugins,
        plugin_downloads,
        legacy,
        _profile: leases,
    })
}
