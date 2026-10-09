// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--screenshot-scroll-input") {
        std::process::exit(taomni_lib::run_screenshot_scroll_input());
    }
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some("--sockscap-redirector-bridge") {
        std::process::exit(taomni_lib::sockscap::redirector::bridge_process::run_from_cli());
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some(taomni_lib::VNC_SPECIAL_KEY_HOOK_ARG) {
        std::process::exit(taomni_lib::run_vnc_special_key_hook());
    }
    taomni_lib::run();
}
