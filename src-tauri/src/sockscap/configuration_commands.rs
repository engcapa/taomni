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
        serde_json::to_value(redirector::installer::status(&app))
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
pub async fn sockscap_get_config(app: AppHandle) -> Result<SocksCapConfig, String> {
    let path = config_path(&app)?;
    Ok(SocksCapConfig::load(&path))
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
    let path = config_path(&app)?;
    let mut orch = state.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
    config.save(&path)?;
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
    let orch = state.sockscap.orch.read().await;
    if let Some(meta) = orch.gfwlist_meta() {
        return Ok(GfwListStatus {
            loaded: true,
            rule_count: meta.rule_count,
            skipped: meta.skipped,
            last_refresh: meta.last_refresh.clone(),
            source: meta.source.clone(),
            error: None,
        });
    }
    // Fall back to disk meta if engine has not loaded yet.
    let meta_path = rules_dir(&app)?.join("gfwlist.meta.json");
    match GfwListMeta::load(&meta_path) {
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
    // Hold the write lock for the complete mutation so Start cannot snapshot
    // the old rules while a refresh is being committed.
    let mut orch = state.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
    let cfg_path = config_path(&app)?;
    let mut cfg = SocksCapConfig::load(&cfg_path);
    let fetch_url = url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| cfg.gfwlist.url.clone());
    if !fetch_url.trim().is_empty() {
        cfg.gfwlist.url = fetch_url.clone();
    }

    let dir = rules_dir(&app)?;
    let result = rules::source::refresh_from_url(&fetch_url, &dir).await;
    match result {
        Ok(compiled) => {
            let meta = compiled.meta.clone();
            cfg.save(&cfg_path)?;
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
    let mut orch = state.sockscap.orch.write().await;
    ensure_configuration_unlocked(&orch)?;
    let dir = rules_dir(&app)?;
    let compiled = rules::source::import_from_path(std::path::Path::new(&path), &dir)?;
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

    // Ensure rules are loaded into the orchestrator for dry-run.
    {
        let mut orch = state.sockscap.orch.write().await;
        if orch.rules().is_none() {
            let dir = rules_dir(&app)?;
            if let Some(c) = rules::source::load_cached(&dir) {
                orch.set_rules(c);
            }
        }
        if orch.config().is_none() {
            let cfg = SocksCapConfig::load(&config_path(&app)?);
            orch.apply_config(cfg);
        }
    }

    let orch = state.sockscap.orch.read().await;
    let cfg = orch
        .config()
        .cloned()
        .unwrap_or_else(SocksCapConfig::default);
    let engine = PolicyEngine::from_config(&cfg, orch.rules());
    let input = PolicyInput {
        host: Some(host.clone()),
        ip: host.parse().ok(),
        port,
        process_path: None,
        pid: None,
    };
    let trace = engine.decide(&input);
    Ok(TargetTestResult {
        host,
        port,
        decision: trace.decision,
        reason: trace.reason,
        matched_rule: trace.matched_rule,
    })
}
