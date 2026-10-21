use super::model::HelperStatus;
use super::registry::HelperSession;
use super::registry::discard_helper_session;
use super::requests::send_cmd;
use super::status::request_status;
use crate::sockscap::paths::resolve_helper_exe;
use crate::sockscap::paths::resolve_windivert_dir;
use crate::sockscap::paths::windivert_missing_hint;
use crate::state::AppState;
use std::net::TcpStream;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use std::time::Instant;
use tauri::AppHandle;
use tauri::State;

pub(super) fn pick_free_port() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("pick free port: {e}"))?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

pub(super) fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("sc-{:x}-{:x}", n, std::process::id())
}

/// Probe a session already held in the registry.
///
/// - `Ok(Some(status))` — healthy and reusable, no new UAC prompt needed.
/// - `Ok(None)` — not usable; the caller should launch a fresh helper.
/// - `Err(_)` — broken in a way the user needs to see (e.g. WinDivert missing).
pub(super) fn probe_existing_helper(
    app: &AppHandle,
    sess: &HelperSession,
) -> Result<Option<HelperStatus>, String> {
    let Ok(mut st) = request_status(sess) else {
        return Ok(None);
    };
    if !st.running {
        return Ok(None);
    }
    if !st.elevated {
        let _ = send_cmd(sess, "shutdown", None);
        return Ok(None);
    }
    // Re-probe WinDivert so a stale helper without driver is rejected.
    match send_cmd(sess, "windivert_probe", Some("false".into())) {
        Ok(resp) if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) => {
            st.windivert = resp.get("result").cloned();
            st.message = "helper elevated; WinDivert OK".into();
            Ok(Some(st))
        }
        Ok(resp) => {
            let err = resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("probe failed");
            let _ = send_cmd(sess, "shutdown", None);
            Err(format!(
                "Existing helper cannot open WinDivert: {err}. {}",
                windivert_missing_hint(app)
            ))
        }
        Err(e) => {
            let _ = send_cmd(sess, "shutdown", None);
            Err(format!("Helper probe failed: {e}"))
        }
    }
}

/// Start the helper elevated on Windows (UAC prompt). No-op error on other OS.
#[tauri::command]
pub async fn sockscap_helper_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HelperStatus, String> {
    // Snapshot the registered session and release the lock before any blocking
    // helper RPC — holding it across the network round-trips below would stall
    // every other caller (relay lookups included) for the RPC timeout.
    let existing = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());

    if let Some(sess) = existing {
        match probe_existing_helper(&app, &sess) {
            Ok(Some(st)) => return Ok(st),
            // Unusable but not worth surfacing — fall through to a fresh launch.
            Ok(None) => discard_helper_session(&state, &sess),
            Err(e) => {
                // Drop the broken session *before* returning: leaving it in the
                // registry meant a retry in the same run kept re-probing the
                // very helper we just gave up on.
                discard_helper_session(&state, &sess);
                return Err(e);
            }
        }
    }
    // Clear dead session slot.
    if let Ok(mut guard) = state.sockscap.helper.inner.lock() {
        *guard = None;
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        return Err("Elevated SocksCap helper is only implemented on Windows".into());
    }

    #[cfg(windows)]
    {
        // Run the privileged binaries from a per-version app-data copy rather
        // than the install directory, so a live helper and a loaded WinDivert
        // driver never hold install-directory files open against an upgrade.
        // Falling back to running in place is no worse than before.
        let staged = crate::sockscap::paths::stage_privileged_runtime(&app);
        if let Err(e) = &staged {
            tracing::warn!("sockscap: staging privileged runtime failed ({e}); running in place");
        }
        let helper = match &staged {
            Ok((exe, _)) => exe.clone(),
            Err(_) => resolve_helper_exe(&app)?,
        };
        let token = random_token();
        let port = pick_free_port()?;
        let ready_dir = crate::resolved_app_data_dir(&app)?.join("sockscap");
        std::fs::create_dir_all(&ready_dir).map_err(|e| e.to_string())?;
        let ready_file = ready_dir.join(format!("helper-ready-{port}.json"));
        let ready_file = std::fs::canonicalize(&ready_dir)
            .map(|d| d.join(format!("helper-ready-{port}.json")))
            .unwrap_or(ready_file);
        let _ = std::fs::remove_file(&ready_file);

        let mut args = vec![
            "--token".into(),
            token.clone(),
            "--port".into(),
            port.to_string(),
            "--ready-file".into(),
            ready_file.display().to_string(),
            // Parent-death watchdog: helper self-terminates (and unloads
            // WinDivert) if this process dies without a clean shutdown RPC.
            "--parent-pid".into(),
            std::process::id().to_string(),
        ];
        // The pid alone is not a stable identity across the UAC prompt, which
        // the user may leave open for minutes. Pair it with this process's
        // creation time so the helper can tell "my parent" from "whatever now
        // holds that pid".
        if let Some(start) = current_process_start_filetime() {
            args.push("--parent-start".into());
            args.push(start.to_string());
        }

        // Hand over any orphaned helpers boot repair found but could not
        // terminate. This process is not elevated; the helper we are about to
        // launch is, so it is the only thing that can reap them.
        let reap: Vec<u32> = state
            .sockscap
            .pending_reap
            .lock()
            .map(|mut g| std::mem::take(&mut *g))
            .unwrap_or_default();
        if !reap.is_empty() {
            tracing::info!("sockscap: asking the new helper to reap orphan pids {reap:?}");
            args.push("--reap-pids".into());
            args.push(
                reap.iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        let wd = match &staged {
            Ok((_, dir)) => dir.clone(),
            Err(_) => match resolve_windivert_dir(&app) {
                Some(d) => d,
                None => return Err(windivert_missing_hint(&app)),
            },
        };
        // Absolute path required: elevated process cwd is typically System32.
        args.push("--windivert-dir".into());
        args.push(wd.display().to_string());
        tracing::info!(
            "sockscap: launching helper={} windivert-dir={}",
            helper.display(),
            wd.display()
        );

        // UAC elevation: PowerShell Start-Process -Verb RunAs
        elevate_and_spawn(&helper, &args)?;

        // Wait for ready file or TCP accept.
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut elevated = false;
        let mut pid = None;
        while Instant::now() < deadline {
            if ready_file.is_file() {
                if let Ok(s) = std::fs::read_to_string(&ready_file) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                        elevated = v.get("elevated").and_then(|x| x.as_bool()).unwrap_or(false);
                        pid = v.get("pid").and_then(|x| x.as_u64()).map(|n| n as u32);
                    }
                }
                if TcpStream::connect_timeout(
                    &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                    Duration::from_millis(200),
                )
                .is_ok()
                {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(150));
        }

        if TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(500),
        )
        .is_err()
        {
            // Abandon whatever half-started: a ready file for a helper we can
            // no longer reach would otherwise linger for boot repair to find.
            let _ = std::fs::remove_file(&ready_file);
            return Err(
                "Helper did not become ready. If you cancelled the UAC prompt, try again and click Yes."
                    .into(),
            );
        }

        let sess = HelperSession {
            token,
            port,
            pid,
            ready_file,
        };
        let mut st = request_status(&sess).unwrap_or(HelperStatus {
            running: true,
            elevated,
            endpoint: Some(format!("127.0.0.1:{port}")),
            message: "helper listening".into(),
            windivert: None,
            pid,
        });
        // Prefer live status elevated flag.
        elevated = st.elevated || elevated;
        st.elevated = elevated;

        if !st.elevated {
            let _ = send_cmd(&sess, "shutdown", None);
            sess.remove_ready_file();
            return Err(
                "SocksCap helper is not elevated. Capture requires Administrator. Re-start and accept the UAC prompt."
                    .into(),
            );
        }

        // Verify WinDivert can open under the elevated helper.
        match send_cmd(&sess, "windivert_probe", Some("false".into())) {
            Ok(resp) if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) => {
                st.windivert = resp.get("result").cloned();
                st.message = "helper elevated; WinDivert OK".into();
            }
            Ok(resp) => {
                let err = resp
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("WinDivert probe failed");
                let _ = send_cmd(&sess, "shutdown", None);
                sess.remove_ready_file();
                return Err(format!(
                    "Elevated helper started but WinDivert failed: {err}. {}",
                    windivert_missing_hint(&app)
                ));
            }
            Err(e) => {
                let _ = send_cmd(&sess, "shutdown", None);
                sess.remove_ready_file();
                return Err(format!("WinDivert probe error: {e}"));
            }
        }

        if let Ok(mut guard) = state.sockscap.helper.inner.lock() {
            *guard = Some(sess);
        }
        Ok(st)
    }
}

/// This process's creation time as a 64-bit FILETIME. Combined with the pid it
/// identifies the process uniquely, which a pid alone does not once the pid can
/// be recycled.
#[cfg(windows)]
pub(super) fn current_process_start_filetime() -> Option<u64> {
    use winapi::shared::minwindef::FILETIME;
    use winapi::um::processthreadsapi::{GetCurrentProcess, GetProcessTimes};

    unsafe {
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        ) == 0
        {
            return None;
        }
        Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}

#[cfg(windows)]
pub(super) fn elevate_and_spawn(helper: &Path, args: &[String]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let helper_s = helper.display().to_string().replace('\'', "''");
    let arg_list = args
        .iter()
        .map(|a| format!("'{}'", a.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "Start-Process -FilePath '{}' -ArgumentList @({}) -Verb RunAs -WindowStyle Hidden",
        helper_s, arg_list
    );

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to launch elevated helper: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "UAC elevate failed (cancelled?): {}",
            stderr.trim()
        ));
    }
    Ok(())
}

/// Ensure helper is running (elevate via UAC if needed). Returns current status.
pub async fn ensure_helper(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<HelperStatus, String> {
    sockscap_helper_start(app.clone(), state.clone()).await
}
