//! Desktop attachment happens before any optional background work is started.
use super::ApplicationRuntime;
use crate::state::AppState;
use tauri::Manager;

pub(crate) fn attach(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<AppState>()
        .core
        .workspace
        .lsp
        .attach_app(app.clone());
    app.manage(crate::workspace_search::WorkspaceSearchState::default());
    app.manage(crate::structural_search::StructuralSearchState::default());
    app.manage(crate::local_history::init_local_history(app)?);
    crate::backup::jobs::initialize(app);
    crate::backup::qa::initialize(app)?;
    app.manage(crate::backup::scheduler::BackupCoordinator::default());
    crate::sockscap::init_xray_manager(app, &app.state::<AppState>());
    Ok(())
}

pub(crate) fn start(app: &tauri::AppHandle) {
    let runtime = app.state::<ApplicationRuntime>();
    runtime.start();
    let cancel = runtime.tasks.cancellation();
    crate::backup::scheduler::start(app, cancel.clone());
    let catalog = app.state::<AppState>().core.opencode_go_catalog.clone();
    let catalog_cancel = cancel.clone();
    runtime.tasks.spawn("go-catalog-refresh", async move {
        tokio::select! { _ = catalog_cancel.cancelled() => {}, _ = catalog.refresh(true) => {} }
    });
    runtime.tasks.spawn(
        "agent-reaper",
        super::reaper::run(app.clone(), cancel.clone()),
    );
    let app_for_tunnel = app.clone();
    runtime.tasks.spawn("tunnel-autostart", async move {
        crate::tunnel::autostart_tunnels(app_for_tunnel).await;
    });
    let app_for_sockscap = app.clone();
    runtime.tasks.spawn("sockscap-boot-repair", async move {
        crate::sockscap::boot_repair(&app_for_sockscap, &app_for_sockscap.state::<AppState>())
            .await;
        crate::sockscap::publish_recovery_status(&app_for_sockscap);
    });
    let app_for_servers = app.clone();
    runtime.tasks.spawn("server-autostart", async move {
        crate::servers::autostart_servers(app_for_servers).await;
    });
}
