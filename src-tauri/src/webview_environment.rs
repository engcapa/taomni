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
    }
    builder
}
