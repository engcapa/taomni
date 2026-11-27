//! Local viewer IPC stays on blocking workers; handlers never own UI state.
use crate::state::AppState;
use crate::viewer::{
    self, BytesData, FileStat, HtmlSession, SavedImage, TempFile, TextChunk, TextData, WriteAck,
};
use tauri::{Manager, State, Window};

async fn on_worker<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("permission: Viewer worker failed: {error}"))?
}

#[tauri::command]
async fn viewer_tiff_preview(path: String) -> Result<BytesData, String> {
    on_worker(move || viewer::tiff_preview::read(&path)).await
}

#[tauri::command]
async fn viewer_archive_list(path: String) -> Result<Vec<viewer::archive::Entry>, String> {
    on_worker(move || viewer::archive::list(&path)).await
}

#[tauri::command]
async fn viewer_archive_preview(
    path: String,
    entry: viewer::archive::Entry,
) -> Result<TempFile, String> {
    on_worker(move || viewer::archive::preview(&path, entry)).await
}

#[tauri::command]
async fn viewer_archive_extract(
    path: String,
    destination: String,
    entry: Option<viewer::archive::Entry>,
) -> Result<String, String> {
    on_worker(move || viewer::archive::extract(&path, &destination, entry)).await
}

#[tauri::command]
async fn viewer_media_open(
    path: String,
    slug: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<viewer::media_stream::MediaStream, String> {
    let registry = state.plugins.clone();
    let profile = state.core.paths.clone();
    on_worker(move || {
        let path = viewer::document_access::approved_path(
            &registry,
            &[&profile.data, &profile.config, &profile.cache],
            &path,
            &slug,
            &version,
        )?;
        viewer::media_stream::open(&viewer::display_path(&path))
    })
    .await
}

#[tauri::command]
async fn viewer_document_read(
    path: String,
    slug: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<BytesData, String> {
    let registry = state.plugins.clone();
    let profile = state.core.paths.clone();
    on_worker(move || {
        let path = viewer::document_access::approved_path(
            &registry,
            &[&profile.data, &profile.config, &profile.cache],
            &path,
            &slug,
            &version,
        )?;
        viewer::read_bytes(&viewer::display_path(&path), Some(32 * 1024 * 1024))
    })
    .await
}

#[tauri::command]
async fn viewer_document_save_copy(
    path: String,
    slug: String,
    version: String,
    bytes: Vec<u8>,
    window: Window,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let registry = state.plugins.clone();
    let profile = state.core.paths.clone();
    on_worker(move || {
        let protected = [&*profile.data, &*profile.config, &*profile.cache];
        let source =
            viewer::document_access::approved_path(&registry, &protected, &path, &slug, &version)?;
        viewer::document_copy::validate(&source, &bytes)?;
        let Some(selected) = viewer::document_copy::select_destination(&window, &source)? else {
            return Ok(None);
        };
        let source =
            viewer::document_access::approved_path(&registry, &protected, &path, &slug, &version)?;
        viewer::document_copy::write(&source, &selected, &protected, &bytes).map(Some)
    })
    .await
}

#[tauri::command]
fn viewer_media_close(token: String) {
    viewer::media_stream::close(&token);
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
            viewer::resolve_preview_proxy(
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
async fn viewer_markdown_image(
    webview: tauri::Webview,
    url: String,
    proxy_mode: String,
    custom_proxy: Option<crate::proxy::AppProxyConfig>,
    ready: tauri::ipc::Channel<String>,
) -> Result<BytesData, String> {
    let request = viewer::markdown_images::ImageRequest::new(webview.label().into())?;
    ready
        .send(request.id())
        .map_err(|_| "Cannot start the Markdown image request")?;
    let _permit = request.acquire().await?;
    let app = webview.app_handle().clone();
    let proxy = on_worker(move || {
        viewer::resolve_preview_proxy(
            &app.state::<crate::state::AppState>(),
            &proxy_mode,
            custom_proxy,
        )
    })
    .await?;
    request.read(&url, proxy.as_ref()).await
}

#[tauri::command]
fn viewer_markdown_image_cancel(webview: tauri::Webview, id: String) {
    viewer::markdown_images::cancel(webview.label(), &id);
}

#[tauri::command]
async fn viewer_drawio_renderer_url() -> Result<Option<String>, String> {
    on_worker(|| Ok(viewer::drawio_renderer_url())).await
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
            | "viewer_tiff_preview"
            | "viewer_archive_list"
            | "viewer_archive_preview"
            | "viewer_archive_extract"
            | "viewer_media_open"
            | "viewer_document_read"
            | "viewer_document_save_copy"
            | "viewer_media_close"
            | "viewer_read_text"
            | "viewer_read_bytes"
            | "viewer_write_text"
            | "viewer_read_text_chunk"
            | "viewer_save_pasted_image"
            | "viewer_html_open"
            | "viewer_html_close"
            | "viewer_markdown_image"
            | "viewer_markdown_image_cancel"
            | "viewer_drawio_renderer_url"
            | "viewer_create_temp"
            | "viewer_release_temp"
            | "viewer_temp_allocate"
            | "viewer_temp_release"
    )
}

pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::commands::viewer::viewer_stat,
        crate::commands::viewer::viewer_tiff_preview,
        crate::commands::viewer::viewer_archive_list,
        crate::commands::viewer::viewer_archive_preview,
        crate::commands::viewer::viewer_archive_extract,
        crate::commands::viewer::viewer_media_open,
        crate::commands::viewer::viewer_document_read,
        crate::commands::viewer::viewer_document_save_copy,
        crate::commands::viewer::viewer_media_close,
        crate::commands::viewer::viewer_read_text,
        crate::commands::viewer::viewer_read_bytes,
        crate::commands::viewer::viewer_write_text,
        crate::commands::viewer::viewer_read_text_chunk,
        crate::commands::viewer::viewer_save_pasted_image,
        crate::commands::viewer::viewer_html_open,
        crate::commands::viewer::viewer_html_close,
        crate::commands::viewer::viewer_markdown_image,
        crate::commands::viewer::viewer_markdown_image_cancel,
        crate::commands::viewer::viewer_drawio_renderer_url,
        crate::commands::viewer::viewer_create_temp,
        crate::commands::viewer::viewer_release_temp,
        crate::commands::viewer::viewer_temp_allocate,
        crate::commands::viewer::viewer_temp_release,
    ];
    handler(invoke)
}
