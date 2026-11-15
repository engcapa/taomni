use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri::http::{Method, Request, Response, StatusCode};
use url::Url;

pub const SCHEME: &str = "taomni-plugin";

/// Register the restricted plugin frontend scheme. Only files below
/// `<app-data>/plugins/<slug>/frontend` are served, and every request is GET.
pub(crate) fn register_protocol<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |context, request, responder| {
        let app = context.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            responder.respond(serve(&app, request));
        });
    })
}

fn serve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return response(
            StatusCode::METHOD_NOT_ALLOWED,
            b"GET only".to_vec(),
            "text/plain",
        );
    }
    let Ok(url) = Url::parse(&request.uri().to_string()) else {
        return response(
            StatusCode::BAD_REQUEST,
            b"invalid plugin URL".to_vec(),
            "text/plain",
        );
    };
    let Some(slug) = url.host_str().filter(|value| valid_slug(value)) else {
        return response(
            StatusCode::FORBIDDEN,
            b"invalid plugin slug".to_vec(),
            "text/plain",
        );
    };
    let segments = url
        .path_segments()
        .map(|parts| parts.collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.is_empty() || segments.iter().any(|part| *part == ".." || part.is_empty()) {
        return response(
            StatusCode::FORBIDDEN,
            b"invalid plugin path".to_vec(),
            "text/plain",
        );
    }
    let Ok(app_data) = app.path().app_data_dir() else {
        return response(
            StatusCode::INTERNAL_SERVER_ERROR,
            b"app data unavailable".to_vec(),
            "text/plain",
        );
    };
    let frontend_root = app_data.join("plugins").join(slug).join("frontend");
    let relative = segments.iter().fold(PathBuf::new(), |mut path, segment| {
        path.push(segment);
        path
    });
    let path = frontend_root.join(relative);
    let Ok(canonical) = path.canonicalize() else {
        return response(
            StatusCode::NOT_FOUND,
            b"plugin asset not found".to_vec(),
            "text/plain",
        );
    };
    let Ok(root) = frontend_root.canonicalize() else {
        return response(
            StatusCode::NOT_FOUND,
            b"plugin asset not found".to_vec(),
            "text/plain",
        );
    };
    if !canonical.starts_with(&root)
        || !canonical.is_file()
        || has_symlink_component(&frontend_root, &canonical)
    {
        return response(
            StatusCode::FORBIDDEN,
            b"plugin asset denied".to_vec(),
            "text/plain",
        );
    }
    let Ok(bytes) = std::fs::read(&canonical) else {
        return response(
            StatusCode::INTERNAL_SERVER_ERROR,
            b"plugin asset read failed".to_vec(),
            "text/plain",
        );
    };
    response(StatusCode::OK, bytes, mime(&canonical))
}

fn has_symlink_component(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if std::fs::symlink_metadata(&current)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(true)
        {
            return true;
        }
    }
    false
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        })
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn response(status: StatusCode, body: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .body(body)
        .expect("valid plugin protocol response")
}
