use super::credentials::ssh_auth_from;
use super::model::TunnelConfig;
use super::model::TunnelStatus;
use super::model::TunnelStatusInfo;
use super::registry::TunnelRegistry;
use super::registry::set_status;
use crate::terminal::ssh::connect_ssh_authenticated;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

/* ---------------------------- Local forwarder ----------------------- */

pub(super) async fn run_local_forward(
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

    let dest_host = config.dest_host.clone();
    let dest_port = config.dest_port;
    let id = config.id.clone();
    loop {
        let (mut stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("tunnel {}: accept failed: {}", id, e);
                continue;
            }
        };
        let h = handle.clone();
        let dh = dest_host.clone();
        let dp = dest_port;
        let task = tokio::spawn(async move {
            let originator = peer.ip().to_string();
            let originator_port = peer.port() as u32;
            let channel = match h
                .channel_open_direct_tcpip(
                    dh.as_str(),
                    dp as u32,
                    originator.as_str(),
                    originator_port,
                )
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("direct-tcpip open failed: {}", e);
                    let _ = stream.shutdown().await;
                    return;
                }
            };
            if let Err(e) = bridge_stream_channel(&mut stream, channel).await {
                tracing::debug!("bridge ended: {}", e);
            }
        });
        bridges.lock().await.push(task);
    }
}

pub(super) async fn bridge_stream_channel(
    stream: &mut tokio::net::TcpStream,
    mut channel: russh::Channel<russh::client::Msg>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt as _;
    let (mut rx, mut tx) = stream.split();

    let mut buf = vec![0u8; 16 * 1024];
    let mut local_eof = false;
    let mut remote_eof = false;
    while !(local_eof && remote_eof) {
        tokio::select! {
            n = rx.read(&mut buf), if !local_eof => {
                let n = n.map_err(|e| format!("local read: {}", e))?;
                if n == 0 {
                    local_eof = true;
                    let _ = channel.eof().await;
                } else if let Err(e) = channel.data(&buf[..n]).await {
                    return Err(format!("ssh write: {}", e));
                }
            }
            msg = channel.wait(), if !remote_eof => {
                use russh::ChannelMsg;
                let Some(m) = msg else { remote_eof = true; let _ = tx.shutdown().await; continue; };
                match m {
                    ChannelMsg::Data { data } => {
                        tx.write_all(&data).await.map_err(|e| format!("local write: {}", e))?;
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        tx.write_all(&data).await.map_err(|e| format!("local write: {}", e))?;
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => {
                        remote_eof = true;
                        let _ = tx.shutdown().await;
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}
use tokio::io::AsyncReadExt;
