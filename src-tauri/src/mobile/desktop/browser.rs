use crate::mobile::Core;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::Manager;

pub const REMOTE_BROWSER_LABEL: &str = "mobile-remote-browser";
const MAX_BROWSER_URL_LEN: usize = 2048;

#[derive(Clone, Debug, Deserialize)]
pub struct BrowserOpenRequest {
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BrowserOpenResult {
    pub ok: bool,
    pub url: String,
    pub window_id: String,
    pub title: String,
}

/// Validates and normalizes a URL entered remotely before opening it on the server desktop.
pub fn normalize_browser_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_BROWSER_URL_LEN
        || trimmed.chars().any(char::is_whitespace)
    {
        return Err("invalid_browser_url".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    let candidate = if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_owned()
    } else if trimmed.contains("://")
        || matches!(
            lower.split(':').next(),
            Some("javascript" | "data" | "file" | "about" | "blob" | "tauri" | "mailto" | "tel")
        )
    {
        return Err("invalid_browser_url".into());
    } else if lower.starts_with("localhost")
        || lower.starts_with("127.")
        || lower.starts_with("[::1]")
        || lower.starts_with("0.0.0.0")
    {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&candidate).map_err(|_| "invalid_browser_url".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("invalid_browser_url".into());
    }
    Ok(parsed)
}

/// Opens or navigates the managed server-side browser window so desktop screen capture
/// (and Mobile Web / Feishu viewers when screen capture is enabled) can display it.
pub async fn open_browser(core: &Core, raw_url: &str) -> Result<BrowserOpenResult, String> {
    let parsed = normalize_browser_url(raw_url)?;
    #[cfg(test)]
    if let Some(driver) = core.state().mobile.desktop.test_driver() {
        return driver.open_browser(&parsed);
    }
    let Core::Desktop(app) = core else {
        return Err("desktop_required".into());
    };
    let desktop = core.state().mobile.desktop.browser_load_seq.clone();
    let prev_seq = desktop.load(Ordering::SeqCst);
    let title = format!("Taomni Browser - {parsed}");
    let result_url = parsed.to_string();

    if let Some(existing) = app.get_webview_window(REMOTE_BROWSER_LABEL) {
        existing.navigate(parsed).map_err(|error| {
            log::warn!("failed to navigate mobile remote browser: {error}");
            "desktop_browser_open_failed".to_string()
        })?;
        let _ = existing.set_title(&title);
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
    } else {
        let app_for_load = app.clone();
        let builder = crate::webview_environment::configure(
            app,
            tauri::WebviewWindowBuilder::new(
                app,
                REMOTE_BROWSER_LABEL,
                tauri::WebviewUrl::External(parsed),
            ),
        )
        .title(&title)
        .inner_size(1120.0, 760.0)
        .resizable(true)
        .visible(true)
        .focused(true)
        .on_navigation(|target| matches!(target.scheme(), "http" | "https"))
        .on_page_load(move |_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                app_for_load
                    .state::<crate::AppState>()
                    .mobile
                    .desktop
                    .mark_browser_loaded();
            }
        });
        #[cfg(not(target_os = "linux"))]
        let builder = builder.center();
        builder.build().map_err(|error| {
            log::warn!("failed to open mobile remote browser window: {error}");
            "desktop_browser_open_failed".to_string()
        })?;
    }

    core.state()
        .mobile
        .desktop
        .wait_browser_loaded(prev_seq, std::time::Duration::from_millis(1200))
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    Ok(BrowserOpenResult {
        ok: true,
        url: result_url,
        window_id: format!("tauri:{REMOTE_BROWSER_LABEL}"),
        title,
    })
}
