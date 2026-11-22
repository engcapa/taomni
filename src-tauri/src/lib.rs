pub mod agent;
pub mod ai;
mod app_exit;
mod appearance;
mod asr;
mod atomic_replace;
pub mod backup;
pub(crate) mod capture;
mod chat;
mod commands;
mod config;
mod dap;
mod database;
mod deepseek_app;
mod dependency_index;
mod filebrowser;
mod git;
mod hbase;
mod history;
mod history_privacy;
mod java_bundles;
mod java_debug_adapter;
mod java_test;
pub mod llm;
mod local_history;
mod lsp;
mod mail;
mod mfa;
mod migrate;
pub mod models;
mod module_lock;
mod nettools;
mod notepad;
mod notes;
mod objectstorage;
pub mod perf;
pub mod plugin;
mod proxy;
mod qa_driver;
mod qa_logging;
mod rdp;
mod runtime;
mod screenshot;
#[cfg(windows)]
pub use screenshot::scroll_input::run_helper as run_screenshot_scroll_input;
pub mod mobile;
mod sdk;
mod serial;
mod servers;
pub mod session;
pub mod sockscap;
mod state;
mod structural_search;
mod tab;
pub mod terminal;
mod test_results;
mod tunnel;
mod update;
pub mod vault;
mod viewer;
mod vnc;
mod voice;
mod webview_environment;
mod webview_recovery;
mod windowing;
mod workspace;
mod workspace_execution;
mod workspace_fs;
mod workspace_search;
pub mod workspace_tooling;
mod wsl;

use state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State, WebviewWindowBuilder};

pub(crate) const QA_APP_ID: &str = "com.taomni.app.qa";
static QA_PROFILE_ACTIVE: AtomicBool = AtomicBool::new(false);

#[doc(hidden)]
pub use runtime::mail_maintenance::{MAIL_MAINTENANCE_ARG, run_mail_maintenance};
#[doc(hidden)]
pub use runtime::mfa_maintenance::{MFA_MAINTENANCE_ARG, run_mfa_maintenance};
#[doc(hidden)]
pub use runtime::mfa_restart::{MFA_RESTART_HELPER_ARG, run_mfa_restart_helper};

fn is_qa_identifier(identifier: &str) -> bool {
    identifier == QA_APP_ID
}

fn activate_qa_profile(identifier: &str) {
    if is_qa_identifier(identifier) {
        QA_PROFILE_ACTIVE.store(true, Ordering::Release);
    }
}

fn qa_profile_active() -> bool {
    QA_PROFILE_ACTIVE.load(Ordering::Acquire)
}

fn qa_override_path(raw: &str) -> Option<std::path::PathBuf> {
    let path = std::path::PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return None;
    }
    if path.ends_with(QA_APP_ID) {
        Some(path)
    } else {
        Some(path.join(QA_APP_ID))
    }
}

/// Resolve the app data root, honoring the explicit QA override used by
/// native tests. Windows' `dirs::data_dir()` uses the Known Folder API and
/// ignores `APPDATA`, so the explicit override is required for isolation.
pub fn resolved_app_data_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    activate_qa_profile(&app.config().identifier);
    if qa_profile_active() {
        if let Ok(raw) = std::env::var("NEWMOB_DATA_DIR") {
            if let Some(path) = qa_override_path(&raw) {
                return Ok(path);
            }
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))
}

/// Resolve named user roots while keeping the QA run inside its own report
/// directory on macOS.  `dirs` does not honor XDG variables there, so native
/// QA supplies explicit identifier-gated overrides instead of changing HOME.
pub fn resolved_config_dir() -> Option<std::path::PathBuf> {
    if let Some(root) = runtime::paths::config_root() {
        return Some(root);
    }
    if qa_profile_active() {
        if let Ok(raw) = std::env::var("NEWMOB_CONFIG_DIR") {
            if let Some(path) = qa_override_path(&raw) {
                return Some(path);
            }
        }
    }
    dirs::config_dir()
}

pub fn resolved_cache_dir() -> Option<std::path::PathBuf> {
    if qa_profile_active() {
        if let Ok(raw) = std::env::var("NEWMOB_CACHE_DIR") {
            if let Some(path) = qa_override_path(&raw) {
                return Some(path);
            }
        }
    }
    dirs::cache_dir()
}

#[tauri::command]
async fn exit_app(app_handle: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state;
    runtime::shutdown::request(app_handle, runtime::shutdown::ExitAction::Quit).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    screenshot::shortcut::prepare_portal_identity(&context.config().identifier);
    let builder =
        plugin::protocol::register_protocol(viewer::register_protocol(tauri::Builder::default()));
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        webview_recovery::terminated(webview.app_handle(), webview.label(), "renderer-exited");
    });
    builder
        .manage(app_exit::ExitGate::default())
        .manage(webview_recovery::Recovery::default())
        // Auto-update: unconditional (unlike the debug-only log plugin below).
        // `process` provides relaunch() so the user can restart into the new
        // version after install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Set the process-wide gate before any config/cache-backed service
            // is initialized. Production identifiers never activate it, so a
            // stray NEWMOB_* environment cannot redirect a normal install.
            activate_qa_profile(&app.config().identifier);
            let boot = match runtime::bootstrap::desktop(app.handle()) {
                Err(error @ runtime::profile::ProfileStartupError::ModeInUse) => {
                    eprintln!("Taomni: {error}");
                    app.state::<app_exit::ExitGate>().allow_platform_exit();
                    app.handle().exit(1);
                    return Ok(());
                }
                result => result.map_err(std::io::Error::other)?,
            };
            screenshot::init(app.handle());
            app.manage(boot.state);
            app.manage(boot.runtime);
            runtime::desktop::attach(app.handle()).map_err(std::io::Error::other)?;

            if cfg!(debug_assertions) || qa_profile_active() {
                let mut logger = tauri_plugin_log::Builder::default().level(log::LevelFilter::Info);
                let qa_data = std::env::var_os("NEWMOB_DATA_DIR").map(std::path::PathBuf::from);
                if let Some(path) =
                    qa_logging::directory(&app.config().identifier, qa_data.as_deref())
                {
                    logger = logger.targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                            path,
                            file_name: None,
                        }),
                    ]);
                }
                if app.config().identifier == "com.taomni.app.qa"
                    && std::env::var("TAOMNI_QA_RDP_TRACE").as_deref() == Ok("1")
                {
                    #[cfg(all(debug_assertions, feature = "legacy-rdp-client"))]
                    if let Err(error) = rdp::qa_graphics_capture::enable(&app.path().app_log_dir()?)
                    {
                        eprintln!("QA RDP packet capture unavailable: {error}");
                    }
                    logger = logger
                        .level_for("taomni_rdp_client_engine::session", log::LevelFilter::Debug)
                        .level_for("ironrdp_session::fast_path", log::LevelFilter::Trace)
                        .level_for("ironrdp_session::rfx", log::LevelFilter::Trace)
                        .level_for("ironrdp_session::image", log::LevelFilter::Debug)
                        .level_for("ironrdp_session::x224", log::LevelFilter::Debug);
                }
                app.handle().plugin(logger.build())?;
            }

            if let Some(main_window_config) = app.config().app.windows.first().cloned() {
                let builder = WebviewWindowBuilder::from_config(app.handle(), &main_window_config)?
                    // Required on Linux/Windows for navigator.clipboard.readText().
                    // Terminal right-click paste and Shift+Insert use that API.
                    .enable_clipboard_access();
                let builder = webview_environment::configure(app.handle(), builder);
                // On macOS use the native traffic-light controls with an overlay
                // title bar so the window feels native (the frontend reserves a
                // left inset and hides its custom min/max/close there). Windows
                // and Linux keep the borderless custom chrome from tauri.conf.json
                // (decorations = false).
                #[cfg(target_os = "macos")]
                let builder = builder
                    .decorations(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
                let builder = qa_driver::configure(app.handle(), builder);
                let main_window = builder.build()?;
                webview_recovery::install(&main_window);
                screenshot::prewarm(app.handle());
            }
            runtime::desktop::start(app.handle());
            Ok(())
        })
        .invoke_handler(commands::handle)
        .build(context)
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { code, ref api, .. } = event {
                runtime::shutdown::handle_exit_requested(app_handle, code, api);
            }
            if let tauri::RunEvent::Exit = event {
                runtime::shutdown::final_exit(app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qa_override_requires_the_exact_isolated_application_identifier() {
        assert!(is_qa_identifier(QA_APP_ID));
        assert!(!is_qa_identifier("com.taomni.app"));
        assert!(!is_qa_identifier("com.taomni.app.qa-other"));
    }

    #[test]
    fn qa_override_path_appends_the_profile_identifier_once() {
        let root = if cfg!(windows) {
            std::path::PathBuf::from(r"C:\qa\run")
        } else {
            std::path::PathBuf::from("/qa/run")
        };
        let root_text = root.to_string_lossy();
        assert_eq!(qa_override_path(&root_text), Some(root.join(QA_APP_ID)));
        assert_eq!(
            qa_override_path(&root.join(QA_APP_ID).to_string_lossy()),
            Some(root.join(QA_APP_ID))
        );
        assert_eq!(qa_override_path("relative"), None);
    }
}
