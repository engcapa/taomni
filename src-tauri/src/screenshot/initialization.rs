use crate::screenshot::capture;
use crate::screenshot::runtime::NATIVE_WAYLAND;
use crate::screenshot::shortcut;
use std::sync::atomic::Ordering;
use tauri::AppHandle;

/// Startup: purge leftovers of earlier runs and register the hotkey.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        NATIVE_WAYLAND.store(
            gtk::gdk::Display::default().is_some_and(|d| d.type_().name() == "GdkWaylandDisplay"),
            Ordering::SeqCst,
        );
    }
    capture::purge_stale_artifacts();
    shortcut::init(app);
}
