//! Local viewer IPC stays on blocking workers; handlers never own UI state.
use crate::viewer::{
    self, BytesData, FileStat, HtmlSession, SavedImage, TempFile, TextChunk, TextData, WriteAck,
};
use tauri::Manager;

async fn on_worker<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("permission: Viewer worker failed: {error}"))?
}

#[tauri::command]
async fn viewer_stat(path: String) -> Result<FileStat, String> {
    on_worker(move || viewer::stat(&path)).await
}

#[tauri::command]
async fn viewer_read_text(
    path: String,
    max_bytes: Option<u64>,
    encoding: Option<String>,
) -> Result<TextData, String> {
    on_worker(move || viewer::read_text(&path, max_bytes, encoding.as_deref())).await
}

#[tauri::command]
async fn viewer_read_bytes(path: String, max_bytes: Option<u64>) -> Result<BytesData, String> {
    on_worker(move || viewer::read_bytes(&path, max_bytes)).await
}

#[tauri::command]
async fn viewer_write_text(
    path: String,
    content: String,
    encoding: String,
    bom: bool,
    eol: String,
    expected_hash: String,
) -> Result<WriteAck, String> {
    on_worker(move || viewer::write_text(&path, &content, &encoding, bom, &eol, &expected_hash))
        .await
}

#[tauri::command]
async fn viewer_read_text_chunk(
    path: String,
    offset: u64,
    max_bytes: Option<u64>,
    encoding: Option<String>,
) -> Result<TextChunk, String> {
    on_worker(move || viewer::read_text_chunk(&path, offset, max_bytes, encoding.as_deref())).await
}

#[tauri::command]
async fn viewer_save_pasted_image(
    doc_path: String,
    dir: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<SavedImage, String> {
    on_worker(move || viewer::save_pasted_image(&doc_path, &dir, &file_name, &bytes)).await
}

#[tauri::command]
async fn viewer_html_open(
    webview: tauri::Webview,
    path: String,
    allow_network: bool,
    allow_scripts: Option<bool>,
    proxy_mode: Option<String>,
    custom_proxy: Option<crate::proxy::AppProxyConfig>,
) -> Result<HtmlSession, String> {
    let owner = webview.label().to_string();
    let app = webview.app_handle().clone();
    on_worker(move || {
        let proxy = if allow_network {
            viewer::resolve_html_proxy(
                &app.state::<crate::state::AppState>(),
                proxy_mode.as_deref().unwrap_or("app"),
                custom_proxy,
            )
            .map_err(|error| format!("permission: {error}"))?
        } else {
            None
        };
        viewer::open_html(
            &path,
            allow_network,
            allow_scripts.unwrap_or(true),
            &owner,
            proxy.as_ref(),
        )
    })
    .await
}

#[tauri::command]
async fn viewer_html_close(webview: tauri::Webview, token: String) -> Result<(), String> {
    let owner = webview.label().to_string();
    on_worker(move || viewer::close_html(&token, &owner)).await
}

#[tauri::command]
async fn viewer_create_temp(file_name: String, bytes: Vec<u8>) -> Result<TempFile, String> {
    on_worker(move || viewer::create_temp(&file_name, &bytes)).await
}

#[tauri::command]
async fn viewer_release_temp(path: String) -> Result<(), String> {
    on_worker(move || viewer::release_temp(&path)).await
}

#[tauri::command]
async fn viewer_temp_allocate(file_name: String) -> Result<TempFile, String> {
    on_worker(move || viewer::allocate_temp(&file_name)).await
}

#[tauri::command]
async fn viewer_temp_release(token: String) -> Result<(), String> {
    on_worker(move || viewer::release_temp_token(&token)).await
}

pub(super) fn handles(command: &str) -> bool {
    matches!(
        command,
        "viewer_stat"
            | "viewer_read_text"
            | "viewer_read_bytes"
            | "viewer_write_text"
            | "viewer_read_text_chunk"
            | "viewer_save_pasted_image"
            | "viewer_html_open"
            | "viewer_html_close"
            | "viewer_create_temp"
            | "viewer_release_temp"
            | "viewer_temp_allocate"
            | "viewer_temp_release"
    )
}

pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::commands::viewer::viewer_stat,
        crate::commands::viewer::viewer_read_text,
        crate::commands::viewer::viewer_read_bytes,
        crate::commands::viewer::viewer_write_text,
        crate::commands::viewer::viewer_read_text_chunk,
        crate::commands::viewer::viewer_save_pasted_image,
        crate::commands::viewer::viewer_html_open,
        crate::commands::viewer::viewer_html_close,
        crate::commands::viewer::viewer_create_temp,
        crate::commands::viewer::viewer_release_temp,
        crate::commands::viewer::viewer_temp_allocate,
        crate::commands::viewer::viewer_temp_release,
    ];
    handler(invoke)
}
