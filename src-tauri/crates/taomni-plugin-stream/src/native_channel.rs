//! Single-peer loopback connection with the same native authentication and
//! per-message limits as a binary offer. The caller owns the connection lifetime.
use std::{net::Ipv4Addr, time::Duration};

use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use taomni_plugin_api::{ErrorCode, RpcError};
use tokio::{
    net::{TcpListener, TcpStream},
    time,
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config, client_async_with_config,
    tungstenite::{Bytes, Message, client::IntoClientRequest, http::HeaderValue},
};

use crate::{error, handshake, sender::hex};

const CONNECT_WINDOW: Duration = Duration::from_secs(5);
const PATH_PREFIX: &str = "/frames/";

/// Pass this descriptor privately to the child, for example over inherited stdin.
#[derive(Deserialize, Serialize)]
pub struct Endpoint {
    port: u16,
    path: String,
    token: String,
}

impl Endpoint {
    fn validate(&self) -> Result<(), RpcError> {
        let is_nonce =
            |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
        if self.port == 0
            || !self.path.strip_prefix(PATH_PREFIX).is_some_and(is_nonce)
            || !is_nonce(&self.token)
        {
            return Err(error(
                ErrorCode::InvalidParams,
                "Invalid native channel endpoint",
            ));
        }
        Ok(())
    }

    fn bearer(&self) -> Result<HeaderValue, RpcError> {
        HeaderValue::from_str(&format!("Bearer {}", self.token)).map_err(|_| {
            error(
                ErrorCode::InvalidParams,
                "Invalid native channel capability",
            )
        })
    }
}

pub struct Offer {
    listener: TcpListener,
    endpoint: Endpoint,
}

impl Offer {
    pub async fn bind() -> Result<Self, RpcError> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| io_error())?;
        let port = listener.local_addr().map_err(|_| io_error())?.port();
        let mut random = [0; 64];
        rand::rng().fill_bytes(&mut random);
        let endpoint = Endpoint {
            port,
            path: format!("{PATH_PREFIX}{}", hex(&random[..32])),
            token: hex(&random[32..]),
        };
        Ok(Self { listener, endpoint })
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    pub async fn accept(self) -> Result<Channel, RpcError> {
        let authority = self
            .listener
            .local_addr()
            .map_err(|_| io_error())?
            .to_string();
        let bearer = self.endpoint.bearer()?;
        time::timeout(CONNECT_WINDOW, async {
            loop {
                let (stream, peer) = self.listener.accept().await.map_err(|_| io_error())?;
                if !peer.ip().is_loopback() {
                    continue;
                }
                stream.set_nodelay(true).map_err(|_| io_error())?;
                let callback = handshake::Authorization {
                    authority: &authority,
                    path: &self.endpoint.path,
                    bearer: &bearer,
                };
                if let Ok(Ok(socket)) = time::timeout(
                    Duration::from_millis(250),
                    accept_hdr_async_with_config(stream, callback, Some(handshake::config())),
                )
                .await
                {
                    return Ok(Channel(socket));
                }
            }
        })
        .await
        .map_err(|_| timeout_error())?
    }
}

pub struct Channel(WebSocketStream<TcpStream>);

impl Channel {
    pub async fn connect(endpoint: Endpoint) -> Result<Self, RpcError> {
        endpoint.validate()?;
        let url = format!("ws://127.0.0.1:{}{}", endpoint.port, endpoint.path);
        let mut request = url
            .into_client_request()
            .map_err(|_| error(ErrorCode::InvalidParams, "Invalid native channel endpoint"))?;
        request
            .headers_mut()
            .insert("authorization", endpoint.bearer()?);
        time::timeout(CONNECT_WINDOW, async {
            let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, endpoint.port))
                .await
                .map_err(|_| io_error())?;
            stream.set_nodelay(true).map_err(|_| io_error())?;
            let (socket, _) = client_async_with_config(request, stream, Some(handshake::config()))
                .await
                .map_err(|_| io_error())?;
            Ok(Self(socket))
        })
        .await
        .map_err(|_| timeout_error())?
    }

    pub async fn send(&mut self, data: Bytes) -> Result<(), RpcError> {
        if data.len() > crate::CHUNK_BYTES {
            return Err(error(
                ErrorCode::InvalidParams,
                "Native channel message exceeds limit",
            ));
        }
        self.0
            .send(Message::Binary(data))
            .await
            .map_err(|_| io_error())
    }

    pub async fn receive(&mut self) -> Result<Option<Bytes>, RpcError> {
        match self.0.next().await {
            Some(Ok(Message::Binary(bytes))) => Ok(Some(bytes)),
            Some(Ok(Message::Close(_))) => Ok(None),
            _ => Err(io_error()),
        }
    }

    pub async fn close(mut self) -> Result<(), RpcError> {
        self.0.close(None).await.map_err(|_| io_error())
    }
}

fn io_error() -> RpcError {
    error(
        ErrorCode::InternalError,
        "Native channel closed or rejected",
    )
}

fn timeout_error() -> RpcError {
    error(
        ErrorCode::RequestTimeout,
        "Native channel connection timed out",
    )
}

#[test]
fn descriptor_requires_a_loopback_port_and_exact_hex_path_and_token() {
    let mut endpoint = Endpoint {
        port: 1234,
        path: format!("{PATH_PREFIX}{}", "a".repeat(64)),
        token: "b".repeat(64),
    };
    endpoint.validate().unwrap();
    endpoint.path.push_str("?other=1");
    assert!(endpoint.validate().is_err());
    endpoint.path.truncate(PATH_PREFIX.len() + 64);
    endpoint.token.pop();
    endpoint.token.push('\r');
    assert!(endpoint.validate().is_err());
    endpoint.token = "b".repeat(64);
    endpoint.port = 0;
    assert!(endpoint.validate().is_err());
}
