//! SOCKS5 CONNECT dialer (shared pattern with `terminal::network`).

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn dial(
    proxy_host: &str,
    proxy_port: u16,
    dest_host: &str,
    dest_port: u16,
    user: &str,
    pass: &str,
) -> Result<TcpStream, String> {
    let mut s = tokio::time::timeout(
        PROXY_CONNECT_TIMEOUT,
        TcpStream::connect((proxy_host, proxy_port)),
    )
    .await
    .map_err(|_| {
        format!(
            "connect socks {proxy_host}:{proxy_port}: timed out after {}s",
            PROXY_CONNECT_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("connect socks {proxy_host}:{proxy_port}: {e}"))?;
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
    handshake_with_timeout(s, host, port, user, pass, PROXY_HANDSHAKE_TIMEOUT).await
}

async fn handshake_with_timeout(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    timeout: Duration,
) -> Result<(), String> {
    tokio::time::timeout(timeout, handshake_inner(s, host, port, user, pass))
        .await
        .map_err(|_| {
            format!(
                "SOCKS5 CONNECT {host}:{port}: timed out after {}s",
                timeout.as_secs_f64()
            )
        })?
}

async fn handshake_inner(
    s: &mut TcpStream,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let methods: Vec<u8> = if user.is_empty() {
        vec![0x00]
    } else {
        vec![0x00, 0x02]
    };
    let mut greet = vec![0x05u8, methods.len() as u8];
    greet.extend_from_slice(&methods);
    s.write_all(&greet)
        .await
        .map_err(|e| format!("socks write: {e}"))?;

    let mut sel = [0u8; 2];
    s.read_exact(&mut sel)
        .await
        .map_err(|e| format!("socks read: {e}"))?;
    if sel[0] != 0x05 {
        return Err("SOCKS5: bad version in greeting".into());
    }
    match sel[1] {
        0x00 => {}
        0x02 => {
            let u = user.as_bytes();
            let p = pass.as_bytes();
            if u.len() > 255 || p.len() > 255 {
                return Err("SOCKS5 user/pass too long (>255 bytes)".into());
            }
            let mut auth = vec![0x01u8, u.len() as u8];
            auth.extend_from_slice(u);
            auth.push(p.len() as u8);
            auth.extend_from_slice(p);
            s.write_all(&auth)
                .await
                .map_err(|e| format!("socks auth: {e}"))?;
            let mut ack = [0u8; 2];
            s.read_exact(&mut ack)
                .await
                .map_err(|e| format!("socks auth read: {e}"))?;
            if ack[1] != 0x00 {
                return Err("SOCKS5 username/password rejected".into());
            }
        }
        0xff => return Err("SOCKS5 server requires an auth method we don't support".into()),
        m => return Err(format!("SOCKS5 unsupported auth method 0x{m:02x}")),
    }

    let mut req: Vec<u8> = vec![0x05, 0x01, 0x00];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            req.push(0x01);
            req.extend_from_slice(&v4.octets());
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            req.push(0x04);
            req.extend_from_slice(&v6.octets());
        }
        Err(_) => {
            let host_bytes = host.as_bytes();
            if host_bytes.len() > 255 {
                return Err("SOCKS5 destination host too long (>255 bytes)".into());
            }
            req.push(0x03);
            req.push(host_bytes.len() as u8);
            req.extend_from_slice(host_bytes);
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req)
        .await
        .map_err(|e| format!("socks request: {e}"))?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head)
        .await
        .map_err(|e| format!("socks reply: {e}"))?;
    if head[0] != 0x05 {
        return Err("SOCKS5: bad version in reply".into());
    }
    if head[1] != 0x00 {
        return Err(format!("SOCKS5 connect failed (rep=0x{:02x})", head[1]));
    }
    let skip = match head[3] {
        0x01 => 4usize,
        0x04 => 16,
        0x03 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l)
                .await
                .map_err(|e| format!("socks bnd: {e}"))?;
            l[0] as usize
        }
        other => return Err(format!("SOCKS5 unknown ATYP 0x{other:02x}")),
    };
    let mut bnd = vec![0u8; skip + 2];
    s.read_exact(&mut bnd)
        .await
        .map_err(|e| format!("socks bnd: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn socks_handshake_times_out_when_proxy_never_replies() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let mut client = TcpStream::connect(address).await.unwrap();

        let error = handshake_with_timeout(
            &mut client,
            "example.com",
            443,
            "",
            "",
            Duration::from_millis(30),
        )
        .await
        .unwrap_err();

        assert!(error.contains("timed out"));
        server.abort();
    }
}
