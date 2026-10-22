use super::authentication::SshAuth;
use super::connection::connect_ssh;
use super::connection::connect_ssh_authenticated_with;
use super::transport::MISSING_JUMP_PASSWORD_ERROR;
use super::transport::build_ssh_transport;
use crate::terminal::network::NetworkSettings;
use tokio::net::TcpStream;

use tokio::time::{Duration, timeout};

fn live_ssh_target() -> Option<(String, u16, String, String)> {
    let host = std::env::var("TAOMNI_LIVE_SSH_HOST").ok()?;
    let username = std::env::var("TAOMNI_LIVE_SSH_USER").ok()?;
    let password = std::env::var("TAOMNI_LIVE_SSH_PASSWORD").ok()?;
    let port = std::env::var("TAOMNI_LIVE_SSH_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(22);
    Some((host, port, username, password))
}

async fn read_until(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    needle: &[u8],
) -> Vec<u8> {
    timeout(Duration::from_secs(12), async {
        let mut transcript = Vec::new();
        while let Some(chunk) = rx.recv().await {
            transcript.extend_from_slice(&chunk);
            if transcript.windows(needle.len()).any(|w| w == needle) {
                return transcript;
            }
        }
        transcript
    })
    .await
    .expect("timed out waiting for SSH terminal output")
}

#[tokio::test]
async fn jump_host_password_auth_requires_non_empty_password() {
    let mut net = NetworkSettings::default();
    net.proxy_kind = "ssh-tunnel".into();
    net.jump_host = "127.0.0.1".into();
    net.jump_port = 22;
    net.jump_user = "ops".into();
    net.jump_auth_kind = "Password".into();

    let err = match build_ssh_transport("example.com", 22, Some(&net)).await {
        Ok(_) => panic!("empty jump password should fail before dialing"),
        Err(err) => err,
    };
    assert!(err.contains(MISSING_JUMP_PASSWORD_ERROR));
}

#[tokio::test]
#[ignore = "requires TAOMNI_LIVE_SSH_HOST/USER/PASSWORD"]
async fn live_terminal_survives_vi_quit_and_followup_input() {
    let Some((host, port, username, password)) = live_ssh_target() else {
        eprintln!("skipping live SSH smoke: TAOMNI_LIVE_SSH_* is not set");
        return;
    };

    let (handle, channel, mut rx) = connect_ssh(
        &host,
        port,
        &username,
        SshAuth::Password(password),
        80,
        24,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("connect live SSH terminal");

    channel
            .data_bytes(b"printf 'TAOMNI_BEFORE_VI\\n'; vi -Nu NONE -n /tmp/taomni-russh-smoke; printf 'TAOMNI_AFTER_VI\\n'\r".to_vec())
            .await
            .expect("start vi smoke");
    let before = read_until(&mut rx, b"TAOMNI_BEFORE_VI").await;
    assert!(
        before
            .windows(b"TAOMNI_BEFORE_VI".len())
            .any(|w| w == b"TAOMNI_BEFORE_VI"),
        "did not see pre-vi marker"
    );

    channel
        .data_bytes(b":q!\r".to_vec())
        .await
        .expect("quit vi");
    let after = read_until(&mut rx, b"TAOMNI_AFTER_VI").await;
    assert!(
        after
            .windows(b"TAOMNI_AFTER_VI".len())
            .any(|w| w == b"TAOMNI_AFTER_VI"),
        "did not return from vi"
    );

    channel
        .data_bytes(b"printf 'TAOMNI_STILL_RESPONSIVE\\n'\r".to_vec())
        .await
        .expect("write after vi");
    let still_responsive = read_until(&mut rx, b"TAOMNI_STILL_RESPONSIVE").await;
    assert!(
        still_responsive
            .windows(b"TAOMNI_STILL_RESPONSIVE".len())
            .any(|w| w == b"TAOMNI_STILL_RESPONSIVE"),
        "terminal did not accept follow-up input after vi"
    );

    drop(channel);
    drop(handle);
}

// -----------------------------------------------------------------------
// Strategy 2: drive a real SSH connection through an in-process proxy
// bridging to the live target. Verifies the proxy → SSH handshake path
// end-to-end against a real server. Requires TAOMNI_LIVE_SSH_*.
// -----------------------------------------------------------------------

/// In-process no-auth SOCKS5 proxy that connects to whatever target the
/// client requests and pumps bytes both ways. Returns the listening port.
async fn spawn_socks5_bridge() -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut head = [0u8; 2];
                if c.read_exact(&mut head).await.is_err() {
                    return;
                }
                let mut methods = vec![0u8; head[1] as usize];
                let _ = c.read_exact(&mut methods).await;
                let _ = c.write_all(&[0x05, 0x00]).await;
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

#[tokio::test]
#[ignore = "requires TAOMNI_LIVE_SSH_HOST/USER/PASSWORD"]
async fn live_ssh_through_socks5_proxy() {
    let Some((host, port, username, password)) = live_ssh_target() else {
        eprintln!("skipping: TAOMNI_LIVE_SSH_* is not set");
        return;
    };
    let proxy_port = spawn_socks5_bridge().await;

    let mut net = NetworkSettings::default();
    net.proxy_kind = "socks5".into();
    net.proxy_host = "127.0.0.1".into();
    net.proxy_port = proxy_port;

    let handle = connect_ssh_authenticated_with(
        &host,
        port,
        &username,
        SshAuth::Password(password),
        Some(&net),
    )
    .await
    .expect("authenticate over socks5 proxy to live SSH");
    drop(handle);
}

/// Live SSH jump-host test. Requires the live SSH target as the jump host
/// plus `TAOMNI_INTERNAL_HOST` (and optional `TAOMNI_INTERNAL_PORT`,
/// default 22) reachable *from* that jump host — typically a private-network
/// address only the jump host can route to. Credentials for the inner
/// target reuse the same TAOMNI_LIVE_SSH_USER/PASSWORD by default, or
/// TAOMNI_INTERNAL_USER/PASSWORD when set.
#[tokio::test]
#[ignore = "requires TAOMNI_LIVE_SSH_* + TAOMNI_INTERNAL_HOST"]
async fn live_ssh_through_jump_host() {
    let Some((jump_host, jump_port, jump_user, jump_pass)) = live_ssh_target() else {
        eprintln!("skipping: TAOMNI_LIVE_SSH_* is not set");
        return;
    };
    let Ok(inner_host) = std::env::var("TAOMNI_INTERNAL_HOST") else {
        eprintln!("skipping: TAOMNI_INTERNAL_HOST is not set");
        return;
    };
    let inner_port = std::env::var("TAOMNI_INTERNAL_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(22);
    let inner_user = std::env::var("TAOMNI_INTERNAL_USER").unwrap_or(jump_user.clone());
    let inner_pass = std::env::var("TAOMNI_INTERNAL_PASSWORD").unwrap_or(jump_pass.clone());

    let mut net = NetworkSettings::default();
    net.proxy_kind = "ssh-tunnel".into();
    net.jump_host = jump_host;
    net.jump_port = jump_port;
    net.jump_user = jump_user;
    net.jump_auth_kind = "Password".into();
    net.jump_password = jump_pass;

    let handle = connect_ssh_authenticated_with(
        &inner_host,
        inner_port,
        &inner_user,
        SshAuth::Password(inner_pass),
        Some(&net),
    )
    .await
    .expect("authenticate to internal host through SSH jump");
    drop(handle);
}
