use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

pub(super) async fn http_connect_handshake(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let mut req = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Connection: keep-alive\r\n",
        host = host,
        port = port,
    );
    if !user.is_empty() {
        let token = B64.encode(format!("{}:{}", user, pass));
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", token));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| format!("proxy write: {}", e))?;

    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = s
            .read(&mut byte)
            .await
            .map_err(|e| format!("proxy read: {}", e))?;
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
    let status = resp.lines().next().unwrap_or("").to_string();
    // "HTTP/1.1 200 Connection Established"
    let parts: Vec<&str> = status.split_whitespace().collect();
    if parts.len() < 2 || parts[1] != "200" {
        return Err(format!("HTTP proxy rejected CONNECT: {}", status));
    }
    Ok(())
}
