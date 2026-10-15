//! Fail closed: preserve native work, never mount side-effecting business pages
//! on a replacement renderer until their particular recovery is proven safe.
mod lifecycle;

use lifecycle::{Lifecycle, Phase};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const MAX_TABS: usize = 128;
const MAX_DESCRIPTION: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabDescription {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub saved_session_id: Option<String>,
    pub terminal_session_id: Option<String>,
}

#[derive(Clone, Default, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Description {
    pub tabs: Vec<TabDescription>,
    pub active_tab_id: Option<String>,
}

#[derive(Default)]
struct WindowRecovery {
    lifecycle: Lifecycle,
    description: Option<Description>,
    revision: u64,
    dialog_open: bool,
    browser_exited: bool,
    description_bytes: usize,
    capture_control: bool,
}

pub struct Recovery {
    instance: String,
    windows: Mutex<HashMap<String, WindowRecovery>>,
}

pub(crate) fn output_generation(app: &AppHandle, label: &str) -> Option<u64> {
    app.state::<Recovery>().windows.lock().ok()
        .and_then(|windows| windows.get(label).map(|w| w.lifecycle.generation))
}

pub(crate) fn renderer_is_current(app: &AppHandle, label: &str, generation: Option<u64>) -> bool {
    app.state::<Recovery>().windows.lock().ok().is_some_and(|windows|
        windows.get(label).is_some_and(|entry| entry.lifecycle.permits_output(generation)))
}

/// Hold this lock until channel registration finishes. Termination takes the
/// same lock before revoking outputs, so late create/attach cannot resurrect a
/// dead channel. A stale creation still keeps its native process alive.
pub(crate) fn register_output(
    app: &AppHandle, label: &str, generation: Option<u64>,
    register: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let state = app.state::<Recovery>();
    let windows = state.windows.lock().map_err(|_| "Recovery lock failed")?;
    let Some(entry) = windows.get(label) else { return Ok(()); };
    if !entry.lifecycle.permits_output(generation) {
        return Ok(());
    }
    register()
}

impl Default for Recovery {
    fn default() -> Self {
        Self { instance: uuid::Uuid::new_v4().to_string(), windows: Mutex::new(HashMap::new()) }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    version: u8,
    instance_id: String,
    generation: u64,
    revision: u64,
    recovering: bool,
    description: Option<Description>,
    limitation: &'static str,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn validate_description(description: &Description) -> Result<(), String> {
    if description.tabs.len() > MAX_TABS
        || serde_json::to_vec(description).map_err(|_| "Invalid recovery description")?.len() > MAX_DESCRIPTION
        || description.tabs.iter().any(|t| t.id.len() > 256 || t.title.len() > 512
            || t.kind.len() > 64 || t.saved_session_id.as_ref().is_some_and(|s| s.len() > 256)
            || t.terminal_session_id.as_ref().is_some_and(|s| s.len() > 256))
    {
        return Err("Recovery description exceeds budget".into());
    }
    let mut ids = std::collections::HashSet::new();
    if description.tabs.iter().any(|t| t.id.is_empty() || !ids.insert(&t.id))
        || description.active_tab_id.as_ref().is_some_and(|id| !ids.contains(id))
    {
        return Err("Invalid recovery tab identity".into());
    }
    Ok(())
}

#[tauri::command]
pub fn recovery_get(window: WebviewWindow, state: tauri::State<'_, Recovery>) -> Result<Bootstrap, String> {
    let windows = state.windows.lock().map_err(|_| "Recovery lock failed")?;
    let default = WindowRecovery::default();
    let entry = windows.get(window.label()).unwrap_or(&default);
    Ok(Bootstrap {
        version: 1, instance_id: state.instance.clone(),
        generation: entry.lifecycle.generation, revision: entry.revision,
        recovering: entry.lifecycle.phase != Phase::Healthy,
        description: entry.description.clone(),
        limitation: "terminal-state-unverified",
    })
}

#[tauri::command]
pub fn recovery_update(window: WebviewWindow, state: tauri::State<'_, Recovery>, instance_id: String,
    revision: u64, description: Description) -> Result<(), String> {
    validate_description(&description)?;
    if state.instance != instance_id { return Err("Recovery instance mismatch".into()); }
    let mut windows = state.windows.lock().map_err(|_| "Recovery lock failed")?;
    let bytes = serde_json::to_vec(&description).map_err(|_| "Invalid recovery description")?.len();
    let others: usize = windows.iter().filter(|(label, _)| label.as_str() != window.label())
        .map(|(_, entry)| entry.description_bytes).sum();
    if others.saturating_add(bytes) > MAX_DESCRIPTION { return Err("Global recovery description budget exceeded".into()); }
    let Some(entry) = windows.get_mut(window.label()) else { return Ok(()); };
    if entry.lifecycle.phase != Phase::Healthy || revision <= entry.revision {
        return Err("Stale recovery description".into());
    }
    entry.description = Some(description);
    entry.description_bytes = bytes;
    entry.revision = revision;
    Ok(())
}

#[tauri::command]
pub fn recovery_ready(window: WebviewWindow, state: tauri::State<'_, Recovery>,
    instance_id: String, generation: u64) -> Result<(), String> {
    if state.instance != instance_id { return Err("Recovery instance mismatch".into()); }
    let mut windows = state.windows.lock().map_err(|_| "Recovery lock failed")?;
    let entry = windows.get_mut(window.label()).ok_or("Unknown recovery window")?;
    if !entry.lifecycle.ready(generation) { return Err("Stale recovery handshake".into()); }
    drop(windows);
    record(window.app_handle(), window.label(), "ready", "limited-ui");
    Ok(())
}

// Dedicated low-frequency, bounded release log. Never pass engine error text,
// terminal content, tab titles, credentials or command arguments to this writer.
fn record(app: &AppHandle, label: &str, event: &str, reason: &str) {
    use std::io::Write;
    static LOCK: Mutex<()> = Mutex::new(());
    let Ok(_guard) = LOCK.lock() else { return; };
    let Ok(dir) = app.path().app_log_dir() else { return; };
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = dir.join("webview-recovery.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= 2 * 1024 * 1024) {
        let _ = std::fs::remove_file(dir.join("webview-recovery.2.log"));
        let _ = std::fs::rename(dir.join("webview-recovery.1.log"), dir.join("webview-recovery.2.log"));
        let _ = std::fs::rename(&path, dir.join("webview-recovery.1.log"));
    }
    // Labels can contain session IDs; log a hash instead, not their contents.
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    label.hash(&mut hash);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} version={} window={:x} event={} reason={}",
            now(), app.package_info().version, hash.finish(), event, reason);
    }
}

pub fn terminated(app: &AppHandle, label: &str, reason: &'static str) {
    let handle = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<Recovery>();
        let Ok(mut windows) = state.windows.lock() else { return; };
        let Some(entry) = windows.get_mut(&label) else { return; };
        if reason == "browser-exited" { entry.browser_exited = true; }
        let reload_supported = !entry.browser_exited;
        let capture_control = entry.capture_control;
        if !entry.lifecycle.terminated(now()) { return; }
        drop(windows);
        // Stop delivery to the dead renderer, not its PTY/SSH or other windows.
        crate::terminal::revoke_window_outputs(&handle.state::<crate::state::AppState>(), &label);
        record(&handle, &label, "terminated", reason);
        if capture_control {
            crate::screenshot::stop_orphaned_capture_controls(&handle);
            handle.dialog().message("采集控制界面的渲染进程已退出，已请求安全停止采集。录屏文件会沿原有路径保留；不会重新录制或重建覆盖窗口。")
                .title("Taomni 采集控制中断").show(|_| {});
            return;
        }
        // Main owns dictation. Stop capture, not PTYs/services/AI jobs. Other
        // native recording/scroll controls remain usable in their own windows.
        if label == "main" {
            crate::voice::commands::stop_orphaned_capture();
            let media_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = media_app.state::<crate::state::AppState>();
                // Native A/V has no cheap per-renderer ownership query. Fail
                // safely rather than letting an orphan microphone run forever.
                let mut sessions = state.lanchat.media_sessions.write().await;
                for (_, session) in sessions.drain() { session.stop(); }
            });
        }
        failure_dialog(&handle, &label, reload_supported);
    });
}

fn failure_dialog(app: &AppHandle, label: &str, reload_supported: bool) {
    let state = app.state::<Recovery>();
    let Ok(mut windows) = state.windows.lock() else { return; };
    let Some(entry) = windows.get_mut(label) else { return; };
    if entry.dialog_open || entry.lifecycle.phase == Phase::Closing { return; }
    entry.dialog_open = true;
    drop(windows);
    let handle = app.clone();
    let label = label.to_owned();
    let message = if reload_supported {
        "界面渲染进程已退出。原终端和后台任务未被关闭。重试仅恢复标签说明；终端画面、未保存编辑及操作结果可能不完整，不会重发命令、SQL或邮件。"
    } else {
        "浏览器进程已退出，当前平台不能安全重建此窗口。原终端和后台任务未被关闭；请稍后核对任务，不要直接重启应用。"
    };
    let buttons = if reload_supported {
        MessageDialogButtons::OkCancelCustom("重试界面".into(), "稍后处理".into())
    } else { MessageDialogButtons::OkCustom("稍后处理".into()) };
    app.dialog().message(message).title("Taomni 界面恢复").buttons(buttons).show(move |retry| {
        if let Ok(mut windows) = handle.state::<Recovery>().windows.lock() {
            if let Some(entry) = windows.get_mut(&label) { entry.dialog_open = false; }
        }
        if retry && reload_supported { manual_retry(&handle, &label); }
    });
}

fn manual_retry(app: &AppHandle, label: &str) {
    let state = app.state::<Recovery>();
    let generation = state.windows.lock().ok().and_then(|mut w|
        w.get_mut(label).filter(|entry| !entry.browser_exited).and_then(|entry| entry.lifecycle.retry(now())));
    let Some(generation) = generation else {
        record(app, label, "retry-deferred", "cooldown-or-browser-exited");
        app.dialog().message("此窗口暂不能重试：浏览器进程已退出，或距离上次尝试不足60秒。后台任务未被关闭，请稍后核对状态。")
            .title("Taomni 界面恢复").show(|_| {});
        return;
    };
    record(app, label, "retry", "manual");
    let handle = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        let result = handle.get_webview_window(&label).ok_or(()).and_then(|w| w.reload().map_err(|_| ()));
        if result.is_err() {
            if let Ok(mut windows) = handle.state::<Recovery>().windows.lock() {
                if let Some(entry) = windows.get_mut(&label) { entry.lifecycle.timeout(generation); }
            }
            failure_dialog(&handle, &label, true);
            return;
        }
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            let expired = handle.state::<Recovery>().windows.lock().ok().is_some_and(|mut w|
                w.get_mut(&label).is_some_and(|e| e.lifecycle.timeout(generation)));
            if expired {
                record(&handle, &label, "failed", "bootstrap-timeout");
                failure_dialog(&handle, &label, true);
            }
        });
    });
}

pub fn install(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    if let Ok(mut windows) = app.state::<Recovery>().windows.lock() {
        windows.entry(label.clone()).or_default();
    }
    record(&app, &label, "registered", "native-hook");
    let close_app = app.clone();
    let close_label = label.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            let state = close_app.state::<Recovery>();
            let Ok(mut windows) = state.windows.lock() else { api.prevent_close(); return; };
            let Some(entry) = windows.get_mut(&close_label) else { return; };
            if !entry.lifecycle.needs_native_close() { return; }
            api.prevent_close();
            if entry.dialog_open { return; }
            entry.dialog_open = true;
            drop(windows);
            let app = close_app.clone();
            let label = close_label.clone();
            app.clone().dialog().message(
                "界面恢复期间关闭应用会结束后台任务。确认退出？取消将保留后台，不会重新执行任何操作。"
            ).title("确认退出 Taomni").buttons(MessageDialogButtons::OkCancelCustom("退出应用".into(), "保留后台".into()))
            .show(move |yes| {
                if let Ok(mut windows) = app.state::<Recovery>().windows.lock() {
                    if let Some(entry) = windows.get_mut(&label) {
                        entry.dialog_open = false;
                        if yes { entry.lifecycle.closing(); }
                    }
                }
                if yes { app.exit(0); }
            });
        }
        tauri::WindowEvent::Destroyed => {
            if let Ok(mut windows) = close_app.state::<Recovery>().windows.lock() { windows.remove(&close_label); }
        }
        _ => {}
    });
    install_hooks(window);
}

/// Detect-only for recording/scroll controls. Never use ordinary-window close,
/// replacement, reload or metadata restoration for capture surfaces.
pub(crate) fn install_capture_control(window: &WebviewWindow) {
    let state = window.app_handle().state::<Recovery>();
    if let Ok(mut windows) = state.windows.lock() {
        windows.entry(window.label().to_owned()).or_default().capture_control = true;
    }
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut windows) = app.state::<Recovery>().windows.lock() { windows.remove(&label); }
        }
    });
    install_hooks(window);
}

fn install_hooks(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::prelude::*;
        let failure_app = app.clone();
        let failure_label = label.clone();
        if window.with_webview(move |view| {
            view.inner().connect_web_process_terminated(move |_, reason| {
                let reason = match reason {
                    webkit2gtk::WebProcessTerminationReason::Crashed => "crashed",
                    webkit2gtk::WebProcessTerminationReason::ExceededMemoryLimit => "memory-limit",
                    _ => "terminated",
                };
                terminated(&failure_app, &failure_label, reason);
            });
        }).is_err() { record(&app, &label, "hook-failed", "linux"); }
    }
    #[cfg(target_os = "windows")]
    {
        use webview2_com::{Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};
        let failure_app = app.clone();
        let failure_label = label.clone();
        let log_app = app.clone();
        let log_label = label.clone();
        let _ = window.with_webview(move |view| unsafe {
            let result = (|| -> windows::core::Result<()> {
                let core = view.controller().CoreWebView2()?;
                let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
                        args.ProcessFailedKind(&mut kind)?;
                        match kind {
                            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED =>
                                terminated(&failure_app, &failure_label, "renderer-exited"),
                            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED =>
                                terminated(&failure_app, &failure_label, "browser-exited"),
                            _ => {} // GPU, frame and unresponsive events are not renderer death.
                        }
                    }
                    Ok(())
                }));
                let mut token = 0;
                core.add_ProcessFailed(&handler, &mut token)?;
                // WebView owns the handler until destruction; no global COM reference.
                Ok(())
            })();
            if result.is_err() { record(&log_app, &log_label, "hook-failed", "windows"); }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str) -> TabDescription {
        TabDescription {
            id: id.into(), kind: "terminal".into(), title: "Shell".into(),
            saved_session_id: None, terminal_session_id: Some("same-process-session".into()),
        }
    }

    #[test]
    fn description_accepts_empty_and_valid_selected_tab() {
        assert!(validate_description(&Description::default()).is_ok());
        assert!(validate_description(&Description {
            tabs: vec![tab("a")], active_tab_id: Some("a".into()),
        }).is_ok());
    }

    #[test]
    fn description_rejects_duplicate_empty_and_missing_active_id() {
        for description in [
            Description { tabs: vec![tab("a"), tab("a")], active_tab_id: None },
            Description { tabs: vec![tab("")], active_tab_id: None },
            Description { tabs: vec![tab("a")], active_tab_id: Some("b".into()) },
        ] { assert!(validate_description(&description).is_err()); }
    }

    #[test]
    fn description_enforces_count_and_field_budgets() {
        let mut description = Description {
            tabs: (0..MAX_TABS).map(|i| tab(&i.to_string())).collect(),
            active_tab_id: None,
        };
        assert!(validate_description(&description).is_ok());
        description.tabs.push(tab("overflow"));
        assert!(validate_description(&description).is_err());
        description.tabs = vec![tab("one")];
        description.tabs[0].title = "x".repeat(513);
        assert!(validate_description(&description).is_err());
    }

    #[test]
    fn description_rejects_unapproved_fields_instead_of_caching_credentials() {
        assert!(serde_json::from_value::<TabDescription>(serde_json::json!({
            "id": "a", "kind": "terminal", "title": "Shell",
            "savedSessionId": null, "terminalSessionId": null, "password": "fixture-not-a-secret"
        })).is_err());
    }
}
