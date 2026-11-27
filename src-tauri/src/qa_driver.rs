//! WebDriver bridge for the isolated QA application.
//!
//! macOS runs use this bridge for WKWebView. Restore tests also use it to
//! attach to a Linux or Windows WebView after the application restarts itself.

mod model;

mod response;

mod evaluation;

mod session;
mod windows;

mod elements;

mod actions;
#[cfg(target_os = "macos")]
mod appkit_drag;
#[cfg(target_os = "macos")]
mod appkit_tab;
#[cfg(any(target_os = "macos", test))]
mod tab_navigation;

mod capture;

mod about;
mod application_menu;

mod server;

use tauri::{AppHandle, WebviewWindowBuilder, Wry};

pub(crate) fn configure<'a>(
    app: &AppHandle,
    builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let port = std::env::var("TAOMNI_QA_WEBDRIVER_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port != 0);
    let isolated = ["NEWMOB_DATA_DIR", "NEWMOB_CONFIG_DIR", "NEWMOB_CACHE_DIR"]
        .into_iter()
        .all(|name| {
            std::env::var(name)
                .ok()
                .and_then(|path| crate::qa_override_path(&path))
                .is_some()
        });
    let Some(port) = port.filter(|_| app.config().identifier == crate::QA_APP_ID && isolated)
    else {
        return builder;
    };
    let owner = app.clone();
    builder.on_page_load(move |window, payload| {
        // The in-process bridge must be able to evaluate the initial document
        // before the runner attaches. Subsequent page loads reuse its listener.
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            server::start(owner.clone(), window, port);
        }
    })
}
