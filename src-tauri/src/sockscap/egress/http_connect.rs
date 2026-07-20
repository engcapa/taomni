//! HTTP CONNECT dialer (shared pattern with `terminal::network`).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Connect to `proxy_host:proxy_port` and CONNECT to `dest_host:dest_port`.
/// Returns the tunnelled stream on success.
pub async fn dial(
    proxy_host: &str,
    proxy_port: u16,
    dest_host: &str,
    dest_port: u16,
    user: &str,
    pass: &str,
) -> Result<TcpStream, String> {
    let mut s = TcpStream::connect((proxy_host, proxy_port))
        .await
        .map_err(|e| format!("connect proxy {proxy_host}:{proxy_port}: {e}"))?;
    handshake(&mut s, dest_host, dest_port, user, pass).await?;
    Ok(s)
}

pub async fn handshake(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let mut req = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Connection: keep-alive\r\n"
    );
    if !user.is_empty() {
        let token = B64.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| format!("proxy write: {e}"))?;

    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = s
            .read(&mut byte)
            .await
            .map_err(|e| format!("proxy read: {e}"))?;
        if n == 0 {
            return Err("Proxy closed connection during CONNECT handshake".into());
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 8192 {
            return Err("Proxy CONNECT response exceeded 8KB".into());
        }
    }
    let resp = String::from_utf8_lossy(&buf);
    let status = resp.lines().next().unwrap_or("");
    let parts: Vec<&str> = status.split_whitespace().collect();
    if parts.len() < 2 || parts[1] != "200" {
        return Err(format!("HTTP proxy rejected CONNECT: {status}"));
    }
    Ok(())
}
