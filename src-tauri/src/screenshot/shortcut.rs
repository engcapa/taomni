//! OS-global screenshot hotkey: configurable, persisted, conflict-aware.
//!
//! Default is `Ctrl+Alt+A` (`Ctrl+Cmd+A` on macOS), the QQ/WeChat/DingTalk
//! convention. Feishu's `Ctrl+Shift+A` is deliberately not used: it is
//! Find Action in Taomni's own code workspace (and in IntelliJ/VS Code), and
//! a global grab would steal it from every application.
//!
//! Registration failures (chord owned by another app, Wayland without a
//! global-shortcut portal) are reported in [`ShortcutStatus`]; the frontend
//! then handles the chord app-locally while a Taomni window is focused.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(target_os = "macos")]
pub const DEFAULT_SHORTCUT: &str = "Control+Super+A";
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_SHORTCUT: &str = "Control+Alt+A";

const SETTINGS_FILE: &str = "screenshot-settings.json";
const OPEN_FAILED_EVENT: &str = "screenshot://open-failed";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// `None` = default chord, `Some("")` = disabled.
    #[serde(default)]
    global_shortcut: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    /// Configured chord; empty when disabled.
    pub accelerator: String,
    pub default_accelerator: String,
    pub enabled: bool,
    /// Whether the OS accepted the global registration.
    pub registered: bool,
    pub error: Option<String>,
}

struct Current {
    accelerator: String,
    registered: Option<Shortcut>,
    error: Option<String>,
}

static CURRENT: Mutex<Option<Current>> = Mutex::new(None);

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    crate::resolved_app_data_dir(app)
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("app data dir unavailable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create settings dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("save screenshot settings: {e}"))
}

fn effective(settings: &Settings) -> String {
    match &settings.global_shortcut {
        None => DEFAULT_SHORTCUT.to_string(),
        Some(s) => s.trim().to_string(),
    }
}

/// Parse an accelerator such as `Control+Alt+A`.
pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = accelerator
        .trim()
        .parse()
        .map_err(|e| format!("invalid shortcut '{accelerator}': {e}"))?;
    if shortcut.mods.is_empty() {
        let key = format!("{:?}", shortcut.key);
        // A bare letter/digit would make the key untypable system-wide.
        if key.starts_with("Key") || key.starts_with("Digit") {
            return Err(format!(
                "shortcut '{accelerator}' needs a modifier (Ctrl, Alt, Shift or Cmd)"
            ));
        }
    }
    Ok(shortcut)
}

fn register(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app_handle, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = open_from_shortcut(&app).await {
                        log::warn!("global screenshot shortcut failed: {e}");
                    }
                });
            }
        })
        .map_err(|e| format!("{e}"))
}

/// Route a global-shortcut failure back to a visible app window so permission
/// instructions remain usable even when the shortcut was pressed in another app.
pub(super) async fn open_from_shortcut(app: &AppHandle) -> Result<(), String> {
    let result = super::open_overlay(app, None).await;
    if let Err(error) = &result {
        let window = app.get_webview_window("main").or_else(|| {
            app.webview_windows()
                .into_values()
                .find(|window| !window.label().starts_with("screenshot-"))
        });
        if let Some(window) = window {
            let _ = window.show();
            let _ = window.set_focus();
            if let Err(e) = window.emit(OPEN_FAILED_EVENT, error.clone()) {
                log::warn!("could not show screenshot error: {e}");
            }
        }
    }
    result
}

fn status_of(current: &Current) -> ShortcutStatus {
    ShortcutStatus {
        accelerator: current.accelerator.clone(),
        default_accelerator: DEFAULT_SHORTCUT.to_string(),
        enabled: !current.accelerator.is_empty(),
        registered: current.registered.is_some(),
        error: current.error.clone(),
    }
}

/// Apply `accelerator` (empty = disabled): unregister the old chord and
/// register the new one. On a registration failure the old chord is
/// restored and the error returned.
fn apply(app: &AppHandle, accelerator: String) -> Result<ShortcutStatus, String> {
    let new_shortcut = if accelerator.is_empty() {
        None
    } else {
        Some(parse(&accelerator)?)
    };
    let mut guard = CURRENT.lock().unwrap_or_else(|p| p.into_inner());
    let previous = guard.take();
    if let Some(old) = previous.as_ref().and_then(|c| c.registered) {
        let _ = app.global_shortcut().unregister(old);
    }
    let result = match new_shortcut {
        None => Ok(None),
        Some(shortcut) => register(app, shortcut).map(|()| Some(shortcut)),
    };
    match result {
        Ok(registered) => {
            let current = Current {
                accelerator,
                registered,
                error: None,
            };
            let status = status_of(&current);
            *guard = Some(current);
            Ok(status)
        }
        Err(e) => {
            // Put the previous chord back so a failed change is a no-op.
            if let Some(mut prev) = previous {
                if let Some(old) = prev.registered {
                    if register(app, old).is_err() {
                        prev.registered = None;
                    }
                }
                *guard = Some(prev);
            }
            Err(format!(
                "could not register '{accelerator}' (it may be used by another application): {e}"
            ))
        }
    }
}

/// Startup registration from the persisted setting. Failures are recorded
/// in the status instead of aborting startup.
pub fn init(app: &AppHandle) {
    let accelerator = effective(&load(app));
    if let Err(e) = apply(app, accelerator.clone()) {
        log::warn!("screenshot shortcut: {e}");
        *CURRENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(Current {
            accelerator,
            registered: None,
            error: Some(e),
        });
    }
}

pub(super) fn current_status() -> ShortcutStatus {
    CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(status_of)
        .unwrap_or(ShortcutStatus {
            accelerator: DEFAULT_SHORTCUT.to_string(),
            default_accelerator: DEFAULT_SHORTCUT.to_string(),
            enabled: true,
            registered: false,
            error: Some("global shortcut not initialised".to_string()),
        })
}

#[tauri::command]
pub async fn screenshot_shortcut_status() -> Result<ShortcutStatus, String> {
    Ok(current_status())
}

/// `None` resets to the default chord, `""` disables, anything else is
/// validated and registered. Persisted only when the OS accepts it.
#[tauri::command]
pub async fn screenshot_shortcut_set(
    app: AppHandle,
    accelerator: Option<String>,
) -> Result<ShortcutStatus, String> {
    let settings = Settings {
        global_shortcut: accelerator.as_ref().map(|s| s.trim().to_string()),
    };
    let status = apply(&app, effective(&settings))?;
    save(&app, &settings)?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shortcut_parses_and_has_modifiers() {
        let shortcut = parse(DEFAULT_SHORTCUT).unwrap();
        assert!(!shortcut.mods.is_empty());
    }

    #[test]
    fn bare_letters_are_rejected_but_function_keys_allowed() {
        assert!(parse("A").is_err());
        assert!(parse("5").is_err());
        assert!(parse("F1").is_ok());
        assert!(parse("Control+Shift+X").is_ok());
        assert!(parse("Control+Shift").is_err());
        assert!(parse("Banana+Q").is_err());
    }

    #[test]
    fn settings_effective_value() {
        assert_eq!(effective(&Settings::default()), DEFAULT_SHORTCUT);
        assert_eq!(
            effective(&Settings {
                global_shortcut: Some(String::new())
            }),
            ""
        );
        assert_eq!(
            effective(&Settings {
                global_shortcut: Some(" Alt+F1 ".into())
            }),
            "Alt+F1"
        );
    }
}
