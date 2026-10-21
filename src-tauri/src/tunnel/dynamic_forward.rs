use super::credentials::ssh_auth_from;
use super::local_forward::bridge_stream_channel;
use super::model::TunnelConfig;
use super::model::TunnelStatus;
use super::model::TunnelStatusInfo;
use super::registry::TunnelRegistry;
use super::registry::set_status;
use crate::terminal::ssh::SshHandler;
use crate::terminal::ssh::connect_ssh_authenticated;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

/* ---------------------------- Dynamic SOCKS5 ------------------------ */

pub(super) async fn run_dynamic_forward(
    app: AppHandle,
    registry: Arc<TunnelRegistry>,
    bridges: Arc<AsyncMutex<Vec<JoinHandle<()>>>>,
    config: TunnelConfig,
) -> Result<(), String> {
    let listener = TcpListener::bind((config.listen_host.as_str(), config.listen_port))
        .await
        .map_err(|e| format!("bind {}:{}: {}", config.listen_host, config.listen_port, e))?;

    let auth = ssh_auth_from(&config.ssh)?;
    let handle = connect_ssh_authenticated(
        &config.ssh.host,
        config.ssh.port,
        &config.ssh.username,
        auth,
    )
    .await?;
    let handle = Arc::new(handle);

    set_status(
        &app,
        &registry,
        TunnelStatusInfo {
            id: config.id.clone(),
            status: TunnelStatus::Running,
            error: None,
            active_connections: Some(0),
        },
    )
    .await;

    let id = config.id.clone();
    loop {
        let (mut stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("socks {}: accept: {}", id, e);
                continue;
            }
        };
        let h = handle.clone();
        let task = tokio::spawn(async move {
            if let Err(e) = handle_socks5(&mut stream, peer, h).await {
                tracing::debug!("socks5 client ended: {}", e);
            }
        });
        bridges.lock().await.push(task);
    }
}

pub(super) async fn handle_socks5(
    stream: &mut tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    ssh: Arc<russh::client::Handle<SshHandler>>,
) -> Result<(), String> {
    // --- greeting ---
    let mut greet = [0u8; 2];
    stream
        .read_exact(&mut greet)
        .await
        .map_err(|e| e.to_string())?;
    if greet[0] != 0x05 {
        return Err("not a SOCKS5 client".to_string());
    }
    let mut methods = vec![0u8; greet[1] as usize];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| e.to_string())?;
    // We support "no authentication" (0x00) only.
    stream
        .write_all(&[0x05, 0x00])
        .await
        .map_err(|e| e.to_string())?;

    // --- request ---
    let mut req = [0u8; 4];
    stream
        .read_exact(&mut req)
        .await
        .map_err(|e| e.to_string())?;
    if req[0] != 0x05 {
        return Err("bad SOCKS5 request".to_string());
    }
    if req[1] != 0x01 {
        // CONNECT only
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err("only CONNECT is supported".to_string());
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            std::net::IpAddr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| e.to_string())?;
            let mut name = vec![0u8; len[0] as usize];
            stream
                .read_exact(&mut name)
                .await
                .map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&name).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            std::net::IpAddr::from(a).to_string()
        }
        _ => {
            let _ = stream
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err("unknown ATYP".to_string());
        }
    };
    let mut port_bytes = [0u8; 2];
    stream
        .read_exact(&mut port_bytes)
        .await
        .map_err(|e| e.to_string())?;
    let port = u16::from_be_bytes(port_bytes);

    let originator = peer.ip().to_string();
    let originator_port = peer.port() as u32;
    let channel = match ssh
        .channel_open_direct_tcpip(
            host.as_str(),
            port as u32,
            originator.as_str(),
            originator_port,
        )
        .await
    {
        Ok(c) => c,
        Err(e) => {
            // 0x05 = connection refused
            let _ = stream
                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err(format!("ssh open: {}", e));
        }
    };
    // success reply (BND.ADDR/PORT zeroed)
    stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| e.to_string())?;

    bridge_stream_channel(stream, channel).await
}
