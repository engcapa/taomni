use super::*;

impl Drop for ForwardTaskGuard {
    fn drop(&mut self) {
        if let Some(task) = self.0.as_ref() {
            task.abort();
        }
    }
}

pub(crate) async fn dial_vnc_transport(
    host: String,
    port: u16,
    network: Option<NetworkSettings>,
) -> Result<VncDialedTransport, String> {
    tokio::time::timeout(VNC_CONNECT_TIMEOUT, async move {
        let network_forward = match network.as_ref() {
            Some(settings) if settings.proxy_kind != "none" && !settings.proxy_kind.is_empty() => {
                Some(crate::database::forward::start(host.clone(), port, settings.clone()).await?)
            }
            _ => None,
        };
        let local_port = network_forward.as_ref().map(|forward| forward.local_port);
        let mut forward_guard = ForwardTaskGuard(network_forward.map(|forward| forward.task));
        let socket = match local_port {
            Some(local_port) => TcpStream::connect(("127.0.0.1", local_port))
                .await
                .map_err(|e| format!("VNC TCP connection failed: {e}"))?,
            None => crate::terminal::network::establish_transport(&host, port, network.as_ref())
                .await
                .map_err(|e| format!("VNC TCP connection failed: {e}"))?,
        };
        Ok(VncDialedTransport {
            stream: socket,
            network_forward_task: forward_guard.0.take(),
        })
    })
    .await
    .map_err(|_| "VNC TCP connection timed out after 15 seconds".to_string())?
}

pub(super) async fn accept_authorized_ws(
    listener: TcpListener,
    ws_token: &str,
    cancel: &CancellationToken,
) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, String> {
    let deadline = tokio::time::Instant::now() + WS_ACCEPT_TIMEOUT;
    let expected_protocol = format!("taomni-vnc.{ws_token}");
    let relay_limits = crate::vnc::limits::DecodeLimits::default();
    loop {
        let (stream, _) = tokio::select! {
            accepted = tokio::time::timeout_at(deadline, listener.accept()) => match accepted {
                Ok(Ok(pair)) => pair,
                Ok(Err(error)) => return Err(format!("VNC WebSocket accept failed: {error}")),
                Err(_) => {
                    tracing::warn!("VNC WS authorization timed out after {:?}", WS_ACCEPT_TIMEOUT);
                    return Err("VNC WebSocket authorization timed out".into());
                }
            },
            _ = cancel.cancelled() => return Err("VNC relay cancelled".into()),
        };
        stream
            .set_nodelay(true)
            .map_err(|error| format!("configure VNC WebSocket TCP_NODELAY: {error}"))?;

        let protocol = expected_protocol.clone();
        let callback = move |request: &Request, mut response: Response| {
            let has_protocol = request
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.split(',').any(|item| item.trim() == protocol));
            let origin_ok = request
                .headers()
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .is_some_and(is_authorized_origin);
            let path_ok = request.uri().path() == VNC_WS_PATH;
            if !has_protocol || !origin_ok || !path_ok {
                let mut rejection = ErrorResponse::new(Some("forbidden".to_string()));
                *rejection.status_mut() = StatusCode::FORBIDDEN;
                return Err(rejection);
            }
            response.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocol).expect("generated VNC protocol is valid"),
            );
            Ok(response)
        };
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(relay_limits.max_relay_message_bytes))
            .max_frame_size(Some(relay_limits.max_relay_message_bytes))
            .max_write_buffer_size(relay_limits.max_frame_queue_bytes);
        match tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(ws_config))
            .await
        {
            Ok(socket) => return Ok(socket),
            Err(error) => tracing::warn!("rejected unauthorized VNC WebSocket attempt: {error}"),
        }
    }
}

pub(super) fn is_authorized_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    if cfg!(debug_assertions) {
        return matches!(
            origin,
            "http://localhost:1980"
                | "http://127.0.0.1:1980"
                | "http://localhost:5000"
                | "http://127.0.0.1:5000"
        );
    }
    false
}
