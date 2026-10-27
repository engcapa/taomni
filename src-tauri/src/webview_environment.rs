//! One WebView environment per isolated QA application. WebView2 rejects a
//! second view with different browser arguments for an existing profile.
use tauri::{AppHandle, WebviewWindowBuilder};

pub(crate) fn configure<'a>(
    app: &AppHandle,
    mut builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    if cfg!(debug_assertions)
        && app.config().identifier == crate::QA_APP_ID
        && std::env::var_os("NEWMOB_DATA_DIR").is_some()
    {
        if let Ok(data_dir) = crate::resolved_app_data_dir(app) {
            let directory = data_dir.join("webview");
            let _ = std::fs::create_dir_all(&directory);
            builder = builder.data_directory(directory);
        }
        #[cfg(target_os = "windows")]
        if let Ok(arguments) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            if !arguments.trim().is_empty() {
                builder = builder.additional_browser_args(&arguments);
            }
        }
        #[cfg(target_os = "macos")]
        if std::env::var("TAOMNI_QA_WEBDRIVER_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .is_some_and(|port| port != 0)
        {
            // The real ARD fixture switches the console to its disposable
            // account. Keep this opt-in QA view's JS bridge responsive while
            // it is in the runner's background login session. Production and
            // manual QA launches retain the default scheduling policy.
            builder = builder
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
        }
    }
    builder
}
