use crate::servers::rdp;
use tauri::AppHandle;

/// Probe RDP desktop-capture readiness. On macOS the optional permission
/// request is dispatched to the main thread because the OS owns the consent
/// prompt. Merely opening settings passes `false` and never prompts.
#[tauri::command]
pub async fn probe_rdp_capture(
    app: AppHandle,
    request_permission: bool,
    request_control_permission: bool,
) -> Result<rdp::capture::CaptureProbe, String> {
    #[cfg(target_os = "macos")]
    if request_permission && !rdp::capture::mac::permission_granted() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(rdp::capture::mac::request_permission());
        })
        .map_err(|e| format!("failed to request Screen Recording permission: {e}"))?;
        let _ = rx
            .await
            .map_err(|_| "Screen Recording permission request was cancelled".to_string())?;
    }

    #[cfg(target_os = "macos")]
    if request_control_permission && !rdp::control_permission_granted() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(rdp::request_control_permission());
        })
        .map_err(|e| format!("failed to request Accessibility permission: {e}"))?;
        let _ = rx
            .await
            .map_err(|_| "Accessibility permission request was cancelled".to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, request_permission, request_control_permission);

    rdp::capture::probe().map_err(|e| e.to_string())
}

/// Windows built-in Remote Desktop state for the RDP settings card and the
/// start confirmation (non-Windows: `applicable = false`).
#[tauri::command]
pub async fn probe_system_rdp() -> Result<rdp::system_rdp::SystemRdpStatus, String> {
    tokio::task::spawn_blocking(rdp::system_rdp::probe)
        .await
        .map_err(|e| format!("system Remote Desktop probe failed: {e}"))
}

/// Open the operating system's Remote Desktop settings page (Windows only).
#[tauri::command]
pub async fn open_system_rdp_settings() -> Result<(), String> {
    tokio::task::spawn_blocking(rdp::system_rdp::open_settings)
        .await
        .map_err(|e| format!("failed to open Remote Desktop settings: {e}"))?
}
