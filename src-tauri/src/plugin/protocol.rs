//! Version-bound official plugin assets, including Tauri's WebView2 mapping.

use std::{borrow::Cow, path::Path};

use tauri::Manager;
use tauri::http::{HeaderMap, Method, Request, Response, StatusCode, Uri};

pub const SCHEME: &str = "taomni-plugin";
const APP_PATH: &str = "/__taomni_plugins__";

/// Packaged ESM remains on the renderer's own application origin. Tauri's
/// resource hook is installed on every app WebView, including detached tabs.
/// Unrelated resources retain Tauri's original body, headers and CSP.
pub(crate) fn serve_app_resource<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    mut request: Request<Vec<u8>>,
    current: &mut Response<Cow<'static, [u8]>>,
) {
    let target = match app_asset_uri(request.uri()) {
        Ok(None) => return,
        Ok(Some(target)) => target,
        Err(error) => {
            *current = response(
                StatusCode::FORBIDDEN,
                error.as_bytes().to_vec(),
                "text/plain",
                None,
            )
            .map(Cow::Owned);
            return;
        }
    };
    *request.uri_mut() = target;
    *current = serve(app, request).map(Cow::Owned);
}

fn app_asset_uri(uri: &Uri) -> Result<Option<Uri>, &'static str> {
    let path = uri.path();
    if path != APP_PATH && !path.starts_with(&format!("{APP_PATH}/")) {
        return Ok(None);
    }
    let scheme = uri.scheme_str().unwrap_or_default();
    let authority = uri
        .authority()
        .map(|value| value.as_str())
        .unwrap_or_default();
    if !((scheme == "tauri" && authority == "localhost")
        || (matches!(scheme, "http" | "https") && authority == "tauri.localhost"))
        || uri.query().is_some()
    {
        return Err("invalid application plugin origin");
    }
    let suffix = path
        .strip_prefix(APP_PATH)
        .ok_or("invalid application plugin path")?;
    let target: Uri = format!("{SCHEME}://localhost{suffix}")
        .parse()
        .map_err(|_| "invalid application plugin path")?;
    // Validate before replacing the SPA fallback; malformed reserved paths
    // must fail as resources rather than return the application HTML.
    parse_asset_uri(&target)?;
    Ok(Some(target))
}

pub(crate) fn register_protocol<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |context, request, responder| {
        let app = context.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            responder.respond(serve(&app, request));
        });
    })
}

fn serve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let dev_origin = if cfg!(debug_assertions) {
        app.config()
            .build
            .dev_url
            .as_ref()
            .map(|url| url.origin().ascii_serialization())
    } else {
        None
    };
    let origin = match cors_origin(request.headers(), dev_origin.as_deref()) {
        Ok(origin) => origin,
        Err(error) => {
            return response(
                StatusCode::FORBIDDEN,
                error.as_bytes().to_vec(),
                "text/plain",
                None,
            );
        }
    };
    if request.method() != Method::GET {
        return response(
            StatusCode::METHOD_NOT_ALLOWED,
            b"GET only".to_vec(),
            "text/plain",
            origin,
        );
    }
    let asset = match parse_asset_uri(request.uri()) {
        Ok(asset) => asset,
        Err(error) => {
            return response(
                StatusCode::FORBIDDEN,
                error.as_bytes().to_vec(),
                "text/plain",
                origin,
            );
        }
    };
    let state = app.state::<crate::state::AppState>();
    match state
        .plugins
        .frontend_asset(&asset.slug, &asset.version, &asset.relative)
    {
        Ok(bytes) => response(
            StatusCode::OK,
            bytes,
            mime(Path::new(&asset.relative)),
            origin,
        ),
        Err(error) => {
            log::warn!("plugin asset denied for {}: {error}", asset.slug);
            response(
                StatusCode::FORBIDDEN,
                b"plugin asset denied".to_vec(),
                "text/plain",
                origin,
            )
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct AssetPath {
    slug: String,
    version: String,
    relative: String,
}

fn parse_asset_uri(uri: &Uri) -> Result<AssetPath, &'static str> {
    let scheme = uri.scheme_str().unwrap_or_default();
    let authority = uri
        .authority()
        .map(|authority| authority.as_str())
        .unwrap_or_default();
    if !((scheme == SCHEME && authority == "localhost")
        || (matches!(scheme, "http" | "https") && authority == "taomni-plugin.localhost"))
        || uri.query().is_some()
    {
        return Err("invalid plugin origin");
    }
    // Parse the original HTTP URI path, before URL normalization can discard
    // literal or encoded dot segments. Decode each segment exactly once.
    let path = uri.path().strip_prefix('/').ok_or("invalid plugin path")?;
    let segments = path
        .split('/')
        .map(decode_segment)
        .collect::<Result<Vec<_>, _>>()?;
    if segments.len() < 4 || !valid_slug(&segments[0]) || segments[2] != "frontend" {
        return Err("invalid plugin asset path");
    }
    super::verify::compare_versions(&segments[1], &segments[1])
        .map_err(|_| "invalid plugin version")?;
    Ok(AssetPath {
        slug: segments[0].clone(),
        version: segments[1].clone(),
        relative: segments[2..].join("/"),
    })
}

fn decode_segment(encoded: &str) -> Result<String, &'static str> {
    let bytes = encoded.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit())
        {
            return Err("invalid plugin path encoding");
        }
    }
    let decoded = urlencoding::decode(encoded).map_err(|_| "invalid plugin path encoding")?;
    if decoded.is_empty()
        || matches!(decoded.as_ref(), "." | "..")
        || decoded.chars().any(|character| {
            character.is_control() || matches!(character, '/' | '\\' | ':' | '%' | '?' | '#')
        })
    {
        return Err("unsafe plugin path segment");
    }
    Ok(decoded.into_owned())
}

fn cors_origin<'a>(
    headers: &'a HeaderMap,
    dev_origin: Option<&str>,
) -> Result<Option<&'a str>, &'static str> {
    let origins = headers.get_all("Origin").iter().collect::<Vec<_>>();
    if origins.is_empty() {
        return Ok(None);
    }
    if origins.len() != 1 {
        return Err("invalid plugin request origin");
    }
    let origin = origins[0]
        .to_str()
        .map_err(|_| "invalid plugin request origin")?;
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || dev_origin.is_some_and(|dev| dev == origin)
    {
        Ok(Some(origin))
    } else {
        Err("plugin request origin denied")
    }
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn response(
    status: StatusCode,
    body: Vec<u8>,
    content_type: &str,
    origin: Option<&str>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Vary", "Origin");
    if let Some(origin) = origin {
        builder = builder.header("Access-Control-Allow-Origin", origin);
    }
    builder.body(body).expect("valid plugin protocol response")
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
