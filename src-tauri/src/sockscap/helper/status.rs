use super::model::HelperStatus;
use super::registry::{HelperRegistry, HelperSession};
use super::requests::send_cmd;
use crate::state::AppState;
use serde_json::json;
use tauri::State;

#[tauri::command]
pub async fn sockscap_helper_stop(state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.legacy.sockscap.operation.lock().await;
    stop_registered(&state.legacy.sockscap.helper).await
}

pub(in crate::sockscap) async fn stop_registered(
    registry: &std::sync::Arc<HelperRegistry>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let registry = registry.clone();
        tokio::task::spawn_blocking(move || registry.confirm_shutdown())
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = registry;
        Ok(())
    }
}

#[cfg(windows)]
impl HelperRegistry {
    pub(in crate::sockscap) fn confirm_shutdown(&self) -> Result<(), String> {
        use std::time::{Duration, Instant};

        let session = self.inner.lock().map_err(|e| e.to_string())?.clone();
        let Some(session) = session else {
            return Ok(());
        };
        let ready_exists = || {
            session
                .ready_file
                .try_exists()
                .map_err(|error| error.to_string())
        };
        if ready_exists()? {
            super::requests::send_json_timeout(
                &session,
                json!({ "cmd": "shutdown" }),
                Duration::from_secs(10),
            )
            .and_then(super::requests::expect_ok)?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while ready_exists()? {
                if Instant::now() >= deadline {
                    return Err(
                        "SocksCap helper still reports itself as ready after shutdown".into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }
        // The helper removes this file itself after releasing capture. Leave
        // the session registered if shutdown is unconfirmed, for a retry.
        *self.inner.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }
}

#[tauri::command]
pub async fn sockscap_helper_status(state: State<'_, AppState>) -> Result<HelperStatus, String> {
    let guard = state
        .legacy
        .sockscap
        .helper
        .inner
        .lock()
        .map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(sess) => request_status(sess),
        None => Ok(HelperStatus {
            running: false,
            elevated: false,
            endpoint: None,
            message: "helper not running".into(),
            windivert: None,
            pid: None,
        }),
    }
}

#[tauri::command]
pub async fn sockscap_helper_probe_windivert(
    state: State<'_, AppState>,
    filter: Option<String>,
) -> Result<serde_json::Value, String> {
    let guard = state
        .legacy
        .sockscap
        .helper
        .inner
        .lock()
        .map_err(|e| e.to_string())?;
    let sess = guard
        .as_ref()
        .ok_or_else(|| "helper not running — start it first (UAC)".to_string())?;
    let resp = send_cmd(sess, "windivert_probe", filter)?;
    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(resp.get("result").cloned().unwrap_or(json!({})))
    } else {
        Err(resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("windivert probe failed")
            .to_string())
    }
}

pub(super) fn request_status(sess: &HelperSession) -> Result<HelperStatus, String> {
    let resp = send_cmd(sess, "status", None)?;
    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        return Ok(HelperStatus {
            running: false,
            elevated: false,
            endpoint: Some(format!("127.0.0.1:{}", sess.port)),
            message: resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("helper not responding")
                .to_string(),
            windivert: None,
            pid: sess.pid,
        });
    }
    let result = resp.get("result").cloned().unwrap_or(json!({}));
    Ok(HelperStatus {
        running: true,
        elevated: result
            .get("elevated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        endpoint: Some(format!("127.0.0.1:{}", sess.port)),
        message: "helper ok".into(),
        windivert: None,
        pid: result
            .get("pid")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .or(sess.pid),
    })
}
