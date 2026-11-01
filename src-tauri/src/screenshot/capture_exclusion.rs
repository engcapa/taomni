//! P1-6: keep the app's own windows out of a still capture without hiding
//! them first (Windows `WDA_EXCLUDEFROMCAPTURE`, macOS `NSWindowSharingNone`).
//!
//! The overlay is then shown over a desktop the user never saw disappear,
//! and the app windows are hidden behind it afterwards. Exclusion is used
//! only on OS versions whose capture path honours it (see [`supported`]),
//! only when every window reads the setting back, and it is always restored
//! (explicitly after hiding, or by `Drop` on every error path). Anything
//! else falls back to the hide-then-capture path.

use super::window_lifecycle::capturable_app_windows;
use tauri::AppHandle;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::Manager;

/// Name of the exclusion API this OS version supports, `None` otherwise.
pub(super) fn supported() -> Option<&'static str> {
    imp::supported()
}

struct Excluded {
    label: String,
    /// Native setting before exclusion, restored on release.
    #[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
    original: u64,
}

/// App windows currently excluded from capture.
pub(super) struct Exclusion {
    app: AppHandle,
    windows: Vec<Excluded>,
}

impl Exclusion {
    pub(super) fn labels(&self) -> Vec<String> {
        self.windows.iter().map(|w| w.label.clone()).collect()
    }

    /// Restore the original capture settings (queued on the UI thread after
    /// any hide requested before this call).
    pub(super) fn release(mut self) {
        self.restore();
    }

    fn restore(&mut self) {
        let windows = std::mem::take(&mut self.windows);
        if windows.is_empty() {
            return;
        }
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            for window in windows {
                imp::restore(&app, &window.label, window.original);
            }
        });
    }
}

impl Drop for Exclusion {
    fn drop(&mut self) {
        self.restore();
    }
}

/// Exclude every visible app window from capture. `Err` means the caller
/// must use the hiding path; no window keeps a changed setting in that case.
pub(super) async fn exclude_app_windows(app: &AppHandle) -> Result<Exclusion, String> {
    let api = supported().ok_or("capture exclusion is not verified on this OS version")?;
    let labels: Vec<String> = capturable_app_windows(app)
        .into_iter()
        .map(|(label, _)| label)
        .collect();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let worker = app.clone();
    app.run_on_main_thread(move || {
        // Construct the cleanup owner before applying any settings. If the
        // receiver times out or is dropped, a failed send drops this owner.
        let mut excluded = Exclusion {
            app: worker.clone(),
            windows: Vec::new(),
        };
        let mut result = Ok(());
        for label in labels {
            match imp::exclude(&worker, &label) {
                Ok(original) => excluded.windows.push(Excluded { label, original }),
                Err(error) => {
                    result = Err(format!("{api} failed for {label}: {error}"));
                    break;
                }
            }
        }
        if result.is_err() {
            for window in excluded.windows.drain(..) {
                imp::restore(&worker, &window.label, window.original);
            }
        } else {
            imp::flush();
        }
        let _ = tx.send(result.map(|()| excluded));
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(3), rx)
        .await
        .map_err(|_| "capture exclusion timed out".to_string())?
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::DwmFlush;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
        WINDOW_DISPLAY_AFFINITY,
    };

    /// `WDA_EXCLUDEFROMCAPTURE` exists since Windows 10 2004 (build 19041).
    /// Earlier builds silently treat it as `WDA_MONITOR`, which would paint
    /// a black window into the capture, so they must keep hiding.
    const FIRST_BUILD: u32 = 19041;

    pub(super) fn supported() -> Option<&'static str> {
        static BUILD: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
        let build = *BUILD.get_or_init(|| {
            winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
                .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
                .and_then(|key| key.get_value::<String, _>("CurrentBuildNumber"))
                .ok()
                .and_then(|value| value.trim().parse().ok())
        });
        build
            .is_some_and(|build| build >= FIRST_BUILD)
            .then_some("WDA_EXCLUDEFROMCAPTURE")
    }

    fn hwnd(app: &AppHandle, label: &str) -> Result<HWND, String> {
        let window = app
            .get_webview_window(label)
            .ok_or("window closed before exclusion")?;
        let raw = window.hwnd().map_err(|e| e.to_string())?;
        Ok(HWND(raw.0 as _))
    }

    pub(super) fn exclude(app: &AppHandle, label: &str) -> Result<u64, String> {
        let hwnd = hwnd(app, label)?;
        let mut original = 0u32;
        // SAFETY: a live top-level window of this process, on its UI thread.
        unsafe {
            GetWindowDisplayAffinity(hwnd, &mut original).map_err(|e| e.to_string())?;
            SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).map_err(|e| e.to_string())?;
            let mut applied = 0u32;
            if let Err(error) = GetWindowDisplayAffinity(hwnd, &mut applied) {
                let _ = SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(original));
                return Err(error.to_string());
            }
            if applied != WDA_EXCLUDEFROMCAPTURE.0 {
                let _ = SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(original));
                return Err(format!("affinity read back as {applied:#x}"));
            }
        }
        Ok(u64::from(original))
    }

    pub(super) fn restore(app: &AppHandle, label: &str, original: u64) {
        if let Ok(hwnd) = hwnd(app, label) {
            // SAFETY: as in `exclude`.
            let _ =
                unsafe { SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(original as u32)) };
        }
    }

    /// Let DWM compose one frame without the excluded windows.
    pub(super) fn flush() {
        // SAFETY: no arguments; blocks until the next composition pass.
        let _ = unsafe { DwmFlush() };
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    /// `NSWindowSharingNone`.
    const SHARING_NONE: usize = 0;
    /// Candidate version for the explicit exclusion experiment. API readback
    /// alone is not pixel evidence; DEFAULT keeps exclusion off until N28.
    const CANDIDATE_MAJOR: std::ops::RangeInclusive<isize> = 15..=15;

    pub(super) fn supported() -> Option<&'static str> {
        static MAJOR: std::sync::OnceLock<isize> = std::sync::OnceLock::new();
        let major = *MAJOR.get_or_init(|| {
            objc2_foundation::NSProcessInfo::processInfo()
                .operatingSystemVersion()
                .majorVersion
        });
        CANDIDATE_MAJOR
            .contains(&major)
            .then_some("NSWindowSharingNone")
    }

    fn ns_window(app: &AppHandle, label: &str) -> Result<*mut AnyObject, String> {
        let window = app
            .get_webview_window(label)
            .ok_or("window closed before exclusion")?;
        let raw = window.ns_window().map_err(|e| e.to_string())?;
        if raw.is_null() {
            return Err("missing NSWindow".into());
        }
        Ok(raw.cast())
    }

    pub(super) fn exclude(app: &AppHandle, label: &str) -> Result<u64, String> {
        let window = ns_window(app, label)?;
        // SAFETY: a live NSWindow of this process, used on the main thread.
        unsafe {
            let window = &*window;
            let original: usize = msg_send![window, sharingType];
            let _: () = msg_send![window, setSharingType: SHARING_NONE];
            let applied: usize = msg_send![window, sharingType];
            if applied != SHARING_NONE {
                let _: () = msg_send![window, setSharingType: original];
                return Err(format!("sharingType read back as {applied}"));
            }
            Ok(original as u64)
        }
    }

    pub(super) fn restore(app: &AppHandle, label: &str, original: u64) {
        if let Ok(window) = ns_window(app, label) {
            // SAFETY: as in `exclude`.
            unsafe {
                let _: () = msg_send![&*window, setSharingType: original as usize];
            }
        }
    }

    pub(super) fn flush() {}
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    use super::*;

    /// X11 and Wayland have no per-window capture exclusion; Linux hides.
    pub(super) fn supported() -> Option<&'static str> {
        None
    }

    pub(super) fn exclude(_app: &AppHandle, _label: &str) -> Result<u64, String> {
        Err("capture exclusion is unavailable on Linux".into())
    }

    pub(super) fn restore(_app: &AppHandle, _label: &str, _original: u64) {}

    pub(super) fn flush() {}
}
