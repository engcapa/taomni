use super::*;

#[cfg(target_os = "linux")]
pub(super) async fn start_linux_capture(
    app: &AppHandle,
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
    caps: &capture::SocksCapCapabilities,
    sudo_password: Option<String>,
) -> Result<SocksCapStatus, String> {
    use crate::sockscap::capture::linux::{LinuxCapture, LinuxCaptureHandle, LinuxCaptureImpl};

    let ctx = build_unix_relay_context(state, cfg).await?;
    let transparent_available = caps
        .linux
        .as_ref()
        .is_some_and(|linux| linux.transparent_available);
    let capture = if sudo_password.is_some() {
        let backend = LinuxCaptureImpl;
        LinuxCaptureHandle::Transparent(backend.start(cfg, Arc::clone(&ctx), sudo_password).await?)
    } else if transparent_available {
        let backend = LinuxCaptureImpl;
        match backend.start(cfg, Arc::clone(&ctx), None).await {
            Ok(capture) => LinuxCaptureHandle::Transparent(capture),
            Err(error) if caps.privileged_required => return Err(error),
            Err(error) => {
                tracing::warn!(
                    "Linux transparent capture became unavailable after preflight; falling back to launch-only capture: {error}"
                );
                start_linux_launched_capture(app, Arc::clone(&ctx)).await?
            }
        }
    } else {
        start_linux_launched_capture(app, Arc::clone(&ctx)).await?
    };
    let relay_port = capture.relay_port();
    let launch_only = capture.is_launch_only();

    let mut orch = state.sockscap.orch.write().await;
    let gfw_note = orch
        .gfwlist_meta()
        .map(|meta| format!(", gfw={}", meta.rule_count))
        .unwrap_or_default();
    let active_profiles = cfg.active_profiles();
    let application_count = active_profiles
        .iter()
        .filter(|profile| matches!(profile.mode, config::ScopeMode::Apps))
        .map(|profile| profile.apps.len())
        .sum::<usize>();
    let app_watch_note = if launch_only {
        ", waiting for an application to be launched from SocksCap".to_string()
    } else if application_count > 0 {
        format!(", watching {application_count} application selector(s)")
    } else {
        String::new()
    };
    orch.relay_ctx = Some(ctx);
    orch.set_linux_capture(capture);
    let backend = if launch_only {
        "linux-app-launch"
    } else {
        "nft-cgroup-redirect"
    };
    let transport = if launch_only {
        "Linux unprivileged loopback launch relay"
    } else {
        "Linux nft+cgroup relay"
    };
    orch.set_active(
        backend,
        format!("capture active ({transport} :{relay_port}{gfw_note}{app_watch_note})"),
    );
    Ok(orch.status())
}

#[cfg(target_os = "linux")]
pub(super) async fn start_linux_launched_capture(
    app: &AppHandle,
    ctx: Arc<RwLock<relay::RelayContext>>,
) -> Result<capture::linux::LinuxCaptureHandle, String> {
    let runtime_dir = data_dir(app)?.join("runtime");
    Ok(capture::linux::LinuxCaptureHandle::Launched(
        capture::linux::launched::LaunchedCaptureHandle::start(ctx, &runtime_dir).await?,
    ))
}
