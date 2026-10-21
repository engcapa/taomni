use crate::proxy::ResolvedProxy;
use base64::Engine;
use futures::StreamExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use url::Url;

pub(super) async fn connect_ws(
    request: tungstenite::http::Request<()>,
    proxy: Option<&ResolvedProxy>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        tungstenite::http::Response<Option<Vec<u8>>>,
    ),
    String,
> {
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        connect_ws_inner(request, proxy),
    )
    .await
    .map_err(|_| "ASR_CONNECT_TIMEOUT: check the provider and proxy settings".to_string())?
}

pub(super) async fn connect_ws_inner(
    request: tungstenite::http::Request<()>,
    proxy: Option<&ResolvedProxy>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        tungstenite::http::Response<Option<Vec<u8>>>,
    ),
    String,
> {
    let uri = request.uri().to_string();
    let url = Url::parse(&uri).map_err(|e| format!("ASR_WS_URL: {e}"))?;
    let host = url.host_str().ok_or("ASR_WS_URL: missing host")?;
    let port = url
        .port_or_known_default()
        .ok_or("ASR_WS_URL: missing port")?;
    let stream = if let Some(proxy) = proxy {
        let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        if proxy.kind == "socks5" {
            socks5_connect(&mut stream, host, port, proxy).await?;
        } else {
            http_connect(&mut stream, host, port, proxy).await?;
        }
        stream
    } else {
        TcpStream::connect((host, port))
            .await
            .map_err(|e| format!("ASR_CONNECT: {e}"))?
    };
    tokio_tungstenite::client_async_tls(request, stream)
        .await
        .map_err(|_| {
            "ASR_CONNECT: WebSocket handshake failed; check endpoint and credentials".into()
        })
}

pub(super) async fn http_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    proxy: &ResolvedProxy,
) -> Result<(), String> {
    let mut request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if !proxy.username.is_empty() {
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", proxy.username, proxy.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("Connection: Keep-Alive\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    let mut response = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while response.len() < 16 * 1024 {
        stream
            .read_exact(&mut byte)
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&response);
    let status = text
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .unwrap_or_default();
    if !status.starts_with('2') {
        return Err(format!("ASR_PROXY_CONNECT: HTTP CONNECT failed ({status})"));
    }
    Ok(())
}

pub(super) async fn socks5_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    proxy: &ResolvedProxy,
) -> Result<(), String> {
    let auth = if proxy.username.is_empty() {
        vec![0u8]
    } else {
        vec![0u8, 2u8]
    };
    stream
        .write_all(&[5, auth.len() as u8])
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    stream
        .write_all(&auth)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    let mut selected = [0u8; 2];
    stream
        .read_exact(&mut selected)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    if selected[1] == 2 {
        if proxy.username.len() > 255 || proxy.password.len() > 255 {
            return Err("ASR_PROXY_CONNECT: SOCKS5 credentials too long".into());
        }
        stream
            .write_all(&[1, proxy.username.len() as u8])
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        stream
            .write_all(proxy.username.as_bytes())
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        stream
            .write_all(&[proxy.password.len() as u8])
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        stream
            .write_all(proxy.password.as_bytes())
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        let mut result = [0u8; 2];
        stream
            .read_exact(&mut result)
            .await
            .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
        if result[1] != 0 {
            return Err("ASR_PROXY_CONNECT: SOCKS5 authentication failed".into());
        }
    } else if selected[1] != 0 {
        return Err("ASR_PROXY_CONNECT: SOCKS5 authentication method rejected".into());
    }
    let host_bytes = host.as_bytes();
    if host_bytes.len() > 255 {
        return Err("ASR_PROXY_CONNECT: host name too long".into());
    }
    let mut command = vec![5, 1, 0, 3, host_bytes.len() as u8];
    command.extend_from_slice(host_bytes);
    command.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&command)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    if head[1] != 0 {
        return Err(format!(
            "ASR_PROXY_CONNECT: SOCKS5 target rejected ({})",
            head[1]
        ));
    }
    let length = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut n = [0u8; 1];
            stream
                .read_exact(&mut n)
                .await
                .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
            n[0] as usize
        }
        _ => return Err("ASR_PROXY_CONNECT: invalid SOCKS5 address".into()),
    };
    let mut discard = vec![0u8; length + 2];
    stream
        .read_exact(&mut discard)
        .await
        .map_err(|e| format!("ASR_PROXY_CONNECT: {e}"))?;
    Ok(())
}

pub(super) fn ws_request(
    url: &str,
    headers: &[(&str, &str)],
) -> Result<tungstenite::http::Request<()>, String> {
    use tungstenite::client::IntoClientRequest;
    let endpoint = Url::parse(url).map_err(|_| "ASR_WS_REQUEST: invalid endpoint")?;
    if !matches!(endpoint.scheme(), "ws" | "wss") || endpoint.host_str().is_none() {
        return Err("ASR_WS_REQUEST: endpoint must use ws:// or wss:// with a host".into());
    }
    // A manually built HTTP request does not acquire the required WebSocket
    // upgrade headers in client_async_tls. Let tungstenite generate a fresh
    // Sec-WebSocket-Key, Host, Connection, Upgrade and version for each session.
    let mut request = url
        .into_client_request()
        .map_err(|_| "ASR_WS_REQUEST: invalid WebSocket endpoint")?;
    for (name, value) in headers {
        let name = tungstenite::http::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "ASR_WS_REQUEST: invalid header name")?;
        let value = tungstenite::http::HeaderValue::from_str(value)
            .map_err(|_| "ASR_WS_REQUEST: invalid header value")?;
        request.headers_mut().insert(name, value);
    }
    Ok(request)
}
