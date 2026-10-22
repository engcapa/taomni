pub mod agent;
pub mod ai;
mod app_exit;
mod appearance;
mod asr;
pub mod backup;
mod chat;
mod commands;
mod config;
mod dap;
mod database;
mod dependency_index;
mod filebrowser;
mod git;
mod hbase;
mod history;
mod java_bundles;
mod java_debug_adapter;
mod java_test;
mod lanchat;
pub mod llm;
mod local_history;
mod lsp;
mod mail;
mod mfa;
mod migrate;
pub mod models;
mod module_lock;
mod nettools;
mod notes;
mod objectstorage;
pub mod perf;
mod proxy;
mod qa_driver;
mod rdp;
mod screenshot;
#[cfg(windows)]
pub use screenshot::scroll_input::run_helper as run_screenshot_scroll_input;
mod sdk;
mod serial;
mod servers;
pub mod session;
pub mod sockscap;
mod state;
mod tab;
pub mod terminal;
mod test_results;
mod tunnel;
mod update;
pub mod vault;
mod vnc;
/// The VNC special-key hook helper process (`taomni --vnc-special-key-hook <pid>`).
#[cfg(windows)]
pub use vnc::keyboard_hook::{
    HOOK_PROCESS_ARG as VNC_SPECIAL_KEY_HOOK_ARG, run_hook_process as run_vnc_special_key_hook,
};
mod structural_search;
mod voice;
mod webview_recovery;
mod windowing;
mod workspace;
mod workspace_execution;
mod workspace_fs;
mod workspace_search;
pub mod workspace_tooling;
mod wsl;

use state::AppState;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewWindowBuilder};

const AI_PROCESS_REAPER_INTERVAL_SECS: u64 = 30;
const AI_PROCESS_IDLE_REAP_SECS: u64 = 300;
pub(crate) const QA_APP_ID: &str = "com.taomni.app.qa";

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

/// Resolve the app data root, honoring the debug-only QA override used by
/// native tests. Windows' `dirs::data_dir()` uses the Known Folder API and
/// ignores `APPDATA`, so the explicit override is required for isolation.
pub fn resolved_app_data_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) {
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
/// QA supplies explicit debug-only overrides instead of changing HOME.
pub fn resolved_config_dir() -> Option<std::path::PathBuf> {
    if cfg!(debug_assertions) {
        if let Ok(raw) = std::env::var("NEWMOB_CONFIG_DIR") {
            if let Some(path) = qa_override_path(&raw) {
                return Some(path);
            }
        }
    }
    dirs::config_dir()
}

pub fn resolved_cache_dir() -> Option<std::path::PathBuf> {
    if cfg!(debug_assertions) {
        if let Ok(raw) = std::env::var("NEWMOB_CACHE_DIR") {
            if let Some(path) = qa_override_path(&raw) {
                return Some(path);
            }
        }
    }
    dirs::cache_dir()
}

fn should_reap_ai_process(
    chat_turn_active: bool,
    process_turn_active: bool,
    idle_secs: u64,
) -> bool {
    !chat_turn_active && !process_turn_active && idle_secs >= AI_PROCESS_IDLE_REAP_SECS
}

#[tauri::command]
async fn exit_app(app_handle: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    app_handle
        .state::<app_exit::ExitGate>()
        .run(
            async {
                sockscap::prepare_for_exit(&app_handle, state).await?;
                screenshot::wait_for_recovery_recording().await
            },
            || {
                webview_recovery::closing_all(&app_handle);
                app_handle.exit(0);
            },
        )
        .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    screenshot::shortcut::prepare_portal_identity(&context.config().identifier);
    let builder = tauri::Builder::default();
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
            screenshot::init(app.handle());
            let app_data = resolved_app_data_dir(app.handle())
                .expect("failed to resolve app data dir");

            // One-time migration from the legacy Taomni identity (see migrate.rs).
            // Runs before the app-data dir is created so the directory rename
            // targets a non-existent destination on every platform.
            migrate::run(&app_data);
            app.manage(backup::coordination::ProfileLease::prepare(&app_data)
                .map_err(std::io::Error::other)?);

            std::fs::create_dir_all(&app_data).ok();

            let db_path = app_data.join("taomni.db");
            let conn = rusqlite::Connection::open(&db_path).expect("failed to open database");
            session::db::init_db(&conn).expect("failed to init database");
            terminal::local_directories::init_tables(&conn)
                .expect("failed to init local directory tables");
            servers::db::init_server_tables(&conn).expect("init server tables");
            rdp::tls::init_trust_table(&conn).expect("init RDP certificate trust table");
            let mail_db_dir = app_data.join("mail-cache");
            std::fs::create_dir_all(&mail_db_dir).expect("failed to create mail cache directory");

            // Tao Notes lives in its own SQLite file (notes.db), deliberately
            // separate from taomni.db so its data model / backup / encryption can
            // evolve independently (see tao-notes-feature-plan.md).
            let notes_db_path = app_data.join("notes.db");
            let notes_conn =
                rusqlite::Connection::open(&notes_db_path).expect("failed to open notes database");
            notes::init_db(&notes_conn).expect("failed to init notes database");

            // The MFA authenticator keeps its own mfa.db, opened lazily on first
            // use so a damaged file cannot block startup (see mfa/store.rs).
            let mfa_store = Arc::new(mfa::store::MfaStore::new(app_data.join("mfa.db")));

            let vault_path = vault::default_vault_path(app.handle());
            let v = vault::Vault::open(&vault_path).expect("failed to open vault");
            let vault_arc = Arc::new(v);

            // Load AI config and build the AppAiCtx (AsrManager + LlmRouter).
            // Vault is passed so api_key fields stored as `vault:<id>` get
            // transparently resolved by the LLM router.
            let ai_config_path = ai::config::default_ai_config_path();
            let ai_config = ai::config::AiConfig::load(&ai_config_path);
            let ai_ctx =
                ai::AppAiCtx::from_config_with_proxy_db(ai_config, vault_arc.clone(), Some(&conn));

            // Decentralized LAN messenger state (separate lanchat.sqlite).
            let lanchat_state = Arc::new(lanchat::LanChatState::new(&app_data));

            app.manage(AppState::new(
                conn,
                notes_conn,
                mfa_store,
                mail_db_dir,
                vault_arc,
                ai_ctx,
                lanchat_state,
            ));
            let go_catalog = app.state::<AppState>().opencode_go_catalog.clone();
            tauri::async_runtime::spawn(async move { go_catalog.refresh(true).await; });
            app.state::<AppState>()
                .workspace.lsp
                .attach_app(app.handle().clone());
            app.manage(workspace_search::WorkspaceSearchState::default());
            app.manage(structural_search::StructuralSearchState::default());
            let local_history = local_history::init_local_history(app.handle())
                .expect("failed to init local history store");
            app.manage(local_history);

            backup::jobs::initialize(app.handle());
            backup::qa::initialize(app.handle()).map_err(std::io::Error::other)?;
            backup::scheduler::start(app.handle());

            let handle_for_reaper = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(
                        AI_PROCESS_REAPER_INTERVAL_SECS,
                    ))
                    .await;
                    let state = handle_for_reaper.state::<AppState>();
                    let active_chat_threads: HashSet<String> =
                        state.agent.chat_runs.lock().await.keys().cloned().collect();
                    let mut registry = state.agent.cc_processes.lock().await;
                    let now = std::time::Instant::now();
                    let mut to_remove = Vec::new();
                    for (thread_id, proc) in registry.iter() {
                        let last_active = *proc.last_active_at.lock().unwrap();
                        if should_reap_ai_process(
                            active_chat_threads.contains(thread_id),
                            proc.is_turn_active(),
                            now.duration_since(last_active).as_secs(),
                        ) {
                            to_remove.push(thread_id.clone());
                        }
                    }
                    for tid in to_remove {
                        if let Some(proc) = registry.remove(&tid) {
                            tokio::spawn(async move {
                                proc.stop().await;
                            });
                        }
                    }
                    drop(registry);

                    let mut codex_registry = state.agent.codex_processes.lock().await;
                    let mut codex_to_remove = Vec::new();
                    for (thread_id, proc) in codex_registry.iter() {
                        let last_active = *proc.last_active_at.lock().unwrap();
                        if should_reap_ai_process(
                            active_chat_threads.contains(thread_id),
                            proc.is_turn_active(),
                            now.duration_since(last_active).as_secs(),
                        ) {
                            codex_to_remove.push(thread_id.clone());
                        }
                    }
                    for tid in codex_to_remove {
                        if let Some(proc) = codex_registry.remove(&tid) {
                            tokio::spawn(async move {
                                proc.stop().await;
                            });
                        }
                    }
                    drop(codex_registry);

                    let mut acp_registry = state.agent.acp_processes.lock().await;
                    let mut acp_to_remove = Vec::new();
                    for (thread_id, proc) in acp_registry.iter() {
                        if should_reap_ai_process(
                            active_chat_threads.contains(thread_id),
                            proc.is_turn_active(),
                            now.saturating_duration_since(proc.last_active_at())
                                .as_secs(),
                        ) {
                            acp_to_remove.push(thread_id.clone());
                        }
                    }
                    for tid in acp_to_remove {
                        if let Some(proc) = acp_registry.remove(&tid) {
                            tokio::spawn(async move {
                                proc.stop().await;
                            });
                        }
                    }
                }
            });

            // Start the LanChat background service only if the user opted into
            // "start on launch". Otherwise it stays dark (no mDNS/beacon/listen)
            // until the user opens the chat and confirms enabling it. The state
            // (DB/identity/TLS) is always constructed above so the service can
            // be started on demand later.
            let app_for_lanchat = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let lanchat = app_for_lanchat
                    .state::<AppState>()
                    .lanchat
                    .clone();
                let start_on_launch = lanchat
                    .store
                    .get_start_on_launch()
                    .unwrap_or(false);
                if start_on_launch {
                    if let Err(error) = lanchat::start_service(app_for_lanchat).await {
                        log::warn!("lanchat: autostart skipped: {error}");
                    }
                } else {
                    log::info!("lanchat: start_on_launch disabled; service idle until enabled");
                }
            });

            // Auto-start any tunnels with autostart=true.
            let app_for_autostart = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tunnel::autostart_tunnels(app_for_autostart).await;
            });

            // SocksCap: repair residual OS capture state from a previous unclean
            // exit. Needs app state: orphaned elevated helpers can only be
            // terminated by another elevated process, so their pids are queued
            // there for the next (UAC-elevated) helper launch to reap.
            let app_for_sockscap = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_for_sockscap.state::<AppState>();
                sockscap::boot_repair(&app_for_sockscap, &state).await;
            });

            // SocksCap: resolve the bundled xray-core binary and install the
            // sidecar manager (used by core-backed upstreams: ss/trojan/vmess/
            // vless/wireguard). Non-fatal if the binary is absent.
            {
                let state = app.state::<AppState>();
                sockscap::init_xray_manager(app.handle(), &state);
            }

            // Auto-start any local servers with startOnLaunch=true.
            let app_for_servers = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                servers::autostart_servers(app_for_servers).await;
            });

            if cfg!(debug_assertions) {
                let mut logger = tauri_plugin_log::Builder::default().level(log::LevelFilter::Info);
                if app.config().identifier == "com.taomni.app.qa"
                    && std::env::var("TAOMNI_QA_RDP_TRACE").as_deref() == Ok("1")
                {
                    #[cfg(debug_assertions)]
                    if let Err(error) = rdp::qa_graphics_capture::enable(&app.path().app_log_dir()?) {
                        eprintln!("QA RDP packet capture unavailable: {error}");
                    }
                    logger = logger
                        .level_for("taomni_lib::rdp::session", log::LevelFilter::Debug)
                        .level_for("ironrdp_session::fast_path", log::LevelFilter::Trace)
                        .level_for("ironrdp_session::rfx", log::LevelFilter::Trace)
                        .level_for("ironrdp_session::image", log::LevelFilter::Debug)
                        .level_for("ironrdp_session::x224", log::LevelFilter::Debug);
                }
                app.handle().plugin(logger.build())?;
            }

            if let Some(main_window_config) = app.config().app.windows.first().cloned() {
                #[allow(unused_mut)]
                let mut builder = WebviewWindowBuilder::from_config(app.handle(), &main_window_config)?
                    // Required on Linux/Windows for navigator.clipboard.readText().
                    // Terminal right-click paste and Shift+Insert use that API.
                    .enable_clipboard_access();
                if cfg!(debug_assertions) {
                    if let Ok(raw) = std::env::var("NEWMOB_DATA_DIR") {
                        if let Some(data_dir) = qa_override_path(&raw) {
                            let webview_dir = data_dir.join("webview");
                            std::fs::create_dir_all(&webview_dir).ok();
                            builder = builder.data_directory(webview_dir);
                        }
                    }
                }
                #[cfg(target_os = "windows")]
                if cfg!(debug_assertions) && std::env::var_os("NEWMOB_DATA_DIR").is_some() {
                    // EdgeDriver launches the QA executable with the remote
                    // debugging arguments in this environment variable. Wry
                    // also supplies explicit default arguments, which take
                    // precedence over the WebView2 environment variable. Pass
                    // the driver value explicitly so DevToolsActivePort is
                    // created in the isolated data directory watched by it.
                    if let Ok(arguments) =
                        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
                    {
                        if !arguments.trim().is_empty() {
                            builder = builder.additional_browser_args(&arguments);
                        }
                    }
                }
                // On macOS use the native traffic-light controls with an overlay
                // title bar so the window feels native (the frontend reserves a
                // left inset and hides its custom min/max/close there). Windows
                // and Linux keep the borderless custom chrome from tauri.conf.json
                // (decorations = false).
                #[cfg(target_os = "macos")]
                {
                    builder = builder
                        .decorations(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true);

                    // A WebView accepts the bridge's TCP connection before
                    // its document can service `eval_with_callback`.  Delay
                    // exposing the QA endpoint until the initial page has
                    // finished loading; subsequent reloads are harmless as
                    // the bridge start is idempotent within this process.
                    if let Ok(raw_port) = std::env::var("TAOMNI_QA_WEBDRIVER_PORT") {
                        if let Ok(port) = raw_port.trim().parse::<u16>() {
                            let host = std::env::var("TAOMNI_QA_WEBDRIVER_HOST")
                                .unwrap_or_else(|_| "127.0.0.1".to_string());
                            let app_handle = app.handle().clone();
                            builder = builder.on_page_load(move |window, payload| {
                                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                                    qa_driver::start(
                                        app_handle.clone(),
                                        window,
                                        host.clone(),
                                        port,
                                    );
                                }
                            });
                        } else {
                            log::warn!("qa webdriver bridge ignored invalid port {raw_port:?}");
                        }
                    }
                }
                let main_window = builder.build()?;
                webview_recovery::install(&main_window);

                // The macOS QA runner cannot use tauri-driver (there is no
                // Tauri WebDriver adapter for WKWebView).  An opt-in bridge
                // exposes the same small W3C surface from inside this exact
                // QA window.  Normal launches never set this environment
                // variable and therefore never start a local HTTP server.
                // On Linux the webview is webkit2gtk, which ships with the
                // media-stream / WebRTC settings OFF — so getUserMedia and
                // getDisplayMedia reject and LanChat calls can't be answered or
                // screen-shared (Windows/WebView2 has them on by default). Flip
                // the settings and auto-allow UserMedia permission requests for
                // the main window (where the call overlay is mounted).
                //
                // Diagnostics: keep the builder's window handle (no re-lookup),
                // surface with_webview / settings() failures via log::warn!, and
                // read the flags back after setting them so we can tell "the
                // setting never applied" apart from "this WebKitGTK build has no
                // WebRTC backend" (settings stick but RTCPeerConnection stays
                // undefined).
                #[cfg(target_os = "linux")]
                {
                    let webview_result = main_window.with_webview(|webview| {
                        use webkit2gtk::glib::object::Cast;
                        use webkit2gtk::{
                            PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
                            WebViewExt,
                        };
                        let wv = webview.inner();
                        match WebViewExt::settings(&wv) {
                            Some(settings) => {
                                settings.set_enable_media_stream(true);
                                settings.set_enable_mediasource(true);
                                settings.set_enable_webrtc(true);
                                log::info!(
                                    "lanchat: webview media settings after set — media_stream={} mediasource={} webrtc={}",
                                    settings.enables_media_stream(),
                                    settings.enables_mediasource(),
                                    settings.enables_webrtc(),
                                );
                            }
                            None => log::warn!(
                                "lanchat: WebView settings() returned None — media-stream/WebRTC left disabled"
                            ),
                        }
                        // LAN-local app: grant mic/camera/screen capture. Other
                        // permission kinds fall through to the default handler.
                        wv.connect_permission_request(|_, req| {
                            if req.downcast_ref::<UserMediaPermissionRequest>().is_some() {
                                req.allow();
                                true
                            } else {
                                false
                            }
                        });
                    });
                    if let Err(e) = webview_result {
                        log::warn!(
                            "lanchat: with_webview failed — WebRTC/media-stream not enabled: {e}"
                        );
                    }
                }
                #[cfg(not(target_os = "linux"))]
                let _ = main_window;
            }
            Ok(())
        })
        .invoke_handler(commands::handle)
        .build(context)
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { code, ref api, .. } = event {
                backup::scheduler::handle_exit_request(app_handle, code, api);
            }
            // On app exit, cleanly stop the elevated SocksCap helper (and its
            // WinDivert driver) so no elevated process/driver leaks. The
            // helper's parent-death watchdog covers crash/kill paths.
            if let tauri::RunEvent::Exit = event {
                screenshot::shutdown();
                let state = app_handle.state::<AppState>();
                sockscap::shutdown_on_exit(app_handle, &state);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_process_reaper_waits_for_completed_turn_idle_window() {
        assert!(!should_reap_ai_process(
            false,
            false,
            AI_PROCESS_IDLE_REAP_SECS - 1
        ));
        assert!(should_reap_ai_process(
            false,
            false,
            AI_PROCESS_IDLE_REAP_SECS
        ));
    }

    #[test]
    fn ai_process_reaper_skips_active_chat_or_process_turn() {
        assert!(!should_reap_ai_process(
            true,
            false,
            AI_PROCESS_IDLE_REAP_SECS
        ));
        assert!(!should_reap_ai_process(
            false,
            true,
            AI_PROCESS_IDLE_REAP_SECS
        ));
        assert!(!should_reap_ai_process(
            true,
            true,
            AI_PROCESS_IDLE_REAP_SECS
        ));
    }
}
