use super::capture;
use super::model::OverlayInit;
use super::model::PhysicalRegion;
use super::model::PinInit;
use super::record;
use super::recovery_file;
use super::scroll;
use super::session;
use super::surfaces;
use super::window_lifecycle::restore_app_windows_for_preview;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
#[derive(Default)]
pub(super) struct ToolState {
    pub(super) session_lease: Option<Arc<session::SessionLease>>,
    pub(super) overlay: Option<OverlayInit>,
    /// Labels of app windows hidden for the capture session.
    pub(super) hidden: Vec<String>,
    pub(super) recording: Option<String>,
    pub(super) recording_preview: Option<String>,
    /// Remains true while the stopped clip is being previewed.
    pub(super) recorder_open: bool,
    pub(super) include_current_window: bool,
    pub(super) recording_region: Option<PhysicalRegion>,
    pub(super) scroll: Option<Arc<scroll::ScrollControl>>,
    pub(super) pins: HashMap<String, PinInit>,
    pub(super) pin_tools: HashMap<String, serde_json::Value>,
}

pub(super) static STATE: OnceLock<Mutex<ToolState>> = OnceLock::new();
pub(super) static RECOVERY_FINALIZERS: OnceLock<recovery_file::Finalizers> = OnceLock::new();
/// Serializes overlay opening (hotkey repeat, double clicks, StrictMode).
pub(super) static OPENING: AtomicBool = AtomicBool::new(false);
pub(super) static STARTING_RECORDING: AtomicBool = AtomicBool::new(false);
pub(super) static SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);
pub(super) static PIN_COUNTER: AtomicU64 = AtomicU64::new(1);
pub(super) static NATIVE_WAYLAND: AtomicBool = AtomicBool::new(false);
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) static QA_WINDOW_HIDE_CALLS: AtomicU64 = AtomicU64::new(0);

pub(super) struct RecordingStartGuard;

impl Drop for RecordingStartGuard {
    fn drop(&mut self) {
        STARTING_RECORDING.store(false, Ordering::SeqCst);
    }
}

pub(super) fn tool_state() -> std::sync::MutexGuard<'static, ToolState> {
    STATE
        .get_or_init(|| Mutex::new(ToolState::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn capture_lease() -> Result<Arc<session::SessionLease>, String> {
    if let Some(lease) = &tool_state().session_lease {
        return Ok(lease.clone());
    }
    session::SessionLease::acquire()?
        .map(Arc::new)
        .ok_or_else(|| "another Taomni instance is already capturing the screen".into())
}

pub(super) fn internal_error(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// App exit: stop recordings and delete temp files.
pub fn shutdown() {
    RECOVERY_FINALIZERS.get_or_init(Default::default).wait();
    record::cancel_all();
    capture::purge_tracked();
}

pub(crate) async fn wait_for_recovery_recording() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        RECOVERY_FINALIZERS.get_or_init(Default::default).wait()
    })
    .await
    .map_err(|_| "录屏安全收尾等待失败，请稍后重试退出。".to_owned())
}

/// A capture-control renderer died: stop input driving and finalize the clip
/// through existing owners. Never purge files or destroy/rebuild overlay windows.
pub(crate) fn stop_orphaned_capture_controls(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let finalizer = RECOVERY_FINALIZERS.get_or_init(Default::default).begin();
    let generation = SESSION_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let recording = {
        let mut state = tool_state();
        if let Some(control) = &state.scroll {
            control.request_stop(false);
        }
        // Transfer ownership before any close handler can cancel or purge it.
        state
            .recording
            .take()
            .or_else(|| state.recording_preview.take())
            .and_then(|id| record::take_for_recovery(&id))
    };
    if let Some(recording) = recording {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let message = match recording.finish() {
                Ok(info) => {
                    let saved = handle
                        .path()
                        .app_local_data_dir()
                        .map_err(|e| e.to_string())
                        .and_then(|root| {
                            recovery_file::preserve(
                                &info.path,
                                &root
                                    .join("recovered-recordings")
                                    .join(uuid::Uuid::new_v4().to_string()),
                            )
                            .map_err(|e| e.to_string())
                        });
                    match saved {
                        Ok(path) => format!(
                            "录屏已安全停止并保存，可使用文件管理器打开：\n{}\n关闭采集窗口或退出应用不会删除此文件。",
                            path.display()
                        ),
                        Err(error) => format!(
                            "录屏已停止，但持久保存失败：{error}\n临时文件位于：\n{}\n请尽快自行复制；系统临时目录清理后可能丢失。",
                            info.path.display()
                        ),
                    }
                }
                Err(error) => format!("采集已停止，但录屏收尾失败，未能确认完整文件：\n{error}"),
            };
            // Exit may wait for file work, never for GTK/window callbacks.
            drop(finalizer);
            let ui = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                // Copying a large finished clip can outlast this capture UI.
                // Never close the borders or restore windows of a newer capture.
                if SESSION_GENERATION.load(Ordering::SeqCst) == generation {
                    surfaces::close_borders(&ui);
                    restore_app_windows_for_preview(&ui);
                }
                ui.dialog()
                    .message(message)
                    .title("Taomni 采集控制中断")
                    .show(|_| {});
            });
        });
    } else {
        app.dialog().message("采集控制界面已退出，已请求停止采集；没有可接管的录屏，未确认新文件已保存。不会自动重新采集。")
            .title("Taomni 采集控制中断").show(|_| {});
    }
}

pub(super) async fn blocking<T: Send + 'static>(
    what: &str,
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{what} task failed: {e}"))?
        .map_err(internal_error)
}
