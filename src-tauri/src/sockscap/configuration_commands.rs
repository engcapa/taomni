use super::*;

#[tauri::command]
pub async fn sockscap_capabilities(app: AppHandle) -> Result<SocksCapCapabilities, String> {
    Ok(capture::capabilities_for(&app))
}

#[tauri::command]
pub async fn sockscap_redirector_install_status(
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let status = tokio::task::spawn_blocking(move || redirector::installer::status(&app))
            .await
            .map_err(|error| format!("Redirector status task failed: {error}"))??;
        serde_json::to_value(status)
            .map_err(|error| format!("serialize Redirector install status: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Mitmproxy Redirector installation is only available on macOS".into())
    }
}

#[tauri::command]
pub async fn sockscap_install_redirector(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let install_app = app.clone();
        let status =
            tokio::task::spawn_blocking(move || redirector::installer::install(&install_app))
                .await
                .map_err(|error| format!("Redirector installer task failed: {error}"))??;
        serde_json::to_value(status)
            .map_err(|error| format!("serialize Redirector install status: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Mitmproxy Redirector installation is only available on macOS".into())
    }
}

/* ---------------------------- config ------------------------------------ */

#[tauri::command]
pub async fn sockscap_get_config(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SocksCapConfig, String> {
    module_settings::load(&app, &state.plugins).await
}

/// Resolve and validate a macOS application selector before it is persisted.
/// Other platforms expose the same IPC shape so frontend code stays portable,
/// but reject the command without changing their capture behavior.
#[tauri::command]
pub async fn sockscap_validate_macos_app(
    path: String,
    allow_unsigned: Option<bool>,
) -> Result<config::AppSelector, String> {
    #[cfg(target_os = "macos")]
    {
        redirector::app_identity::validate_application(&path, allow_unsigned.unwrap_or(false))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, allow_unsigned);
        Err("macOS application validation is only available on macOS".into())
    }
}

#[tauri::command]
pub async fn sockscap_set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SocksCapConfig,
) -> Result<(), String> {
    config.validate()?;
    let _operation = state
        .legacy
        .sockscap
        .begin_activation(&state.plugins)
        .await?;
    let mut orch = state.legacy.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
    module_settings::save(&app, &state.plugins, &config).await?;
    orch.apply_config(config);
    Ok(())
}

pub(super) fn ensure_configuration_unlocked(orch: &Orchestrator) -> Result<(), String> {
    if orch.configuration_locked() {
        Err("SocksCap configuration is locked while capture is running; stop capture before making changes".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn sockscap_gfwlist_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GfwListStatus, String> {
    let live = state
        .legacy
        .sockscap
        .orch
        .read()
        .await
        .gfwlist_meta()
        .cloned();
    let meta = match live {
        Some(meta) => Some(meta),
        None => module_rules::load(&app, &state.plugins)
            .await?
            .map(|rules| rules.meta),
    };
    match meta {
        Some(m) => Ok(GfwListStatus {
            loaded: true,
            rule_count: m.rule_count,
            skipped: m.skipped,
            last_refresh: m.last_refresh,
            source: m.source,
            error: None,
        }),
        None => Ok(GfwListStatus {
            loaded: false,
            rule_count: 0,
            skipped: 0,
            last_refresh: None,
            source: String::new(),
            error: None,
        }),
    }
}

#[tauri::command]
pub async fn sockscap_refresh_gfwlist(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
) -> Result<GfwListStatus, String> {
    let _operation = state
        .legacy
        .sockscap
        .begin_activation(&state.plugins)
        .await?;
    // Hold the write lock for the complete mutation so Start cannot snapshot
    // the old rules while a refresh is being committed.
    let mut orch = state.legacy.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
    let mut cfg = module_settings::load(&app, &state.plugins).await?;
    let fetch_url = url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| cfg.gfwlist.url.clone());
    if !fetch_url.trim().is_empty() {
        cfg.gfwlist.url = fetch_url.clone();
    }

    let result = module_rules::refresh(&app, &state.plugins, &fetch_url).await;
    match result {
        Ok(compiled) => {
            let meta = compiled.meta.clone();
            module_settings::save(&app, &state.plugins, &cfg).await?;
            orch.apply_config(cfg);
            orch.set_rules(compiled);
            Ok(GfwListStatus {
                loaded: true,
                rule_count: meta.rule_count,
                skipped: meta.skipped,
                last_refresh: meta.last_refresh,
                source: meta.source,
                error: None,
            })
        }
        Err(e) => {
            // Keep previous rules if any; surface error for UI.
            if let Some(meta) = orch.gfwlist_meta() {
                Ok(GfwListStatus {
                    loaded: true,
                    rule_count: meta.rule_count,
                    skipped: meta.skipped,
                    last_refresh: meta.last_refresh.clone(),
                    source: meta.source.clone(),
                    error: Some(format!("refresh failed (kept cache): {e}")),
                })
            } else {
                Ok(GfwListStatus {
                    loaded: false,
                    rule_count: 0,
                    skipped: 0,
                    last_refresh: None,
                    source: fetch_url,
                    error: Some(e),
                })
            }
        }
    }
}

#[tauri::command]
pub async fn sockscap_import_rules(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<GfwListStatus, String> {
    let _operation = state
        .legacy
        .sockscap
        .begin_activation(&state.plugins)
        .await?;
    let mut orch = state.legacy.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
    let compiled = module_rules::import(&app, &state.plugins, PathBuf::from(path)).await?;
    let meta = compiled.meta.clone();
    orch.set_rules(compiled);
    Ok(GfwListStatus {
        loaded: true,
        rule_count: meta.rule_count,
        skipped: meta.skipped,
        last_refresh: meta.last_refresh,
        source: meta.source,
        error: None,
    })
}

#[tauri::command]
pub async fn sockscap_test_target(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    port: Option<u16>,
) -> Result<TargetTestResult, String> {
    let port = port.unwrap_or(443);
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("host is empty".into());
    }

    let _operation = state
        .legacy
        .sockscap
        .begin_activation(&state.plugins)
        .await?;
    if let Some(result) = module_host::test_saved_target(&app, &state.plugins, &host, port).await? {
        return Ok(result);
    }

    // Older modules evaluate a probe built from the desktop's current settings.
    {
        let mut orch = state.legacy.sockscap.orch.write().await;
        if orch.rules().is_none() {
            if let Some(c) = module_rules::load(&app, &state.plugins).await? {
                orch.set_rules(c);
            }
        }
        if orch.config().is_none() {
            let cfg = module_settings::load(&app, &state.plugins).await?;
            orch.apply_config(cfg);
        }
    }

    let probe = {
        let orch = state.legacy.sockscap.orch.read().await;
        let cfg = orch.config().cloned().unwrap_or_default();
        policy::TargetRuleProbe::for_config(&cfg, orch.rules(), host, port)
    };
    module_host::test_target(&state.plugins, probe).await
}
