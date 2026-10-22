use super::handler::CcHandler;
use super::model::Flavor;
use super::model::TokenMap;
use super::model::TokenScope;
use super::model::TrustLevel;
use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use rmcp::transport::streamable_http_server::StreamableHttpService;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use std::collections::HashMap;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::AppHandle;

pub(super) struct RunningServer {
    pub(super) addr: SocketAddr,
    pub(super) tokens: TokenMap,
}

pub(super) static SERVER: OnceLock<Mutex<Option<RunningServer>>> = OnceLock::new();

pub(super) fn slot() -> &'static Mutex<Option<RunningServer>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// Loopback MCP endpoint URL for an address + flavor (the flavor's nest path).
pub fn server_url(addr: SocketAddr, flavor: Flavor) -> String {
    format!("http://{addr}{}", flavor.path())
}

pub fn control_server_url() -> Result<String, String> {
    let guard = slot().lock().unwrap();
    let server = guard.as_ref().ok_or("CC MCP server not started")?;
    Ok(server_url(server.addr, Flavor::Control))
}

pub(super) fn generate_token() -> String {
    let mut buf = [0u8; 24];
    rand::fill(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Start the in-app CC MCP server if it isn't running yet; returns its address.
/// Idempotent — repeated calls return the existing listener. One listener hosts
/// all flavors at distinct nest paths (`/mcp`, `/mcp/sql`, `/mcp/redis`), behind
/// one Bearer auth layer + one shared token map.
pub async fn ensure_started(app: &AppHandle) -> Result<SocketAddr, String> {
    {
        let guard = slot().lock().unwrap();
        if let Some(s) = guard.as_ref() {
            return Ok(s.addr);
        }
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind CC MCP listener: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let tokens: TokenMap = Arc::new(Mutex::new(HashMap::new()));

    // Shell flavor (legacy `/mcp`) — the existing CcHandler tool surface.
    let shell_service = {
        let app = app.clone();
        let toks = tokens.clone();
        StreamableHttpService::new(
            move || Ok(CcHandler::new(app.clone(), toks.clone())),
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        )
    };
    // SQL flavor (`/mcp/sql`) — MySQL/PG/PanWeiDB/Oracle/SQL Server/StarRocks/ClickHouse/Presto.
    let sql_service = {
        let app = app.clone();
        let toks = tokens.clone();
        StreamableHttpService::new(
            move || {
                Ok(crate::agent::cc_bridge::mcp_sql::SqlHandler::new(
                    app.clone(),
                    toks.clone(),
                ))
            },
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        )
    };
    // Redis flavor (`/mcp/redis`).
    let redis_service = {
        let app = app.clone();
        let toks = tokens.clone();
        StreamableHttpService::new(
            move || {
                Ok(crate::agent::cc_bridge::mcp_redis::RedisHandler::new(
                    app.clone(),
                    toks.clone(),
                ))
            },
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        )
    };
    // Control flavor (`/mcp/control`) — Taomni sessions, tabs, and app config.
    let control_service = {
        let app = app.clone();
        let toks = tokens.clone();
        StreamableHttpService::new(
            move || {
                Ok(crate::agent::cc_bridge::mcp_control::ControlHandler::new(
                    app.clone(),
                    toks.clone(),
                ))
            },
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        )
    };

    let auth_tokens = tokens.clone();
    let router = axum::Router::new()
        .nest_service(Flavor::Sql.path(), sql_service)
        .nest_service(Flavor::Redis.path(), redis_service)
        .nest_service(Flavor::Control.path(), control_service)
        // Shell at `/mcp` is mounted last so the more specific `/mcp/sql` and
        // `/mcp/redis`/`/mcp/control` nests take precedence over the `/mcp`
        // prefix.
        .nest_service(Flavor::Shell.path(), shell_service)
        .layer(axum::middleware::from_fn(
            move |req: Request, next: Next| {
                let toks = auth_tokens.clone();
                async move { auth_mw(toks, req, next).await }
            },
        ));

    {
        let mut guard = slot().lock().unwrap();
        // Lost a race: another caller bound + stored first. Drop our listener.
        if let Some(s) = guard.as_ref() {
            return Ok(s.addr);
        }
        *guard = Some(RunningServer {
            addr,
            tokens: tokens.clone(),
        });
    }

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!("CC MCP server exited: {e}");
        }
    });

    Ok(addr)
}

/// Mint a token scoped to one CC thread. The server must already be started.
pub fn mint_token(
    thread_id: String,
    allowed_session_id: Option<String>,
    allowed_config_id: Option<String>,
    trust: TrustLevel,
    flavor: Flavor,
    confirm_readonly: bool,
    inline_permission: bool,
) -> Result<(SocketAddr, String), String> {
    let guard = slot().lock().unwrap();
    let server = guard.as_ref().ok_or("CC MCP server not started")?;
    let token = generate_token();
    server.tokens.lock().unwrap().insert(
        token.clone(),
        TokenScope {
            thread_id,
            allowed_session_id,
            allowed_config_id,
            trust,
            flavor,
            confirm_readonly,
            inline_permission,
            session_approved: Arc::new(Mutex::new(HashSet::new())),
        },
    );
    Ok((server.addr, token))
}

/// Revoke a token (e.g. when its CC process stops). Idempotent.
pub fn revoke_token(token: &str) {
    if let Some(s) = slot().lock().unwrap().as_ref() {
        s.tokens.lock().unwrap().remove(token);
    }
}

/// Ensure the server is up and mint a scoped token for one CC thread. Trust is
/// inferred (D3): a thread linked to a remote session is strict and scoped to
/// that session; an unlinked (local-workspace) thread is lenient. `flavor`
/// selects the tool surface (Shell / Sql / Redis). Returns the
/// `(server_url, token)` to inject into the thread's `.mcp.json`.
pub async fn provision_for_thread(
    app: &AppHandle,
    thread_id: &str,
    linked_session_id: Option<String>,
    linked_config_id: Option<String>,
    flavor: Flavor,
    confirm_readonly: bool,
) -> Result<(String, String), String> {
    provision_for_thread_with_inline_permission(
        app,
        thread_id,
        linked_session_id,
        linked_config_id,
        flavor,
        confirm_readonly,
        false,
    )
    .await
}

pub async fn provision_for_thread_with_inline_permission(
    app: &AppHandle,
    thread_id: &str,
    linked_session_id: Option<String>,
    linked_config_id: Option<String>,
    flavor: Flavor,
    confirm_readonly: bool,
    inline_permission: bool,
) -> Result<(String, String), String> {
    ensure_started(app).await?;
    let trust = if linked_session_id.is_some() {
        TrustLevel::Strict
    } else {
        TrustLevel::Lenient
    };
    let (addr, token) = mint_token(
        thread_id.to_string(),
        linked_session_id,
        linked_config_id,
        trust,
        flavor,
        confirm_readonly,
        inline_permission,
    )?;
    Ok((server_url(addr, flavor), token))
}

/// Reject any request without a recognised Bearer token (401). Per-call scope
/// checks happen later, in the handler.
pub(super) async fn auth_mw(tokens: TokenMap, req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| tokens.lock().unwrap().contains_key(t))
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap()
    }
}
