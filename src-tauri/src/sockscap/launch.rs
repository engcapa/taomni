use super::*;

#[tauri::command]
pub async fn sockscap_launch_app(
    state: State<'_, AppState>,
    profile_id: String,
    path: String,
    args: Vec<String>,
    launch_preparation: config::AppLaunchPreparation,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let mut orch = state.sockscap.orch.write().await;
        if !orch.is_running() {
            return Err("start SocksCap before launching an application".into());
        }
        let configured = orch
            .config()
            .and_then(|config| {
                config
                    .active_profiles()
                    .into_iter()
                    .find(|profile| profile.id == profile_id)
            })
            .is_some_and(|profile| {
                profile.apps.iter().any(|app| {
                    app.path == path
                        && app.args == args
                        && app.launch_preparation == launch_preparation
                        && matches!(app.launch_mode, config::AppLaunchMode::Desktop)
                })
            });
        if !configured {
            return Err(
                "the application must belong to the selected active SocksCap profile".into(),
            );
        }
        let capture = orch
            .linux_capture_mut()
            .ok_or_else(|| "Linux capture backend is not active".to_string())?;
        let info = capture
            .launch_app(&profile_id, &path, &args, &launch_preparation)
            .await?;
        serde_json::to_value(info)
            .map_err(|error| format!("serialize launched application: {error}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, profile_id, path, args, launch_preparation);
        Err("launching applications through SocksCap is currently Linux-only".into())
    }
}

#[tauri::command]
pub async fn sockscap_launch_terminal_app(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    path: String,
    args: Vec<String>,
    launch_preparation: config::AppLaunchPreparation,
    terminal_session_id: String,
    cols: u16,
    rows: u16,
    on_output: crate::terminal::TerminalOutputChannel,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    let output_generation = crate::webview_recovery::output_generation(&app, window.label());
    #[cfg(target_os = "linux")]
    {
        if state
            .terminal
            .terminals
            .read()
            .await
            .contains_key(&terminal_session_id)
        {
            return Err(format!("Terminal {} already exists", terminal_session_id));
        }

        let mut orch = state.sockscap.orch.write().await;
        // The frontend may be mounted twice by React StrictMode. Re-check
        // after serializing on the orchestrator lock so concurrent requests
        // with the same stable terminal id cannot both launch a process.
        if state
            .terminal
            .terminals
            .read()
            .await
            .contains_key(&terminal_session_id)
        {
            return Err(format!("Terminal {} already exists", terminal_session_id));
        }
        if !orch.is_running() {
            return Err("start SocksCap before launching an application".into());
        }
        let configured = orch
            .config()
            .and_then(|config| {
                config
                    .active_profiles()
                    .into_iter()
                    .find(|profile| profile.id == profile_id)
            })
            .is_some_and(|profile| {
                profile.apps.iter().any(|configured| {
                    configured.path == path
                        && configured.args == args
                        && configured.launch_preparation == launch_preparation
                        && matches!(configured.launch_mode, config::AppLaunchMode::Terminal)
                })
            });
        if !configured {
            return Err(
                "the terminal application must belong to the selected active SocksCap profile"
                    .into(),
            );
        }
        let capture = orch
            .linux_capture_mut()
            .ok_or_else(|| "Linux capture backend is not active".to_string())?;
        let (info, handle, reader) = capture.launch_terminal_app(
            &profile_id,
            &path,
            &args,
            &launch_preparation,
            &terminal_session_id,
            cols,
            rows,
        )?;
        if let Err(error) = crate::terminal::register_local_terminal(
            terminal_session_id,
            handle,
            reader,
            on_output,
            state.inner(),
            app,
            window.label(),
            output_generation,
        )
        .await
        {
            if let Err(stop_error) = capture.stop_launched_app(info.pid).await {
                tracing::warn!(
                    pid = info.pid,
                    "clean up failed terminal launch: {stop_error}"
                );
            }
            return Err(error);
        }
        serde_json::to_value(info)
            .map_err(|error| format!("serialize launched terminal application: {error}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (
            app,
            state,
            profile_id,
            path,
            args,
            launch_preparation,
            terminal_session_id,
            cols,
            rows,
            on_output,
        );
        Err("launching terminal applications through SocksCap is currently Linux-only".into())
    }
}

#[tauri::command]
pub async fn sockscap_launched_apps(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let mut orch = state.sockscap.orch.write().await;
        let apps = orch
            .linux_capture_mut()
            .map(|capture| capture.launched_apps())
            .unwrap_or_default();
        serde_json::to_value(apps)
            .map_err(|error| format!("serialize launched applications: {error}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = state;
        Ok(serde_json::json!([]))
    }
}

#[tauri::command]
pub async fn sockscap_stop_launched_app(
    state: State<'_, AppState>,
    pid: u32,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let mut orch = state.sockscap.orch.write().await;
        let capture = orch
            .linux_capture_mut()
            .ok_or_else(|| "Linux capture backend is not active".to_string())?;
        capture.stop_launched_app(pid).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, pid);
        Err("launching applications through SocksCap is currently Linux-only".into())
    }
}
