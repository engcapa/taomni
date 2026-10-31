use super::{Core, MobileRuntime, agent_view, file_view, session_view, streams};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Service {
    pub core: Core,
    pub runtime: Arc<MobileRuntime>,
    pub cancel: CancellationToken,
}
pub struct ApiError(pub String);
impl From<String> for ApiError {
    fn from(e: String) -> Self {
        Self(e)
    }
}
impl From<&str> for ApiError {
    fn from(e: &str) -> Self {
        Self(e.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0.as_str() {
            "unauthorized" => StatusCode::UNAUTHORIZED,
            "origin_denied" | "path_denied" | "not_holder" => StatusCode::FORBIDDEN,
            "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
            "turn_in_progress" | "already_resolved" | "control_busy" => StatusCode::CONFLICT,
            "session_not_found" | "terminal_not_found" => StatusCode::NOT_FOUND,
            _ => StatusCode::BAD_REQUEST,
        };
        (status, Json(json!({"error":self.0}))).into_response()
    }
}
pub type ApiResult = Result<Json<Value>, ApiError>;
pub fn origin(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
}
pub fn origin_allowed(s: &Service, headers: &HeaderMap) -> bool {
    let Some(origin) = origin(headers) else {
        return true;
    };
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let authority = &url[url::Position::BeforeHost..url::Position::AfterPort];
    // Forwarded headers are untrusted. A rewriting proxy must pair its shell
    // origin explicitly; we never trust a client-supplied X-Forwarded-Host.
    ((url.scheme() == "http" || url.scheme() == "https") && authority.eq_ignore_ascii_case(host))
        || s.runtime.auth.lock().unwrap().paired_origin(origin)
}
pub fn authenticated(s: &Service, headers: &HeaderMap) -> Result<String, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or("unauthorized")?;
    s.runtime
        .auth
        .lock()
        .map_err(|_| "auth_unavailable")?
        .authenticate(token)
        .ok_or_else(|| "unauthorized".into())
}
async fn cors(State(s): State<Service>, request: axum::extract::Request, next: Next) -> Response {
    let path = request.uri().path();
    let api = path.starts_with("/api/v1/");
    let public = path == "/api/v1/health" || path == "/api/v1/pair";
    let allowed = !api || public || origin_allowed(&s, request.headers());
    let origin = origin(request.headers()).map(str::to_owned);
    let preflight = request.method() == axum::http::Method::OPTIONS;
    let mut response = if !allowed {
        ApiError("origin_denied".into()).into_response()
    } else if preflight && api {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    if api && allowed {
        let h = response.headers_mut();
        if let Some(origin) = origin.and_then(|o| o.parse().ok()) {
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        }
        h.insert(header::VARY, "Origin".parse().unwrap());
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, POST, OPTIONS".parse().unwrap(),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "Authorization, Content-Type".parse().unwrap(),
        );
        h.insert(header::ACCESS_CONTROL_MAX_AGE, "86400".parse().unwrap());
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
pub fn router(s: Service) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/ws-ticket", post(ticket))
        .route("/api/v1/sessions", get(sessions))
        .route("/api/v1/sessions/{id}", get(detail))
        .route("/api/v1/sessions/{id}/stop", post(stop))
        .route("/api/v1/sessions/{id}/message", post(message))
        .route("/api/v1/tasks/{id}/confirmations/{cid}", post(confirm))
        .route("/api/v1/tasks/{id}/changes", get(changes))
        .route("/api/v1/tasks/{id}/files", get(file))
        .route("/api/v1/tasks/{id}/changes/{*path}", get(diff))
        .route("/api/v1/events", get(streams::events))
        .route("/api/v1/terminals/{id}/stream", get(streams::terminal))
        .fallback(get(static_file))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(s.clone(), cors))
        .with_state(s)
}
async fn health(State(s): State<Service>) -> Json<Value> {
    Json(
        json!({"service":"taomni-mobile","version":"1","pairing_required":true,"run_mode":s.core.mode()}),
    )
}
#[derive(Deserialize)]
struct Pair {
    endpoint_label: String,
    pairing_code: String,
}
async fn pair(
    State(s): State<Service>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(p): Json<Pair>,
) -> ApiResult {
    Ok(Json(
        s.runtime
            .auth
            .lock()
            .map_err(|_| "auth_unavailable")?
            .pair(
                &p.endpoint_label,
                &p.pairing_code,
                origin(&headers).map(str::to_owned),
                &peer.ip().to_string(),
            )?,
    ))
}
async fn ticket(State(s): State<Service>, headers: HeaderMap) -> ApiResult {
    let id = authenticated(&s, &headers)?;
    let ticket = s
        .runtime
        .auth
        .lock()
        .unwrap()
        .ticket(id, origin(&headers).map(str::to_owned))?;
    Ok(Json(json!({"ticket":ticket})))
}
async fn sessions(State(s): State<Service>, headers: HeaderMap) -> ApiResult {
    authenticated(&s, &headers)?;
    Ok(Json(session_view::list(&s.core.state()).await?))
}
async fn detail(State(s): State<Service>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    authenticated(&s, &headers)?;
    Ok(Json(session_view::detail(&s.core.state(), &id).await?))
}
async fn stop(State(s): State<Service>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    authenticated(&s, &headers)?;
    agent_view::stop(&s.core, &id).await?;
    Ok(Json(json!({"status":"stopped"})))
}
#[derive(Deserialize)]
struct Message {
    text: String,
}
async fn message(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(p): Json<Message>,
) -> ApiResult {
    authenticated(&s, &headers)?;
    agent_view::message(s.core.clone(), &id, &p.text).await?;
    Ok(Json(
        json!({"status":"running", "context":"mobile_without_desktop_context"}),
    ))
}
#[derive(Deserialize)]
struct Decision {
    decision: String,
}
async fn confirm(
    State(s): State<Service>,
    headers: HeaderMap,
    Path((id, cid)): Path<(String, String)>,
    Json(p): Json<Decision>,
) -> ApiResult {
    authenticated(&s, &headers)?;
    agent_view::confirm(&s.core.state(), &id, &cid, &p.decision)?;
    Ok(Json(json!({"status":"resolved"})))
}
async fn changes(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    authenticated(&s, &headers)?;
    Ok(Json(file_view::changes(&s.core.state(), &id).await?))
}
#[derive(Deserialize)]
struct FilePath {
    path: String,
}
async fn file(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(p): Query<FilePath>,
) -> ApiResult {
    authenticated(&s, &headers)?;
    Ok(Json(file_view::file(&s.core.state(), &id, &p.path).await?))
}
async fn diff(
    State(s): State<Service>,
    headers: HeaderMap,
    Path((id, path)): Path<(String, String)>,
) -> ApiResult {
    authenticated(&s, &headers)?;
    let path = path.strip_suffix("/diff").ok_or("diff_unavailable")?;
    Ok(Json(file_view::diff(&s.core.state(), &id, path).await?))
}
async fn static_file(uri: axum::http::Uri) -> Response {
    let path = if uri.path() == "/" {
        "index.html"
    } else {
        uri.path().trim_start_matches('/')
    };
    if path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    for (name, bytes) in ASSETS {
        if *name == path {
            let mime = if path.ends_with(".js") {
                "application/javascript"
            } else if path.ends_with(".css") {
                "text/css"
            } else if path.ends_with(".webmanifest") {
                "application/manifest+json"
            } else if path.ends_with(".svg") {
                "image/svg+xml"
            } else {
                "text/html; charset=utf-8"
            };
            return ([(header::CONTENT_TYPE, mime), (header::CONTENT_SECURITY_POLICY,
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http: https: ws: wss:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")], *bytes).into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}
include!(concat!(env!("OUT_DIR"), "/mobile_assets.rs"));
