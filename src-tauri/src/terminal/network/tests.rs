use super::endpoint::parse_endpoint;
use super::model::NetworkSettings;
use super::transport::establish_transport;
use super::transport::resolve_destination_for_proxy;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use tokio::net::TcpListener;

#[test]
fn parse_endpoint_host_port() {
    let (h, p) = parse_endpoint("db.lan:5432").unwrap();
    assert_eq!(h, "db.lan");
    assert_eq!(p, 5432);
}

#[test]
fn parse_endpoint_ipv6_bracketed() {
    let (h, p) = parse_endpoint("[::1]:22").unwrap();
    assert_eq!(h, "::1");
    assert_eq!(p, 22);
}

#[test]
fn parse_endpoint_rejects_garbage() {
    assert!(parse_endpoint("no-port-here").is_err());
    assert!(parse_endpoint(":5432").is_err());
    assert!(parse_endpoint("host:notaport").is_err());
    assert!(parse_endpoint("[::1:22").is_err());
}

#[test]
fn from_json_returns_none_on_empty_or_garbage() {
    assert!(NetworkSettings::from_json(None).is_none());
    assert!(NetworkSettings::from_json(Some("")).is_none());
    assert!(NetworkSettings::from_json(Some("   ")).is_none());
    assert!(NetworkSettings::from_json(Some("not-json")).is_none());
}

#[test]
fn from_json_parses_jump_host_fields() {
    let raw = r#"{
            "proxyKind": "ssh-tunnel",
            "jumpSessionId": "",
            "jumpHost": "bastion.lan",
            "jumpPort": 2222,
            "jumpUser": "ops",
            "jumpAuthKind": "PrivateKey",
            "jumpKeyPath": "~/.ssh/id_ed25519"
        }"#;
    let n = NetworkSettings::from_json(Some(raw)).expect("parsed");
    assert!(n.uses_jump_host());
    assert_eq!(n.jump_host, "bastion.lan");
    assert_eq!(n.jump_port, 2222);
    assert_eq!(n.jump_user, "ops");
    assert_eq!(n.jump_auth_kind, "PrivateKey");
    assert_eq!(n.jump_key_path, "~/.ssh/id_ed25519");
}

#[test]
fn jump_defaults_apply_when_fields_absent() {
    // A bare proxy config without any jump_* keys still deserializes; the
    // jump fields take their serde defaults and uses_jump_host() is false.
    let n = NetworkSettings::from_json(Some(r#"{"proxyKind":"none"}"#)).expect("parsed");
    assert!(!n.uses_jump_host());
    assert_eq!(n.jump_auth_kind, "Password");
    assert_eq!(n.jump_port, 0);
    assert!(n.jump_host.is_empty());
}

#[test]
fn from_json_round_trip_camel_case() {
    let raw = r#"{
            "proxyKind": "http",
            "proxyHost": "proxy.corp",
            "proxyPort": 3128,
            "proxyUser": "alice",
            "proxyPass": "s3cret",
            "keepAlive": true,
            "keepAliveIntervalSecs": 30,
            "tcpNodelay": false,
            "ipVersion": "ipv6",
            "localForwards": [{"local":"127.0.0.1:5432","remote":"db.lan:5432"}]
        }"#;
    let n = NetworkSettings::from_json(Some(raw)).expect("parsed");
    assert_eq!(n.proxy_kind, "http");
    assert_eq!(n.proxy_host, "proxy.corp");
    assert_eq!(n.proxy_port, 3128);
    assert_eq!(n.proxy_user, "alice");
    assert_eq!(n.proxy_pass, "s3cret");
    assert!(n.keep_alive);
    assert_eq!(n.keep_alive_interval_secs, 30);
    assert!(!n.tcp_nodelay);
    assert_eq!(n.ip_version, "ipv6");
    assert_eq!(n.local_forwards.len(), 1);
    assert_eq!(n.local_forwards[0].local, "127.0.0.1:5432");
    assert_eq!(n.local_forwards[0].remote, "db.lan:5432");
}

#[test]
fn keepalive_duration_respects_flag_and_interval() {
    let mut n = NetworkSettings::default();
    n.keep_alive = false;
    n.keep_alive_interval_secs = 30;
    assert!(n.keepalive_duration().is_none());

    n.keep_alive = true;
    n.keep_alive_interval_secs = 0;
    assert!(n.keepalive_duration().is_none());

    n.keep_alive_interval_secs = 30;
    assert_eq!(n.keepalive_duration(), Some(Duration::from_secs(30)));
}

#[tokio::test]
async fn establish_transport_rejects_unsupported_proxy_kinds() {
    // `socks4` is no longer offered by the UI but a legacy/hand-crafted
    // value must still be safely rejected rather than mishandled.
    for kind in ["socks4", "unknown-proxy"] {
        let mut n = NetworkSettings::default();
        n.proxy_kind = kind.into();
        n.proxy_host = "127.0.0.1".into();
        n.proxy_port = 1;
        let err = establish_transport("example.com", 22, Some(&n))
            .await
            .expect_err("should reject unsupported proxy kind");
        assert!(err.contains("not implemented"), "got: {}", err);
    }
}

#[tokio::test]
async fn establish_transport_validates_proxy_fields() {
    let mut n = NetworkSettings::default();
    n.proxy_kind = "http".into();
    // empty proxy_host
    n.proxy_host = "".into();
    n.proxy_port = 3128;
    let err = establish_transport("example.com", 22, Some(&n))
        .await
        .expect_err("empty proxy host should error");
    assert!(err.to_lowercase().contains("proxy host"), "got: {}", err);

    n.proxy_host = "127.0.0.1".into();
    n.proxy_port = 0;
    let err = establish_transport("example.com", 22, Some(&n))
        .await
        .expect_err("zero proxy port should error");
    assert!(err.to_lowercase().contains("proxy port"), "got: {}", err);
}

#[tokio::test]
async fn resolve_destination_passes_through_in_auto_mode() {
    let dest = resolve_destination_for_proxy("example.com", 22, "auto")
        .await
        .unwrap();
    assert_eq!(dest, "example.com");
}

#[tokio::test]
async fn resolve_destination_keeps_ip_literals_unchanged() {
    let dest = resolve_destination_for_proxy("203.0.113.5", 22, "ipv4")
        .await
        .unwrap();
    assert_eq!(dest, "203.0.113.5");
}

// -----------------------------------------------------------------------
// Strategy 1: real-server handshake verification.
//
// Stand up an in-process echo server and an in-process proxy (SOCKS5 /
// HTTP CONNECT) that bridges to it, then drive `establish_transport`
// through the proxy and assert a byte round-trips end-to-end. This
// exercises the actual client handshake bytes against a real listener —
// no network, no external services, always runs under `cargo test`.
// -----------------------------------------------------------------------

/// Spawn a loopback TCP echo server. Returns its `(host, port)`.
async fn spawn_echo() -> (String, u16) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                loop {
                    match s.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if s.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    ("127.0.0.1".to_string(), port)
}

/// Spawn a minimal SOCKS5 proxy (no-auth) that connects to whatever target
/// the client requests and pumps bytes both ways. Returns its port.
async fn spawn_socks5_proxy() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = listener.accept().await {
            tokio::spawn(async move {
                // Greeting: VER, NMETHODS, METHODS...
                let mut head = [0u8; 2];
                if c.read_exact(&mut head).await.is_err() {
                    return;
                }
                let mut methods = vec![0u8; head[1] as usize];
                let _ = c.read_exact(&mut methods).await;
                // Select no-auth.
                let _ = c.write_all(&[0x05, 0x00]).await;
                // Request: VER CMD RSV ATYP ...
                let mut req = [0u8; 4];
                if c.read_exact(&mut req).await.is_err() {
                    return;
                }
                let host = match req[3] {
                    0x01 => {
                        let mut a = [0u8; 4];
                        let _ = c.read_exact(&mut a).await;
                        std::net::Ipv4Addr::from(a).to_string()
                    }
                    0x03 => {
                        let mut l = [0u8; 1];
                        let _ = c.read_exact(&mut l).await;
                        let mut d = vec![0u8; l[0] as usize];
                        let _ = c.read_exact(&mut d).await;
                        String::from_utf8_lossy(&d).to_string()
                    }
                    0x04 => {
                        let mut a = [0u8; 16];
                        let _ = c.read_exact(&mut a).await;
                        std::net::Ipv6Addr::from(a).to_string()
                    }
                    _ => return,
                };
                let mut p = [0u8; 2];
                let _ = c.read_exact(&mut p).await;
                let dport = u16::from_be_bytes(p);
                // Reply success with a dummy BND.ADDR.
                let _ = c
                    .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                    .await;
                if let Ok(mut up) = TcpStream::connect((host.as_str(), dport)).await {
                    let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
                }
            });
        }
    });
    port
}

/// Spawn a minimal HTTP CONNECT proxy that tunnels to the requested target.
async fn spawn_http_connect_proxy() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = listener.accept().await {
            tokio::spawn(async move {
                // Read request headers up to CRLFCRLF.
                let mut buf = Vec::new();
                let mut byte = [0u8; 1];
                loop {
                    match c.read(&mut byte).await {
                        Ok(0) | Err(_) => return,
                        Ok(_) => {
                            buf.push(byte[0]);
                            if buf.ends_with(b"\r\n\r\n") {
                                break;
                            }
                            if buf.len() > 8192 {
                                return;
                            }
                        }
                    }
                }
                let text = String::from_utf8_lossy(&buf);
                // First line: "CONNECT host:port HTTP/1.1"
                let target = text
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .map(|s| s.to_string());
                let Some(target) = target else {
                    return;
                };
                let _ = c
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await;
                if let Ok(mut up) = TcpStream::connect(target).await {
                    let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn socks5_handshake_round_trips_through_real_proxy() {
    let (echo_host, echo_port) = spawn_echo().await;
    let proxy_port = spawn_socks5_proxy().await;

    let mut n = NetworkSettings::default();
    n.proxy_kind = "socks5".into();
    n.proxy_host = "127.0.0.1".into();
    n.proxy_port = proxy_port;

    let mut stream = establish_transport(&echo_host, echo_port, Some(&n))
        .await
        .expect("socks5 establish_transport");
    stream.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    stream.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");
}

#[tokio::test]
async fn http_connect_handshake_round_trips_through_real_proxy() {
    let (echo_host, echo_port) = spawn_echo().await;
    let proxy_port = spawn_http_connect_proxy().await;

    let mut n = NetworkSettings::default();
    n.proxy_kind = "http".into();
    n.proxy_host = "127.0.0.1".into();
    n.proxy_port = proxy_port;

    let mut stream = establish_transport(&echo_host, echo_port, Some(&n))
        .await
        .expect("http establish_transport");
    stream.write_all(b"pong").await.unwrap();
    let mut buf = [0u8; 4];
    stream.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"pong");
}

#[tokio::test]
async fn socks5_handshake_with_username_password_auth() {
    // Verify the client speaks user/pass (RFC 1929) when credentials are
    // set: a proxy that *requires* method 0x02 must complete the auth
    // sub-negotiation and then bridge to the target.
    let (echo_host, echo_port) = spawn_echo().await;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let proxy_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut c, _) = listener.accept().await.unwrap();
        let mut head = [0u8; 2];
        c.read_exact(&mut head).await.unwrap();
        let mut methods = vec![0u8; head[1] as usize];
        c.read_exact(&mut methods).await.unwrap();
        assert!(methods.contains(&0x02), "client must offer user/pass");
        // Require user/pass.
        c.write_all(&[0x05, 0x02]).await.unwrap();
        // Auth sub-negotiation: VER=1, ULEN, UNAME, PLEN, PASSWD.
        let mut v = [0u8; 2];
        c.read_exact(&mut v).await.unwrap();
        assert_eq!(v[0], 0x01);
        let mut uname = vec![0u8; v[1] as usize];
        c.read_exact(&mut uname).await.unwrap();
        let mut pl = [0u8; 1];
        c.read_exact(&mut pl).await.unwrap();
        let mut passwd = vec![0u8; pl[0] as usize];
        c.read_exact(&mut passwd).await.unwrap();
        assert_eq!(uname, b"alice");
        assert_eq!(passwd, b"s3cret");
        c.write_all(&[0x01, 0x00]).await.unwrap(); // auth ok
        // Request.
        let mut req = [0u8; 4];
        c.read_exact(&mut req).await.unwrap();
        let host = match req[3] {
            0x01 => {
                let mut a = [0u8; 4];
                c.read_exact(&mut a).await.unwrap();
                std::net::Ipv4Addr::from(a).to_string()
            }
            0x03 => {
                let mut l = [0u8; 1];
                c.read_exact(&mut l).await.unwrap();
                let mut d = vec![0u8; l[0] as usize];
                c.read_exact(&mut d).await.unwrap();
                String::from_utf8_lossy(&d).to_string()
            }
            _ => return,
        };
        let mut p = [0u8; 2];
        c.read_exact(&mut p).await.unwrap();
        let dport = u16::from_be_bytes(p);
        c.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();
        if let Ok(mut up) = TcpStream::connect((host.as_str(), dport)).await {
            let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        }
    });

    let mut n = NetworkSettings::default();
    n.proxy_kind = "socks5".into();
    n.proxy_host = "127.0.0.1".into();
    n.proxy_port = proxy_port;
    n.proxy_user = "alice".into();
    n.proxy_pass = "s3cret".into();

    let mut stream = establish_transport(&echo_host, echo_port, Some(&n))
        .await
        .expect("socks5 auth establish_transport");
    stream.write_all(b"auth").await.unwrap();
    let mut buf = [0u8; 4];
    stream.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"auth");
}
