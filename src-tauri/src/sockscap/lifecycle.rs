use super::*;

/// Resolve the xray binary + work dir and install the [`core::XrayManager`] on
/// the runtime. Idempotent (later calls are ignored by the `OnceLock`). Called
/// from `setup()`; logs whether the binary was found so a missing provisioning
/// step is visible without blocking startup.
pub fn init_xray_manager(app: &AppHandle, state: &AppState) {
    let exe = paths::resolve_xray_exe(app);
    match &exe {
        Some(p) => tracing::info!("sockscap: xray-core found at {}", p.display()),
        None => tracing::info!(
            "sockscap: xray-core binary not provisioned (core-backed upstreams unavailable; run scripts/fetch-xray.ps1)"
        ),
    }
    let work_dir = data_dir(app)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("xray");
    let mgr = Arc::new(core::XrayManager::new(exe, work_dir));
    let _ = state.sockscap.xray.set(mgr);
}

/* ---------------------------- lifecycle --------------------------------- */

#[tauri::command]
pub async fn sockscap_status(state: State<'_, AppState>) -> Result<SocksCapStatus, String> {
    #[cfg(target_os = "macos")]
    let mut orch = state.sockscap.orch.write().await;
    #[cfg(target_os = "macos")]
    orch.refresh_macos_capture_health();
    #[cfg(not(target_os = "macos"))]
    let orch = state.sockscap.orch.read().await;
    Ok(orch.status())
}

#[tauri::command]
pub async fn sockscap_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SocksCapDiagnostics, String> {
    #[cfg(target_os = "macos")]
    let mut orch = state.sockscap.orch.write().await;
    #[cfg(target_os = "macos")]
    orch.refresh_macos_capture_health();
    #[cfg(not(target_os = "macos"))]
    let orch = state.sockscap.orch.read().await;

    #[cfg(target_os = "macos")]
    let redirector = orch
        .macos_telemetry()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| format!("serialize Redirector telemetry: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    let redirector = None;

    #[cfg(target_os = "macos")]
    let manual_recovery_steps = vec![
        "Quit Taomni and Mitmproxy Redirector if they are still running.".into(),
        "Open System Settings > Network > VPN & Filters and disable the Mitmproxy Redirector network configuration.".into(),
        "If recovery still fails, open System Settings > General > Login Items & Extensions > Network Extensions and disable Mitmproxy Redirector, then restart macOS.".into(),
        "Reopen Taomni, run Recover, and only start SocksCap after RecoveryRequired clears.".into(),
    ];
    #[cfg(not(target_os = "macos"))]
    let manual_recovery_steps = Vec::new();

    Ok(SocksCapDiagnostics {
        generated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
        status: orch.status(),
        capabilities: capture::capabilities_for(&app),
        stats: orch.stats_snapshot(),
        recovery_journal: recovery::read_journal(&recovery::journal_path(&data_dir(&app)?)),
        redirector,
        manual_recovery_steps,
    })
}

#[tauri::command]
pub async fn sockscap_start(
    app: AppHandle,
    state: State<'_, AppState>,
    sudo_password: Option<String>,
) -> Result<SocksCapStatus, String> {
    #[cfg(not(target_os = "linux"))]
    let _ = sudo_password;

    let cfg_path = config_path(&app)?;
    #[cfg(target_os = "macos")]
    let mut cfg = SocksCapConfig::load(&cfg_path);
    #[cfg(not(target_os = "macos"))]
    let cfg = SocksCapConfig::load(&cfg_path);

    #[cfg(target_os = "macos")]
    if redirector::app_identity::revalidate_configuration(&mut cfg)? {
        cfg.save(&cfg_path)
            .map_err(|error| format!("save refreshed macOS application identity: {error}"))?;
    }
    cfg.validate()?;

    #[cfg(target_os = "macos")]
    if !state.sockscap.recovery_ready() {
        return Err(
            "macOS SocksCap startup recovery is still running; wait for it to finish before starting capture"
                .into(),
        );
    }

    // Check the local runtime before attempting to lock again: re-locking the
    // same file from one process has platform-specific semantics.
    {
        let orch = state.sockscap.orch.read().await;
        if matches!(
            orch.status().phase,
            orchestrator::EnginePhase::RecoveryRequired
        ) {
            return Err("sockscap recovery is required before starting again".into());
        }
        if orch.is_running() {
            return Err("sockscap already running".into());
        }
    }

    let activation_lock = ModuleLock::try_acquire_for_app(&app, "sockscap", "global", "SocksCap")?;

    let dir = rules_dir(&app)?;
    {
        let mut orch = state.sockscap.orch.write().await;
        orch.apply_config(cfg.clone());
        orch.set_preparing("starting");
    }

    // GFWList mode: require rules (cache or fresh fetch) before capture.
    let mut gfw_start_note = String::new();
    if cfg.requires_gfwlist() {
        let mut orch = state.sockscap.orch.write().await;
        if orch.rules().is_none() {
            if let Some(c) = rules::source::load_cached(&dir) {
                gfw_start_note = format!("using cached GFWList ({} rules)", c.meta.rule_count);
                orch.set_rules(c);
            } else if !cfg.gfwlist.url.trim().is_empty() {
                let url = cfg.gfwlist.url.clone();
                drop(orch);
                match rules::source::refresh_from_url(&url, &dir).await {
                    Ok(compiled) => {
                        gfw_start_note =
                            format!("downloaded GFWList ({} rules)", compiled.meta.rule_count);
                        state.sockscap.orch.write().await.set_rules(compiled);
                    }
                    Err(e) => {
                        let mut orch = state.sockscap.orch.write().await;
                        orch.set_start_failed(format!("GFWList required but not loaded: {e}"));
                        return Err(format!(
                            "GFWList mode needs a ruleset. Refresh GFWList or import a file first. ({e})"
                        ));
                    }
                }
            } else {
                orch.set_start_failed("GFWList URL empty and no cache");
                return Err(
                    "GFWList mode needs a ruleset. Set a URL and refresh, or import a local file."
                        .to_string(),
                );
            }
        } else if let Some(m) = orch.gfwlist_meta() {
            gfw_start_note = format!("GFWList ready ({} rules)", m.rule_count);
        }
    }

    if !gfw_start_note.is_empty() {
        tracing::info!("sockscap: {gfw_start_note}");
    }

    let caps = capture::capabilities();
    let journal_path = data_dir(&app)?.join("recovery.json");

    #[cfg(windows)]
    let status: Result<SocksCapStatus, String> =
        start_windows_capture(&app, &state, &cfg, &caps).await;

    #[cfg(target_os = "linux")]
    let status: Result<SocksCapStatus, String> =
        start_linux_capture(&app, &state, &cfg, &caps, sudo_password).await;

    #[cfg(target_os = "macos")]
    let status: Result<SocksCapStatus, String> =
        start_macos_capture(&app, &state, &cfg, &caps, &journal_path).await;

    #[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
    let status: Result<SocksCapStatus, String> = {
        let mut orch = state.sockscap.orch.write().await;
        orch.apply_config(cfg.clone());
        let _ = orch.start_stub(&caps);
        Ok(orch.status())
    };

    #[cfg(not(target_os = "macos"))]
    let journal_result = match &status {
        Ok(st) => {
            let helper_port = state
                .sockscap
                .helper
                .inner
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|s| s.port));
            let relay_port = state.sockscap.orch.read().await.relay_port();
            recovery::write_journal(
                &journal_path,
                &recovery::RecoveryJournal {
                    platform: caps.platform.clone(),
                    capture_backend: st.capture_backend.clone(),
                    config_hash: cfg.content_hash(),
                    pid: std::process::id(),
                    clean: false,
                    phase: recovery::RecoveryPhase::Active,
                    session_id: uuid::Uuid::new_v4().to_string(),
                    backend_version: None,
                    scope_hash: None,
                    bridge_pid: None,
                    provider_pid: None,
                    relay_port,
                    helper_port,
                },
            )
        }
        Err(e) => {
            let mut orch = state.sockscap.orch.write().await;
            orch.set_start_failed(e.clone());
            Ok(())
        }
    };

    // macOS uses a durable write-ahead journal inside start_macos_capture so no
    // business scope can become active before its recovery record exists.
    #[cfg(target_os = "macos")]
    let journal_result: Result<(), String> = {
        if let Err(error) = &status {
            let mut orch = state.sockscap.orch.write().await;
            if !matches!(
                orch.status().phase,
                orchestrator::EnginePhase::RecoveryRequired
            ) {
                orch.set_start_failed(error.clone());
            }
        }
        Ok(())
    };

    if let Err(journal_error) = journal_result {
        // A live capture without a dirty journal cannot be recovered after a
        // crash. Tear it down before reporting the failed Start; preserve a
        // RecoveryRequired phase if that teardown itself cannot complete.
        let teardown_error = full_teardown(&app, &state, false).await.err();
        let teardown_failed = teardown_error.is_some();
        let message = match teardown_error {
            Some(teardown_error) => format!(
                "write SocksCap recovery journal failed: {journal_error}; teardown also failed: {teardown_error}"
            ),
            None => format!(
                "write SocksCap recovery journal failed; capture was stopped: {journal_error}"
            ),
        };
        if !teardown_failed {
            state
                .sockscap
                .orch
                .write()
                .await
                .set_start_failed(message.clone());
        } else {
            // Teardown could not prove the machine-wide state is clean. Keep
            // ownership until Recover succeeds or this process exits.
            state.sockscap.install_activation_lock(activation_lock);
        }
        return Err(message);
    }

    if status.is_ok() {
        state.sockscap.install_activation_lock(activation_lock);
    }

    // Start the xray health monitor once capture is up, so a core that crashes
    // mid-session is respawned on its same local port (keeps the relay working).
    // Idempotent; stopped by full_teardown / shutdown_on_exit.
    if status.is_ok() {
        if let Some(mgr) = state.sockscap.xray() {
            if mgr.running_count().await > 0 {
                mgr.start_monitor(std::time::Duration::from_secs(5));
            }
        }
    }

    status
}
