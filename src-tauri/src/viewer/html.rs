//! Capability URL protocol. A token is bound to a pinned canonical directory
//! and creating webview, never a caller-provided filesystem URL.
use super::filesystem::{bounded_read, mime, open_regular};
use super::html_document;
use super::paths::{ScopedRoot, file_name, safe_relative};
use super::{HARD_BYTES, HARD_TEXT_BYTES};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::http::{Method, Request, Response, StatusCode};

pub(super) const SCHEME: &str = "taomni-preview";

pub(super) struct Preview {
    pub root: ScopedRoot,
    pub token: String,
    pub nonce: String,
    pub allow_network: bool,
    pub allow_scripts: bool,
    pub network: Option<super::network::Network>,
    owner: String,
}

impl Preview {
    pub fn url_root(&self) -> String {
        format!("{}/{}/", origin(), self.token)
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct HtmlSession {
    pub url: String,
    pub token: String,
}

fn origin() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://taomni-preview.localhost"
    } else {
        "taomni-preview://localhost"
    }
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Preview>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Preview>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

pub(crate) fn open_html(
    path: &str,
    allow_network: bool,
    allow_scripts: bool,
    owner: &str,
    proxy: Option<&crate::proxy::ResolvedProxy>,
) -> Result<HtmlSession, String> {
    let (path, _, metadata) = open_regular(path)?;
    if metadata.len() > HARD_TEXT_BYTES {
        return Err("too_large: HTML exceeds 20 MiB".into());
    }
    if !matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("html" | "htm")
    ) {
        return Err("binary: HTML preview requires an HTML file".into());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("permission: HTML filename is not UTF-8")?;
    file_name(name)?;
    let preview = Preview {
        root: ScopedRoot::new(path.parent().ok_or("permission: HTML path has no parent")?)?,
        token: uuid::Uuid::new_v4().simple().to_string(),
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        allow_network,
        allow_scripts,
        network: if allow_network {
            Some(super::network::Network::new(proxy)?)
        } else {
            None
        },
        owner: owner.into(),
    };
    // Reject a symlinked entry before granting a URL. Scoped access will check
    // every descendant again and never follow symlinks, even within the root.
    preview.root.open(name)?;
    let result = HtmlSession {
        url: format!("{}{}", preview.url_root(), urlencoding::encode(name)),
        token: preview.token.clone(),
    };
    let mut registry = registry().lock().unwrap_or_else(|error| error.into_inner());
    if registry.len() >= 256 {
        return Err("too_large: Too many active HTML previews".into());
    }
    registry.insert(result.token.clone(), Arc::new(preview));
    Ok(result)
}

pub(crate) fn close_html(token: &str, owner: &str) -> Result<(), String> {
    let mut registry = registry().lock().unwrap_or_else(|error| error.into_inner());
    if registry
        .get(token)
        .is_some_and(|preview| preview.owner != owner)
    {
        return Err("permission: HTML token belongs to another webview".into());
    }
    if let Some(preview) = registry.remove(token) {
        if let Some(network) = &preview.network {
            network.cancel.cancel();
        }
    }
    Ok(())
}

pub(super) fn clear() {
    for (_, preview) in registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .drain()
    {
        if let Some(network) = &preview.network {
            network.cancel.cancel();
        }
    }
}

pub(crate) fn register_protocol<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |context, request, responder| {
        let owner = context.webview_label().to_string();
        // Async networking is cancellable; local disk reads use blocking workers.
        tauri::async_runtime::spawn(async move {
            responder.respond(serve_async(request, owner).await);
        });
    })
}

pub(super) async fn serve_async(request: Request<Vec<u8>>, owner: String) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "permission: GET only");
    }
    let resolved = resolve_request(&request, &owner);
    let result = match resolved {
        Ok((preview, relative)) if relative.starts_with("_net/") => {
            if let Some(network) = &preview.network {
                network
                    .fetch(&relative[5..], &preview)
                    .await
                    .map(|(bytes, mime)| success_response(bytes, &mime, &preview))
            } else {
                Err("permission: Network is disabled for this HTML preview".into())
            }
        }
        Ok(_) => {
            return tauri::async_runtime::spawn_blocking(move || serve(&request, &owner))
                .await
                .unwrap_or_else(|_| {
                    error_response(StatusCode::FORBIDDEN, "permission: Resource worker failed")
                });
        }
        Err(error) => Err(error),
    };
    result.unwrap_or_else(|error| protocol_error(&error))
}

fn protocol_error(error: &str) -> Response<Vec<u8>> {
    let status = if error.starts_with("not_found:") {
        StatusCode::NOT_FOUND
    } else if error.starts_with("too_large:") {
        StatusCode::PAYLOAD_TOO_LARGE
    } else {
        StatusCode::FORBIDDEN
    };
    error_response(status, error)
}

pub(super) fn serve(request: &Request<Vec<u8>>, owner: &str) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "permission: GET only");
    }
    match resource(request, owner) {
        Ok(response) => response,
        Err(error) => {
            let status = if error.starts_with("not_found:") {
                StatusCode::NOT_FOUND
            } else if error.starts_with("too_large:") {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::FORBIDDEN
            };
            error_response(status, &error)
        }
    }
}

fn resolve_request(
    request: &Request<Vec<u8>>,
    owner: &str,
) -> Result<(Arc<Preview>, String), String> {
    let uri = request.uri();
    let authority = uri.authority().map(|value| value.as_str()).unwrap_or("");
    let scheme = uri.scheme_str().unwrap_or("");
    if !((scheme == SCHEME && authority == "localhost")
        || (matches!(scheme, "http" | "https") && authority == "taomni-preview.localhost"))
    {
        return Err("permission: Invalid preview origin".into());
    }
    let path = uri
        .path()
        .strip_prefix('/')
        .ok_or("permission: Invalid preview path")?;
    let (token, encoded_relative) = path
        .split_once('/')
        .ok_or("permission: Missing preview token")?;
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("permission: Invalid preview token".into());
    }
    let preview = registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(token)
        .cloned()
        .ok_or("permission: Expired preview token")?;
    if preview.owner != owner {
        return Err("permission: Preview belongs to another webview".into());
    }
    let relative = decode_relative(encoded_relative)?;
    Ok((preview, relative))
}

fn resource(request: &Request<Vec<u8>>, owner: &str) -> Result<Response<Vec<u8>>, String> {
    let (preview, relative) = resolve_request(request, owner)?;
    if relative.starts_with("_net/") {
        return Err("permission: Network resources require asynchronous transport".into());
    }
    let mut file = preview.root.open(&relative)?;
    let metadata = file
        .metadata()
        .map_err(|error| super::paths::io_error("stat resource", error))?;
    let path = preview.root.path.join(&relative);
    let mime = mime(&path, &[]);
    let html = mime == "text/html";
    let limit = if html { HARD_TEXT_BYTES } else { HARD_BYTES };
    if metadata.len() > limit {
        return Err("too_large: Preview resource exceeds size limit".into());
    }
    let bytes = bounded_read(&mut file, limit)?;
    if bytes.len() as u64 > limit {
        return Err("too_large: Preview resource grew beyond size limit".into());
    }
    let body = if html {
        html_document::document(&bytes, &preview)?
    } else if mime == "text/css" {
        let text = std::str::from_utf8(&bytes).map_err(|_| "binary: CSS must be UTF-8")?;
        super::network_rewrite::css(text, None, &preview)?.into_bytes()
    } else {
        bytes
    };
    Ok(success_response(
        body,
        if html {
            "text/html; charset=utf-8"
        } else {
            &mime
        },
        &preview,
    ))
}

fn success_response(body: Vec<u8>, mime: &str, preview: &Preview) -> Response<Vec<u8>> {
    let policy = html_document::csp(preview);
    Response::builder().status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Content-Security-Policy", policy)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=()")
        // Sandboxed fetch/module origins are opaque. Only this random token's
        // URLs are readable, with no credentials and no native IPC permission.
        .header("Access-Control-Allow-Origin", "null")
        .body(body).unwrap()
}

fn decode_relative(path: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    for part in path.split('/') {
        if part.is_empty() {
            return Err("permission: Empty resource path segment".into());
        }
        let bytes = part.as_bytes();
        for index in 0..bytes.len() {
            if bytes[index] == b'%'
                && (index + 2 >= bytes.len()
                    || !bytes[index + 1].is_ascii_hexdigit()
                    || !bytes[index + 2].is_ascii_hexdigit())
            {
                return Err("permission: Malformed resource escape".into());
            }
        }
        let decoded =
            urlencoding::decode(part).map_err(|_| "permission: Invalid resource encoding")?;
        if decoded == "." || decoded == ".." || decoded.contains(['/', '\\', ':', '\0']) {
            return Err("permission: Resource traversal is forbidden".into());
        }
        // Decode exactly once for filesystem lookup. A literal '%' is valid;
        // encoded separators/dot segments at further layers remain forbidden.
        let mut nested = decoded.to_string();
        for _ in 0..8 {
            let next = urlencoding::decode(&nested)
                .map_err(|_| "permission: Invalid nested escape")?
                .into_owned();
            if next == nested {
                break;
            }
            if next == "." || next == ".." || next.contains(['/', '\\', ':', '\0']) {
                return Err("permission: Layered resource traversal is forbidden".into());
            }
            nested = next;
        }
        safe_relative(&decoded)?;
        parts.push(decoded.into_owned());
    }
    Ok(parts.join("/"))
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(message.as_bytes().to_vec())
        .unwrap()
}
