use super::approval::ApprovalBroker;
use super::builder::build_server;
use super::policy::SecurityMode;
use crate::servers::ServerConfig;
use crate::servers::engine::LogEmitter;
use crate::servers::engine::ServerCtx;
use crate::servers::engine::ServerStarted;
use crate::servers::rdp::auth;
use crate::servers::rdp::auth::AuthConfig;
use crate::servers::rdp::capture;
use crate::servers::rdp::clipboard;
use crate::servers::rdp::clipboard::ClipboardPolicy;
use crate::servers::rdp::session;
use crate::servers::rdp::system_rdp;
use crate::servers::rdp::tls;
use ironrdp::server::Credentials;
use ironrdp::server::DesktopSize;
use ironrdp::server::ServerEvent;
use ironrdp::server::TlsIdentityCtx;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

/// Cadence of auto-detect RTT probes during a session.
pub(super) const AUTODETECT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 { 3389 } else { config.port };
    let bind = config.bind_address.clone();

    // The start dialog already moves Taomni off the system port; this also
    // covers autostart and configs edited elsewhere.
    let system = tokio::task::spawn_blocking(system_rdp::probe)
        .await
        .map_err(|e| format!("system Remote Desktop probe failed: {e}"))?;
    if let Some(alternative) = system_rdp::alternative_port(&system, port) {
        return Err(format!(
            "Windows Remote Desktop already listens on port {port}; choose another port for Taomni's RDP server (for example {alternative})"
        ));
    }

    let view_only = config.bool_field("viewOnly", false);
    let require_control_approval = config.bool_field("requireControlApproval", true);
    let audio_playback = config.bool_field("audioPlayback", true);
    let microphone = config.bool_field("microphone", true);
    let microphone_device = config.str_field("microphoneDevice", "").trim().to_string();
    let microphone_device = (!microphone_device.is_empty()).then_some(microphone_device);
    let display_id = config.str_field("displayId", "").trim().to_string();
    let display_id = (!display_id.is_empty()).then_some(display_id);
    let security = SecurityMode::parse(config.str_field("securityMode", "hybrid"))?;

    let auth = AuthConfig::from_fields(
        config.str_field("username", ""),
        config.str_field("password", ""),
        config.str_field("domain", ""),
    );
    let auth = auth?;

    // Resolve the bind address to a concrete SocketAddr up front so a bad
    // address surfaces as a startup error rather than inside the spawned task.
    let addr: SocketAddr = format!("{}:{}", bind, port)
        .parse()
        .map_err(|e| format!("invalid RDP bind address {}:{} — {}", bind, port, e))?;

    if addr.ip().is_unspecified() && !config.bool_field("allowPublicBind", false) {
        return Err(
            "RDP refuses to bind all network interfaces without explicit allowPublicBind consent"
                .to_string(),
        );
    }
    if addr.ip().is_unspecified() {
        ctx.log.line(
            "RDP public bind explicitly enabled — protect this port with a host firewall and \
             expose it only to trusted networks.",
        );
    }
    if !view_only && !require_control_approval {
        ctx.log.line(
            "RDP unattended control is enabled: authenticated clients can control this computer without a local confirmation prompt.",
        );
    }

    let (clipboard, clipboard_warnings) = ClipboardPolicy::from_settings(
        config.str_field("clipboardServerToClient", ""),
        config.str_field("clipboardClientToServer", ""),
        config.u64_field("clipboardFileMaxMb", ClipboardPolicy::DEFAULT_FILE_MAX_MB),
    );
    for warning in clipboard_warnings {
        ctx.log.line(warning);
    }
    ctx.log.line(clipboard.summary());

    let identity = tls::identity(&ctx.app).map_err(|e| format!("RDP TLS setup failed: {}", e))?;
    ctx.log
        .line("loaded self-signed TLS certificate for NLA/CredSSP");

    let size = DesktopSize {
        width: 1920,
        height: 1080,
    };

    ctx.log.line(format!(
        "RDP capture: {}",
        capture::capture_capability_summary()
    ));

    // Phase 7 (Linux advanced): independent/headless virtual sessions. The base
    // server mirrors the current console desktop; when the user asks for a
    // virtual session we report what the host can actually do rather than
    // silently falling back to the console mirror.
    if config.bool_field("headlessSession", false) {
        let caps = session::probe();
        ctx.log.line(format!(
            "headless/virtual session requested — {}. This build mirrors the current \
             console desktop; per-session virtual displays (xrdp model) are not yet a live \
             gateway. Sharing the console desktop instead.",
            caps.summary()
        ));
    }

    ctx.log.line(format!(
        "RDP server listening on {} ({}x{}, {:?} security, {})",
        addr,
        size.width,
        size.height,
        security,
        if view_only {
            "view-only"
        } else {
            "interactive"
        }
    ));

    let params = ServerParams {
        addr,
        view_only,
        security,
        identity,
        credentials: auth.to_credentials(),
        display_id,
        app: ctx.app.clone(),
        approvals: ctx
            .app
            .state::<crate::state::AppState>()
            .servers
            .rdp_approvals
            .clone(),
        require_control_approval,
        clipboard,
        audio_playback,
        microphone,
        microphone_device,
    };
    let task = spawn_server(params, ctx.cancel.clone(), ctx.log.clone()).await?;
    Ok(ServerStarted { pid: None, task })
}

/// Everything the server thread needs to build and run the [`RdpServer`].
pub(super) struct ServerParams {
    pub(super) addr: SocketAddr,
    pub(super) view_only: bool,
    pub(super) security: SecurityMode,
    pub(super) identity: TlsIdentityCtx,
    pub(super) credentials: Credentials,
    pub(super) display_id: Option<String>,
    pub(super) app: AppHandle,
    pub(super) approvals: Arc<ApprovalBroker>,
    pub(super) require_control_approval: bool,
    pub(super) clipboard: ClipboardPolicy,
    /// Stream this computer's audio output to the client (RDPSND).
    pub(super) audio_playback: bool,
    /// Play client microphones into a host input (AUDIO_INPUT).
    pub(super) microphone: bool,
    /// Output device name the microphone plays into (empty: auto-detect).
    pub(super) microphone_device: Option<String>,
}

/// Drive `RdpServer::run()` and bridge `cancel` → clean shutdown.
///
/// `RdpServer` and its `run()` future are `!Send` (they hold `Rc` internally),
/// so they cannot live on Tauri's multi-threaded Tokio runtime via
/// `tokio::spawn`. Instead we own a dedicated OS thread running a
/// `current_thread` runtime — mirroring the official example's
/// `#[tokio::main(flavor = "current_thread")]` — and build the server *inside*
/// that thread. The returned [`JoinHandle`] is an async wrapper that waits for
/// that thread to finish, so the registry's `task.abort()` plus the `cancel`
/// token both tear it down cleanly.
pub(super) async fn spawn_server(
    params: ServerParams,
    cancel: CancellationToken,
    log: LogEmitter,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<SocketAddr, String>>();
    let thread_cancel = cancel.clone();
    let thread = std::thread::Builder::new()
        .name("rdp-server".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("failed to start RDP runtime: {e}")));
                    log.line(format!("RDP server: failed to start runtime: {}", e));
                    return;
                }
            };

            rt.block_on(async move {
                let mut server = match build_server(&params, &log, thread_cancel.clone()) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("{e:#}")));
                        log.line(format!("RDP server: {e:#}"));
                        return;
                    }
                };
                server.set_credentials(Some(params.credentials.clone()));
                // Continuous auto-detect, like Windows Remote Desktop: an RTT
                // probe every 2 s on clients that negotiated the message
                // channel, plus periodic Network Characteristics Results.
                // Idle servers drop the events.
                server.enable_autodetect();

                let ev_sender = server.event_sender().clone();
                let probes = ev_sender.clone();
                tokio::spawn(async move {
                    let mut interval = tokio::time::interval(AUTODETECT_INTERVAL);
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    loop {
                        interval.tick().await;
                        if probes.send(ServerEvent::AutoDetectRttRequest).is_err() {
                            break;
                        }
                    }
                });
                let (addr_tx, addr_rx) = tokio::sync::oneshot::channel();
                if ev_sender.send(ServerEvent::GetLocalAddr(addr_tx)).is_err() {
                    let _ = ready_tx.send(Err("RDP listener event channel closed".to_string()));
                    return;
                }
                let run = server.run();
                tokio::pin!(run);

                tokio::select! {
                    bound = addr_rx => {
                        let result = bound
                            .map_err(|_| "RDP listener readiness channel closed".to_string())
                            .and_then(|addr| addr.ok_or_else(|| "RDP listener did not report an address".to_string()));
                        if ready_tx.send(result).is_err() {
                            return;
                        }
                    }
                    res = &mut run => {
                        let message = res
                            .err()
                            .map(|e| format!("{e:#}"))
                            .unwrap_or_else(|| "RDP listener stopped before becoming ready".to_string());
                        let _ = ready_tx.send(Err(message));
                        return;
                    }
                    _ = thread_cancel.cancelled() => {
                        let _ = ready_tx.send(Err("RDP server startup cancelled".to_string()));
                        return;
                    }
                }

                tokio::select! {
                    res = &mut run => {
                        if let Err(e) = res {
                            log.line(format!("RDP server error: {e:#}"));
                        }
                    }
                    _ = thread_cancel.cancelled() => {
                        let _ = ev_sender.send(ServerEvent::Quit("server stopped".to_string()));
                    }
                }
                log.line("RDP server stopped");
            });
        });

    let handle = thread.map_err(|e| format!("failed to spawn RDP server thread: {e}"))?;

    let task = tokio::task::spawn_blocking(move || {
        let _ = handle.join();
    });
    match tokio::time::timeout(std::time::Duration::from_secs(5), ready_rx).await {
        Ok(Ok(Ok(addr))) => {
            log_ready(addr);
            Ok(task)
        }
        Ok(Ok(Err(e))) => {
            cancel.cancel();
            let _ = task.await;
            Err(format!("RDP listener failed to start: {e}"))
        }
        Ok(Err(_)) => {
            cancel.cancel();
            let _ = task.await;
            Err("RDP listener readiness channel closed".to_string())
        }
        Err(_) => {
            cancel.cancel();
            let _ = task.await;
            Err("timed out waiting for RDP listener readiness".to_string())
        }
    }
}

pub(super) fn log_ready(addr: SocketAddr) {
    tracing::info!(%addr, "RDP listener ready");
}
