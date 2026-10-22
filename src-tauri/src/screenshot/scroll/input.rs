use crate::screenshot::capture::DisplayInfo;
#[cfg(all(debug_assertions, target_os = "macos"))]
use std::sync::atomic::AtomicBool;
#[cfg(all(debug_assertions, target_os = "macos"))]
use std::sync::atomic::Ordering;
#[cfg(target_os = "windows")]
use std::time::Duration;
use tauri::AppHandle;

pub(super) fn pointer_in_region(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
) -> bool {
    // Wayland owns pointer routing through its approved portal session.
    if super::super::pins::native_wayland() {
        return true;
    }
    app.cursor_position()
        .map(|point| {
            let left = (display.x + region.0 as i32) as f64;
            let top = (display.y + region.1 as i32) as f64;
            point.x >= left
                && point.x < left + region.2 as f64
                && point.y >= top
                && point.y < top + region.3 as f64
        })
        .unwrap_or(true)
}

// ---------------------------------------------------------------------------
// Input synthesis
// ---------------------------------------------------------------------------

pub(super) struct Wheel {
    pub(super) enigo: enigo::Enigo,
}

/// A denial-only fault at the permission boundary, scoped to an isolated QA scenario.
/// Never grants permissions or modifies the host TCC database.
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) static QA_DENY_CONTROL: AtomicBool = AtomicBool::new(false);

#[cfg(all(debug_assertions, target_os = "macos"))]
pub(in crate::screenshot) struct QaPermissionDenial;

#[cfg(all(debug_assertions, target_os = "macos"))]
impl QaPermissionDenial {
    pub(in crate::screenshot) fn new(app: &tauri::AppHandle) -> anyhow::Result<Self> {
        anyhow::ensure!(
            app.config().identifier == crate::QA_APP_ID,
            "permission fault requires isolated QA app"
        );
        QA_DENY_CONTROL.store(true, Ordering::SeqCst);
        Ok(Self)
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
impl Drop for QaPermissionDenial {
    fn drop(&mut self) {
        QA_DENY_CONTROL.store(false, Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
pub(super) fn control_permission_granted() -> bool {
    #[cfg(debug_assertions)]
    if QA_DENY_CONTROL.load(Ordering::SeqCst) {
        return false;
    }
    crate::servers::rdp::control_permission_granted()
}

pub(in crate::screenshot) fn ensure_control_permission() -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    if !control_permission_granted() {
        anyhow::bail!(
            "Scrolling capture requires macOS Accessibility permission. Press Esc to leave the screenshot overlay, then open System Settings > Privacy & Security > Accessibility and enable Taomni. If launched from Terminal, enable Terminal instead (or the terminal app named by macOS); use + to add /System/Applications/Utilities/Terminal.app if it is missing. Restart the launching app after granting permission, then retry."
        );
    }
    Ok(())
}

impl Wheel {
    pub(super) fn new() -> anyhow::Result<Self> {
        ensure_control_permission()?;
        let settings = enigo::Settings {
            // Default Enigo initialization prompts from the capture worker,
            // behind our topmost/fullscreen windows. Preflight above instead.
            #[cfg(target_os = "macos")]
            open_prompt_to_get_permissions: false,
            ..enigo::Settings::default()
        };
        let enigo = enigo::Enigo::new(&settings).map_err(|e| {
            anyhow::anyhow!(
                "input synthesis unavailable ({e}); on macOS grant Accessibility permission to Taomni"
            )
        })?;
        Ok(Self { enigo })
    }

    /// Move the pointer to display-relative physical `(px, py)`.
    pub(super) fn move_to(
        &mut self,
        display: &DisplayInfo,
        px: u32,
        py: u32,
    ) -> anyhow::Result<()> {
        let gx = display.x + px as i32;
        let gy = display.y + py as i32;
        #[cfg(target_os = "windows")]
        {
            // enigo normalises absolute moves to the primary monitor only;
            // SetCursorPos takes virtual-desktop physical pixels (the app is
            // per-monitor DPI aware), so any display works.
            let _ = &mut self.enigo;
            use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
            unsafe {
                SetCursorPos(gx, gy).map_err(|e| anyhow::anyhow!("move pointer: {e}"))?;
            }
            activate_scroll_target(gx, gy);
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            use enigo::{Coordinate, Mouse};
            // Quartz event coordinates are logical points.
            let (ex, ey) = if cfg!(target_os = "macos") {
                let s = display.scale_factor.max(1.0);
                (
                    (gx as f64 / s).round() as i32,
                    (gy as f64 / s).round() as i32,
                )
            } else {
                (gx, gy)
            };
            self.enigo
                .move_mouse(ex, ey, Coordinate::Abs)
                .map_err(|e| anyhow::anyhow!("move pointer: {e}"))
        }
    }

    /// Positive scrolls the content down (towards the page end).
    pub(super) fn scroll(&mut self, notches: i32) -> anyhow::Result<()> {
        use enigo::{Axis, Mouse};
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};
            let mut point = POINT::default();
            if GetCursorPos(&mut point).is_ok() {
                // Returning from the controls must work with Windows' inactive
                // window scrolling disabled, without moving the user's mouse.
                activate_scroll_target(point.x, point.y);
            }
        }
        self.enigo
            .scroll(notches, Axis::Vertical)
            .map_err(|e| anyhow::anyhow!("synthesize scroll: {e}"))
    }
}

/// Best-effort activation of the window under the crop. SendInput wheel
/// events go to the old focused app when Windows "Scroll inactive windows"
/// is disabled, so try to activate the target without clicking its content.
/// The foreground lock routinely rejects this once our overlay has hidden;
/// that must not stop the capture: with the default setting Windows routes
/// the wheel to the hovered window anyway, and real non-delivery is caught
/// by the unchanged-frame detection.
#[cfg(target_os = "windows")]
pub(super) fn activate_scroll_target(gx: i32, gy: i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        GA_ROOT, GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        WindowFromPoint,
    };
    unsafe {
        // Activate the actual top-level target. Its owner can be a different
        // (even hidden) app window; focusing that owner loses wheel delivery.
        let target = GetAncestor(WindowFromPoint(POINT { x: gx, y: gy }), GA_ROOT);
        if target.is_invalid() {
            return;
        }
        let foreground = GetForegroundWindow();
        if target == foreground {
            return;
        }
        let mut activated = SetForegroundWindow(target).as_bool();
        if !activated && !foreground.is_invalid() {
            // Sharing the foreground thread's input state lifts the lock.
            let current = GetCurrentThreadId();
            let owner = GetWindowThreadProcessId(foreground, None);
            if owner != 0 && owner != current && AttachThreadInput(current, owner, true).as_bool() {
                activated = SetForegroundWindow(target).as_bool();
                let _ = AttachThreadInput(current, owner, false);
            }
        }
        if activated {
            std::thread::sleep(Duration::from_millis(80));
        } else {
            log::debug!(
                "scroll capture: could not activate target window; relying on hover wheel routing"
            );
        }
    }
}
