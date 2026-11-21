//! A TCP route provided by the core to an independent module host. Each stream
//! uses a fresh mutual handshake and reaches the same core-approved destination.

use std::{
    future::Future,
    io,
    net::{Ipv4Addr, SocketAddr},
    time::Duration,
};

use rand::RngCore;
use ring::hmac;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{self as transport, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use zeroize::Zeroizing;

use crate::CancellationToken;

const KEY_LEN: usize = 32;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const ROUTE_TIMEOUT: Duration = Duration::from_secs(50);
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const SERVER_PROOF: u8 = 1;
const CLIENT_PROOF: u8 = 2;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    port: u16,
    key: Zeroizing<[u8; KEY_LEN]>,
}

pub struct Route {
    task: JoinHandle<()>,
    closed: CancellationToken,
}

impl Drop for Route {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Route {
    pub fn closed(&self) -> CancellationToken {
        self.closed.clone()
    }

    pub async fn bind<Stream, Dial, Opening>(mut dial: Dial) -> io::Result<(Self, Endpoint)>
    where
        Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        Dial: FnMut() -> Opening + Send + 'static,
        Opening: Future<Output = Result<(Stream, SocketAddr), String>> + Send,
    {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let mut key = Zeroizing::new([0; KEY_LEN]);
        rand::rng().fill_bytes(key.as_mut());
        let endpoint = Endpoint {
            port: listener.local_addr()?.port(),
            key,
        };
        let key = hmac::Key::new(hmac::HMAC_SHA256, endpoint.key.as_ref());
        let closed = CancellationToken::new();
        let on_exit = closed.clone().drop_guard();
        let task = tokio::spawn(async move {
            let _on_exit = on_exit;
            let mut deadline = Instant::now() + IDLE_TIMEOUT;
            while let Ok(Ok((mut peer, _))) = timeout_at(deadline, listener.accept()).await {
                let handshake_deadline = deadline.min(Instant::now() + HANDSHAKE_TIMEOUT);
                if timeout_at(handshake_deadline, authenticate_server(&mut peer, &key))
                    .await
                    .is_ok_and(|result| result.is_ok())
                {
                    let _ = serve(&mut peer, &mut dial).await;
                    deadline = Instant::now() + IDLE_TIMEOUT;
                }
            }
        });
        Ok((Self { task, closed }, endpoint))
    }
}

impl Endpoint {
    pub async fn connect(&self) -> Result<(TcpStream, SocketAddr), String> {
        let mut stream = timeout(
            HANDSHAKE_TIMEOUT,
            TcpStream::connect((Ipv4Addr::LOCALHOST, self.port)),
        )
        .await
        .map_err(|_| "Module TCP route listener timed out".to_string())?
        .map_err(|error| format!("Module TCP route listener: {error}"))?;
        stream
            .set_nodelay(true)
            .map_err(|error| error.to_string())?;

        let key = hmac::Key::new(hmac::HMAC_SHA256, self.key.as_ref());
        timeout(HANDSHAKE_TIMEOUT, authenticate_client(&mut stream, &key))
            .await
            .map_err(|_| "Module TCP route handshake timed out".to_string())?
            .map_err(|error| format!("Module TCP route handshake: {error}"))?;
        let local_addr = timeout(ROUTE_TIMEOUT, read_route_address(&mut stream))
            .await
            .map_err(|_| "Module TCP route setup timed out".to_string())?
            .map_err(|error| format!("Module TCP route setup: {error}"))??;
        Ok((stream, local_addr))
    }
}

async fn serve<Stream, Dial, Opening>(peer: &mut TcpStream, dial: &mut Dial) -> io::Result<()>
where
    Stream: AsyncRead + AsyncWrite + Unpin,
    Dial: FnMut() -> Opening,
    Opening: Future<Output = Result<(Stream, SocketAddr), String>>,
{
    let upstream = tokio::select! {
        result = timeout(ROUTE_TIMEOUT, dial()) => result?,
        _ = peer.read_u8() => return Ok(()),
    };
    let (mut upstream, address) = match upstream {
        Ok(connected) => connected,
        Err(error) => return send_route_address(peer, Err(error)).await,
    };
    send_route_address(peer, Ok(address)).await?;

    let (mut local_read, mut local_write) = peer.split();
    let (mut upstream_read, mut upstream_write) = transport::split(&mut upstream);
    tokio::select! {
        result = transport::copy(&mut local_read, &mut upstream_write) => result.map(|_| ()),
        result = transport::copy(&mut upstream_read, &mut local_write) => result.map(|_| ()),
    }
}

async fn authenticate_server(stream: &mut TcpStream, key: &hmac::Key) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let mut transcript = [0; 1 + 2 * KEY_LEN];
    transcript[0] = SERVER_PROOF;
    stream.read_exact(&mut transcript[1..1 + KEY_LEN]).await?;
    rand::rng().fill_bytes(&mut transcript[1 + KEY_LEN..]);
    stream.write_all(&transcript[1 + KEY_LEN..]).await?;
    stream
        .write_all(hmac::sign(key, &transcript).as_ref())
        .await?;
    let mut proof = [0; KEY_LEN];
    stream.read_exact(&mut proof).await?;
    transcript[0] = CLIENT_PROOF;
    verify(key, &transcript, &proof)
}

async fn authenticate_client(stream: &mut TcpStream, key: &hmac::Key) -> io::Result<()> {
    let mut transcript = [0; 1 + 2 * KEY_LEN];
    transcript[0] = SERVER_PROOF;
    rand::rng().fill_bytes(&mut transcript[1..1 + KEY_LEN]);
    stream.write_all(&transcript[1..1 + KEY_LEN]).await?;
    stream.read_exact(&mut transcript[1 + KEY_LEN..]).await?;
    let mut proof = [0; KEY_LEN];
    stream.read_exact(&mut proof).await?;
    verify(key, &transcript, &proof)?;
    transcript[0] = CLIENT_PROOF;
    stream
        .write_all(hmac::sign(key, &transcript).as_ref())
        .await
}

fn verify(key: &hmac::Key, transcript: &[u8], proof: &[u8]) -> io::Result<()> {
    hmac::verify(key, transcript, proof)
        .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "Invalid route proof"))
}

async fn send_route_address(
    stream: &mut TcpStream,
    result: Result<SocketAddr, String>,
) -> io::Result<()> {
    let mut payload = serde_json::to_vec(&result)?;
    if payload.len() > MAX_RESPONSE_BYTES {
        payload = serde_json::to_vec(&Err::<SocketAddr, _>("Module TCP route setup failed"))?;
    }
    timeout(HANDSHAKE_TIMEOUT, async {
        stream.write_u16(payload.len() as u16).await?;
        stream.write_all(&payload).await
    })
    .await?
}

async fn read_route_address(stream: &mut TcpStream) -> io::Result<Result<SocketAddr, String>> {
    let size = stream.read_u16().await? as usize;
    if size > MAX_RESPONSE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Module TCP route response exceeds the limit",
        ));
    }
    let mut payload = vec![0; size];
    stream.read_exact(&mut payload).await?;
    Ok(serde_json::from_slice(&payload)?)
}

#[cfg(test)]
#[path = "routed_tcp_tests.rs"]
mod tests;
