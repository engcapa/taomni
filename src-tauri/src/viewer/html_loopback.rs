//! Ephemeral loopback HTTP listener for macOS HTML previews.
//!
//! WKWebView refuses to commit opaque `sandbox` iframes from custom URL
//! schemes or unrouted `*.localhost` hostnames. Serving preview tokens over
//! loopback HTTP preserves `GET`-only capability isolation and sandbox CSP.

use super::html;
use axum::Router;
use axum::body::Body;
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::{HeaderMap, Method, Request, Response, StatusCode, header};
use axum::routing::any;
use std::net::TcpListener;
use std::sync::OnceLock;
use tokio::runtime::Builder;

struct LoopbackServer {
    port: u16,
    origin: String,
    host_header: String,
}

static SERVER: OnceLock<LoopbackServer> = OnceLock::new();

fn server() -> &'static LoopbackServer {
    SERVER.get_or_init(start_server)
}

fn start_server() -> LoopbackServer {
    let listener = TcpListener::bind("127.0.0.1:0")
        .expect("viewer HTML loopback listener must bind to 127.0.0.1:0");
    listener
        .set_nonblocking(true)
        .expect("viewer HTML loopback listener must be nonblocking");
    let port = listener
        .local_addr()
        .expect("viewer HTML loopback listener must have a local address")
        .port();
    let origin = format!("http://127.0.0.1:{port}");
    let host_header = format!("127.0.0.1:{port}");
    std::thread::Builder::new()
        .name("viewer-html-loopback".into())
        .spawn(move || {
            let runtime = Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .thread_name("viewer-html-http")
                .build()
                .expect("viewer HTML loopback runtime must initialize");
            runtime.block_on(async move {
                let tcp = tokio::net::TcpListener::from_std(listener)
                    .expect("viewer HTML tokio listener conversion must succeed");
                let app = Router::new().fallback(any(handle_request));
                if let Err(error) = axum::serve(tcp, app).await {
                    log::error!("viewer HTML loopback server failed: {error}");
                }
            });
        })
        .expect("viewer HTML loopback thread must spawn");
    LoopbackServer {
        port,
        origin,
        host_header,
    }
}

pub(super) fn origin() -> &'static str {
    &server().origin
}

pub(super) fn is_origin_authority(scheme: &str, authority: &str) -> bool {
    SERVER
        .get()
        .is_some_and(|srv| scheme == "http" && authority == srv.host_header)
}

pub(super) fn is_own_url(url: &url::Url) -> bool {
    SERVER.get().is_some_and(|srv| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(srv.port)
    })
}

fn plain_error(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Access-Control-Allow-Origin", "null")
        .body(Body::from(message.as_bytes().to_vec()))
        .unwrap()
}

fn convert_response(resp: tauri::http::Response<Vec<u8>>) -> Response<Body> {
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder().status(status);
    if let Some(headers) = builder.headers_mut() {
        for (name, value) in resp.headers() {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_str().as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                headers.append(name, value);
            }
        }
    }
    builder
        .body(Body::from(resp.into_body()))
        .unwrap_or_else(|_| plain_error(StatusCode::BAD_GATEWAY, "permission: Invalid response"))
}

fn valid_host(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host == expected)
}

async fn handle_request(req: Request<Body>) -> Response<Body> {
    if req.method() != Method::GET {
        return plain_error(StatusCode::METHOD_NOT_ALLOWED, "permission: GET only");
    }
    let srv = server();
    if !valid_host(req.headers(), &srv.host_header) {
        return plain_error(StatusCode::FORBIDDEN, "permission: Invalid preview host");
    }
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let token = req
        .uri()
        .path()
        .strip_prefix('/')
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("");
    let Some(owner) = html::preview_owner(token) else {
        return plain_error(StatusCode::FORBIDDEN, "permission: Expired preview token");
    };
    let uri = format!("{}{}", srv.origin, path_and_query);
    let Ok(tauri_req) = tauri::http::Request::builder()
        .method(tauri::http::Method::GET)
        .uri(uri)
        .body(Vec::new())
    else {
        return plain_error(StatusCode::FORBIDDEN, "permission: Invalid preview URI");
    };
    convert_response(html::serve_async(tauri_req, owner).await)
}

#[cfg(test)]
mod tests {
    use super::{is_origin_authority, is_own_url, origin, server};
    use crate::viewer::html::{close_html, open_html};
    use crate::viewer::network::validate_url;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    fn http_request(port: u16, raw: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn loopback_serves_active_tokens_and_rejects_bad_host_method_and_ssrf() {
        let srv = server();
        let origin_url = origin();
        assert!(is_origin_authority("http", &srv.host_header));
        assert!(!is_origin_authority("https", &srv.host_header));
        assert!(!is_origin_authority("http", "127.0.0.1:1"));

        let parsed_own = url::Url::parse(&format!("{origin_url}/abc")).unwrap();
        assert!(is_own_url(&parsed_own));
        assert!(validate_url(&format!("{origin_url}/secret")).is_err());
        assert!(validate_url("http://127.0.0.1:9/ok").is_ok());

        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.html");
        fs::write(&index, b"<h1>loopback ok</h1>").unwrap();
        let session =
            open_html(index.to_str().unwrap(), false, true, "loopback-test", None).unwrap();

        let ok = http_request(
            srv.port,
            &format!(
                "GET /{}/index.html HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                session.token, srv.host_header
            ),
        );
        assert!(ok.starts_with("HTTP/1.1 200 OK"), "{ok}");
        assert!(ok.contains("sandbox allow-scripts"), "{ok}");
        assert!(ok.contains("taomni-html-preview"), "{ok}");

        let wrong_host = http_request(
            srv.port,
            &format!(
                "GET /{}/index.html HTTP/1.1\r\nHost: evil.example:{}\r\nConnection: close\r\n\r\n",
                session.token, srv.port
            ),
        );
        assert!(wrong_host.starts_with("HTTP/1.1 403"), "{wrong_host}");

        let bad_token = http_request(
            srv.port,
            &format!(
                "GET /{}/index.html HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                "0".repeat(32),
                srv.host_header
            ),
        );
        assert!(bad_token.starts_with("HTTP/1.1 403"), "{bad_token}");

        let post = http_request(
            srv.port,
            &format!(
                "POST /{}/index.html HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                session.token, srv.host_header
            ),
        );
        assert!(post.starts_with("HTTP/1.1 405"), "{post}");

        let traversal = http_request(
            srv.port,
            &format!(
                "GET /{}/../secret HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                session.token, srv.host_header
            ),
        );
        assert!(traversal.starts_with("HTTP/1.1 403"), "{traversal}");

        close_html(&session.token, "loopback-test").unwrap();
    }
}
