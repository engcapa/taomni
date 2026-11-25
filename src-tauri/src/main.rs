// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod windows_update_relaunch;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    let maintenance = match first.as_deref().and_then(std::ffi::OsStr::to_str) {
        Some(taomni_lib::MAIL_MAINTENANCE_ARG) => Some(taomni_lib::run_mail_maintenance(args)),
        Some(taomni_lib::MFA_MAINTENANCE_ARG) => Some(taomni_lib::run_mfa_maintenance(args)),
        Some(taomni_lib::MFA_RESTART_HELPER_ARG) => Some(taomni_lib::run_mfa_restart_helper(args)),
        _ => None,
    };
    if let Some(result) = maintenance {
        if let Err(error) = result {
            eprintln!("Module maintenance failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--headless") {
        std::process::exit(taomni_lib::mobile::headless::run());
    }
    if std::env::args().nth(1).as_deref() == Some("--ssh-stdio-forward") {
        std::process::exit(taomni_lib::terminal::openssh::stdio_forward());
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--screenshot-scroll-input") {
        std::process::exit(taomni_lib::run_screenshot_scroll_input());
    }
    #[cfg(windows)]
    if windows_update_relaunch::handoff_to_desktop() {
        return;
    }
    taomni_lib::run();
}
