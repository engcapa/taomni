use anyhow::Context;
use tauri::AppHandle;

/// Denial-only fault at the permission boundary. It cannot grant OS access and
/// is available only to an isolated debug QA scenario.
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) static QA_DENY_CAPTURE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(all(debug_assertions, target_os = "macos"))]
pub(in crate::screenshot) struct QaPermissionDenial;

#[cfg(all(debug_assertions, target_os = "macos"))]
impl QaPermissionDenial {
    pub(in crate::screenshot) fn new(app: &AppHandle) -> anyhow::Result<Self> {
        anyhow::ensure!(
            app.config().identifier == crate::QA_APP_ID,
            "permission fault requires isolated QA app"
        );
        QA_DENY_CAPTURE.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(Self)
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
impl Drop for QaPermissionDenial {
    fn drop(&mut self) {
        QA_DENY_CAPTURE.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
pub(in crate::screenshot) fn capture_permission_granted() -> bool {
    #[cfg(debug_assertions)]
    if QA_DENY_CAPTURE.load(std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    crate::servers::rdp::capture::mac::permission_granted()
}

/// CoreGraphics can return a valid image containing only wallpaper and our
/// own windows without Screen Recording access. A successful image read is
/// therefore insufficient evidence that the whole display was captured.
pub(in crate::screenshot) fn ensure_capture_permission() -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    if !capture_permission_granted() {
        anyhow::bail!(
            "Screenshot requires macOS Screen Recording permission. Open System Settings > Privacy & Security > Screen Recording and enable Taomni. After an update, re-add the current Taomni.app if the existing authorization no longer works. Quit and reopen the app after granting permission. If macOS names a terminal as the requester, enable and restart that terminal instead."
        );
    }
    Ok(())
}

/// Request consent while the invoking windows remain visible. Prompts belong
/// on the main thread; capturing/recording workers only check permission.
pub(in crate::screenshot) async fn request_capture_permission(
    app: &AppHandle,
) -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    if !capture_permission_granted() {
        #[cfg(debug_assertions)]
        if QA_DENY_CAPTURE.load(std::sync::atomic::Ordering::SeqCst) {
            return ensure_capture_permission();
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::servers::rdp::capture::mac::request_permission());
        })
        .context("request Screen Recording permission")?;
        let _ = rx
            .await
            .context("Screen Recording permission request cancelled")?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    // macOS may require a restart even after the user accepts the prompt.
    ensure_capture_permission()
}
