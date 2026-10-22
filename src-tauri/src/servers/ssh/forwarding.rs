use crate::servers::engine::LogEmitter;
use russh::Channel;
use russh::server::Msg;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Normalize the address string from a `tcpip-forward` request into something
/// `TcpListener::bind` accepts. OpenSSH clients commonly send `""`,
/// `"localhost"`, `"127.0.0.1"`, or `"0.0.0.0"`.
pub(super) fn resolve_listen_addr(address: &str) -> String {
    match address.trim() {
        "" | "*" => "0.0.0.0".to_string(),
        "localhost" => "127.0.0.1".to_string(),
        other => other.to_string(),
    }
}

pub(super) fn is_loopback_addr(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "localhost" | "0:0:0:0:0:0:0:1")
}

/// Bidirectional byte bridge between a TCP socket and an SSH channel stream.
/// Exits when either side closes, the cancel token fires, or an I/O error occurs.
pub(super) async fn bridge_tcp_and_channel(
    mut tcp: TcpStream,
    channel: Channel<Msg>,
    cancel: CancellationToken,
    log: LogEmitter,
    label: String,
) {
    let mut stream = channel.into_stream();
    tokio::select! {
        _ = cancel.cancelled() => {
            let _ = tcp.shutdown().await;
            log.line(format!("{} stopped (server cancel)", label));
        }
        res = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => {
            match res {
                // copy_bidirectional(tcp, stream): (tcp→stream, stream→tcp)
                Ok((to_client, to_remote)) => {
                    log.line(format!(
                        "{} closed ({} B → client, {} B → remote)",
                        label, to_client, to_remote
                    ));
                }
                Err(e) => {
                    log.line(format!("{} bridge error: {}", label, e));
                }
            }
        }
    }
}
