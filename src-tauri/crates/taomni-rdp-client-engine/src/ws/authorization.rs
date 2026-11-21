use super::relay::WS_ACCEPT_TIMEOUT;
use std::time::Instant;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tungstenite::handshake::server::ErrorResponse;
use tungstenite::handshake::server::Request;
use tungstenite::handshake::server::Response;
use tungstenite::http::HeaderValue;
use tungstenite::http::StatusCode;
use tungstenite::http::header;

pub(super) async fn accept_authorized_ws(
    listener: &TcpListener,
    ws_token: &str,
    cancel: &CancellationToken,
) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, String> {
    let deadline = tokio::time::Instant::now() + WS_ACCEPT_TIMEOUT;
    let expected_protocol = format!("taomni-rdp.{ws_token}");
    loop {
        let (stream, _) = tokio::select! {
            accepted = tokio::time::timeout_at(deadline, listener.accept()) => match accepted {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return Err(format!("rdp accept: {e}")),
                Err(_) => {
                    tracing::warn!("RDP WS accept timed out after {:?}", WS_ACCEPT_TIMEOUT);
                    return Err("RDP WebSocket authorization timed out".to_string());
                }
            },
            _ = cancel.cancelled() => return Err("RDP relay cancelled".to_string()),
        };
        let protocol = expected_protocol.clone();
        let callback = move |request: &Request, mut response: Response| {
            if !request_has_authorized_origin(request) || !request_has_protocol(request, &protocol)
            {
                let mut rejection = ErrorResponse::new(Some("forbidden".to_string()));
                *rejection.status_mut() = StatusCode::FORBIDDEN;
                return Err(rejection);
            }
            response.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocol).expect("generated WS protocol is valid"),
            );
            Ok(response)
        };
        match tokio_tungstenite::accept_hdr_async(stream, callback).await {
            Ok(ws) => return Ok(ws),
            Err(e) => tracing::warn!("rejected unauthorized RDP WebSocket attempt: {e}"),
        }
    }
}

pub(super) fn request_has_protocol(request: &Request, expected: &str) -> bool {
    request
        .headers()
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|item| item.trim() == expected))
}

pub(super) fn request_has_authorized_origin(request: &Request) -> bool {
    request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_authorized_origin)
}

pub(super) fn is_authorized_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    if cfg!(debug_assertions) {
        return [
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "http://localhost:5000",
            "http://127.0.0.1:5000",
        ]
        .contains(&origin);
    }
    false
}
