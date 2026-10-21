use super::*;

#[cfg(target_os = "macos")]
pub(super) async fn start_macos_capture(
    app: &AppHandle,
    state: &State<'_, AppState>,
    cfg: &SocksCapConfig,
    caps: &capture::SocksCapCapabilities,
    journal_path: &std::path::Path,
) -> Result<SocksCapStatus, String> {
    capture::macos::preflight(cfg)?;
    redirector::cleanup_stale_sockets()?;
    redirector::cleanup_stale_launchers().await?;
    let ctx = match build_unix_relay_context(state, cfg).await {
        Ok(ctx) => ctx,
        Err(error) => {
            if let Some(manager) = state.sockscap.xray() {
                manager.shutdown_all().await;
            }
            return Err(error);
        }
    };
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut journal = recovery::RecoveryJournal {
        platform: "macos".into(),
        capture_backend: caps.capture_backend.clone(),
        config_hash: cfg.content_hash(),
        pid: std::process::id(),
        clean: false,
        phase: recovery::RecoveryPhase::Preparing,
        session_id: session_id.clone(),
        backend_version: Some(redirector::REDIRECTOR_VERSION.into()),
        scope_hash: None,
        bridge_pid: None,
        provider_pid: None,
        relay_port: None,
        helper_port: None,
    };
    recovery::write_journal_durable(journal_path, &journal)
        .map_err(|error| format!("persist macOS SocksCap write-ahead journal: {error}"))?;

    let capture = match capture::macos::start(app, cfg, Arc::clone(&ctx), &session_id).await {
        Ok(capture) => capture,
        Err(start_error) => {
            if let Some(manager) = state.sockscap.xray() {
                manager.shutdown_all().await;
            }
            if start_error.recovery_required() {
                state.sockscap.orch.write().await.set_recovery_required(
                    &caps.capture_backend,
                    format!(
                        "macOS Redirector start may have reached the Provider after the dirty journal was written: {}; run Recover before retrying",
                        start_error.message()
                    ),
                );
            } else if let Err(clear_error) = recovery::mark_clean_and_clear(journal_path) {
                let message = format!(
                    "macOS Redirector failed before applying capture scope ({}), but the Preparing journal could not be cleared: {clear_error}",
                    start_error.message()
                );
                state
                    .sockscap
                    .orch
                    .write()
                    .await
                    .set_recovery_required(&caps.capture_backend, message.clone());
                return Err(message);
            }
            return Err(start_error.to_string());
        }
    };

    let telemetry = capture.telemetry();
    journal.phase = recovery::RecoveryPhase::Active;
    journal.scope_hash = Some(telemetry.scope_hash.clone());
    journal.bridge_pid = Some(telemetry.bridge_pid);
    journal.provider_pid = Some(telemetry.provider_pid);
    if let Err(journal_error) = recovery::write_journal_durable(journal_path, &journal) {
        let stop_error = capture.stop().await.err();
        if let Some(manager) = state.sockscap.xray() {
            manager.shutdown_all().await;
        }
        if stop_error.is_none() {
            if let Err(clear_error) = recovery::mark_clean_and_clear(journal_path) {
                state.sockscap.orch.write().await.set_recovery_required(
                    &caps.capture_backend,
                    format!(
                        "capture stopped after journal update failure, but the recovery journal could not be cleared: {clear_error}"
                    ),
                );
            }
        } else {
            state.sockscap.orch.write().await.set_recovery_required(
                &caps.capture_backend,
                format!(
                    "activate journal update failed: {journal_error}; Redirector stop also failed: {}",
                    stop_error.as_deref().unwrap_or("unknown error")
                ),
            );
        }
        return Err(format!(
            "persist active macOS SocksCap journal: {journal_error}"
        ));
    }
    let mut orch = state.sockscap.orch.write().await;
    let gfw_note = orch
        .gfwlist_meta()
        .map(|meta| format!(", gfw={}", meta.rule_count))
        .unwrap_or_default();
    orch.relay_ctx = Some(ctx);
    orch.set_macos_capture(capture);
    orch.set_active(
        &caps.capture_backend,
        format!("capture active (macOS Mitmproxy Redirector IPC{gfw_note})"),
    );
    Ok(orch.status())
}
