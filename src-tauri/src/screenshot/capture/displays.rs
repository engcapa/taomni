use anyhow::Context;
use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// Stable within a session: `"{x},{y}"` of the physical origin.
    pub id: String,
    pub name: String,
    /// Physical pixels.
    pub width: u32,
    pub height: u32,
    /// Physical origin in the virtual desktop.
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
    pub primary: bool,
}

impl DisplayInfo {
    #[cfg(target_os = "linux")]
    pub(in crate::screenshot) fn logical_rect(&self) -> (i32, i32, i32, i32) {
        let scale = self.scale_factor.max(1.0);
        (
            (self.x as f64 / scale).round() as i32,
            (self.y as f64 / scale).round() as i32,
            (self.width as f64 / scale).round() as i32,
            (self.height as f64 / scale).round() as i32,
        )
    }

    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x as f64
            && py >= self.y as f64
            && px < self.x as f64 + self.width as f64
            && py < self.y as f64 + self.height as f64
    }
}

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

pub fn list_displays(app: &AppHandle) -> anyhow::Result<Vec<DisplayInfo>> {
    #[cfg(target_os = "linux")]
    let mut displays = {
        // Tauri's AppHandle monitor APIs access GDK directly on the caller's
        // thread. In particular, reading the work area performs Xlib requests.
        // Snapshot them on GTK's main thread before capture/recording workers
        // use the values, otherwise GTK's X11 reply queue can be corrupted.
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let main_app = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(read_displays(&main_app));
        })
        .context("dispatch monitor enumeration to GTK")?;
        rx.recv_timeout(Duration::from_secs(5))
            .context("wait for GTK monitor enumeration")??
    };
    #[cfg(not(target_os = "linux"))]
    let mut displays = read_displays(app)?;

    // Starting a capture backend can block; keep the fallback off GTK's thread.
    if displays.is_empty() {
        displays = fallback_displays(app)?;
    }
    if !displays.iter().any(|d| d.primary) {
        displays[0].primary = true;
    }
    Ok(displays)
}

pub(super) fn read_displays(app: &AppHandle) -> anyhow::Result<Vec<DisplayInfo>> {
    let monitors = app.available_monitors().context("enumerate monitors")?;
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    Ok(monitors
        .iter()
        .map(|m| {
            let pos = *m.position();
            let size = *m.size();
            DisplayInfo {
                id: format!("{},{}", pos.x, pos.y),
                name: m.name().cloned().unwrap_or_else(|| "Display".to_string()),
                width: size.width,
                height: size.height,
                x: pos.x,
                y: pos.y,
                scale_factor: m.scale_factor(),
                primary: primary == Some(pos),
            }
        })
        .filter(|d| d.width > 0 && d.height > 0)
        .collect())
}

/// Some Linux sessions report no monitors through GDK; fall back to the
/// capture backend's desktop size as a single display.
pub(super) fn fallback_displays(app: &AppHandle) -> anyhow::Result<Vec<DisplayInfo>> {
    #[cfg(target_os = "linux")]
    {
        let log =
            crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
        let capturer =
            crate::servers::rdp::capture::create_capturer(&log).context("init screen capturer")?;
        let (width, height) = capturer.desktop_size();
        Ok(vec![DisplayInfo {
            id: "0,0".to_string(),
            name: "Display".to_string(),
            width: u32::from(width),
            height: u32::from(height),
            x: 0,
            y: 0,
            scale_factor: 1.0,
            primary: true,
        }])
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        anyhow::bail!("no displays found")
    }
}

/// The requested display, or the primary one when `id` is empty/unknown.
pub fn resolve_display(app: &AppHandle, id: Option<&str>) -> anyhow::Result<DisplayInfo> {
    let displays = list_displays(app)?;
    if let Some(want) = id.filter(|v| !v.trim().is_empty()) {
        if let Some(d) = displays.iter().find(|d| d.id == want) {
            return Ok(d.clone());
        }
        anyhow::bail!("display '{want}' is no longer available");
    }
    Ok(primary_of(displays))
}

/// The display under the mouse pointer (hotkey / button trigger), falling
/// back to the primary display.
pub fn display_at_cursor(app: &AppHandle) -> anyhow::Result<DisplayInfo> {
    #[cfg(target_os = "linux")]
    if crate::servers::rdp::capture::wayland::is_wayland_session() {
        // Wayland cannot expose the global cursor; Tao returns a synthetic
        // (0,0). Choose the invoking/main window's monitor before hiding it.
        if let Some(window) = app.get_webview_window("main") {
            return display_for_window(app, &window);
        }
        return resolve_display(app, None);
    }
    let displays = list_displays(app)?;
    if let Ok(pos) = app.cursor_position() {
        if let Some(d) = displays.iter().find(|d| d.contains(pos.x, pos.y)) {
            return Ok(d.clone());
        }
    }
    Ok(primary_of(displays))
}

#[cfg(target_os = "linux")]
pub(in crate::screenshot) fn display_for_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> anyhow::Result<DisplayInfo> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let window = window.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(window.current_monitor().map(|m| {
            m.map(|m| {
                let p = m.position();
                format!("{},{}", p.x, p.y)
            })
        }));
    })
    .context("dispatch invoking monitor lookup to GTK")?;
    let id = rx
        .recv_timeout(Duration::from_secs(5))
        .context("wait for invoking monitor")??;
    resolve_display(app, id.as_deref())
}

pub(super) fn primary_of(displays: Vec<DisplayInfo>) -> DisplayInfo {
    let index = displays.iter().position(|d| d.primary).unwrap_or(0);
    displays
        .into_iter()
        .nth(index)
        .expect("displays is non-empty")
}

/// Map a display to its xcap monitor. xcap reports physical origins on
/// Windows (the app is per-monitor DPI aware) and logical points on macOS.
#[cfg(not(target_os = "linux"))]
pub(super) fn xcap_monitor_for(display: &DisplayInfo) -> anyhow::Result<xcap::Monitor> {
    let monitors = xcap::Monitor::all().context("enumerate displays")?;
    let scale = if cfg!(target_os = "macos") {
        display.scale_factor
    } else {
        1.0
    };
    let matches = |m: &xcap::Monitor| {
        let mx = (m.x().unwrap_or(0) as f64 * scale).round() as i32;
        let my = (m.y().unwrap_or(0) as f64 * scale).round() as i32;
        (mx - display.x).abs() <= 2 && (my - display.y).abs() <= 2
    };
    monitors
        .iter()
        .find(|m| matches(m))
        .or_else(|| {
            if display.primary {
                monitors.iter().find(|m| m.is_primary().unwrap_or(false))
            } else {
                None
            }
        })
        .or(if monitors.len() == 1 {
            monitors.first()
        } else {
            None
        })
        .cloned()
        .with_context(|| format!("no capture source for display {}", display.id))
}

/// Native display id for the RDP capture backends (xcap id on Windows,
/// CGDirectDisplayID on macOS). Linux captures the whole desktop.
pub(super) fn native_display_id(display: &DisplayInfo) -> Option<String> {
    #[cfg(not(target_os = "linux"))]
    {
        xcap_monitor_for(display)
            .ok()
            .and_then(|m| m.id().ok())
            .map(|id| id.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = display;
        None
    }
}
