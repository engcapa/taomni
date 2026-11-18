use std::{net::Ipv4Addr, time::Duration};

use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::{
    net::{TcpListener, TcpStream},
    time,
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config, client_async_with_config,
    tungstenite::{Bytes, Message, client::IntoClientRequest, http::HeaderValue},
};

use crate::{CHUNK_BYTES, handshake, sender::hex};

use super::{FRAME_COUNT, Frame, Workload, pixels_for};

pub(super) type Socket = WebSocketStream<TcpStream>;

#[derive(Deserialize, Serialize)]
pub(super) struct Input {
    port: u16,
    path: String,
    token: String,
    workload: Workload,
}

fn random_hex() -> String {
    let mut bytes = [0; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex(&bytes)
}

pub(super) async fn bind(workload: Workload) -> (TcpListener, Input) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let input = Input {
        port: listener.local_addr().unwrap().port(),
        path: format!("/frames/{}", random_hex()),
        token: random_hex(),
        workload,
    };
    (listener, input)
}

fn bearer(input: &Input) -> HeaderValue {
    HeaderValue::from_str(&format!("Bearer {}", input.token)).expect("random hex bearer")
}

pub(super) async fn accept(listener: TcpListener, input: &Input) -> Socket {
    let authority = listener.local_addr().unwrap().to_string();
    let bearer = bearer(input);
    time::timeout(Duration::from_secs(5), async {
        loop {
            let (stream, peer) = listener.accept().await.unwrap();
            assert!(peer.ip().is_loopback());
            stream.set_nodelay(true).unwrap();
            let callback = handshake::Authorization {
                authority: &authority,
                path: &input.path,
                bearer: &bearer,
            };
            if let Ok(Ok(socket)) = time::timeout(
                Duration::from_millis(250),
                accept_hdr_async_with_config(stream, callback, Some(handshake::config())),
            )
            .await
            {
                return socket;
            }
        }
    })
    .await
    .expect("child must connect to the frame listener")
}

pub(super) async fn deliver(socket: &mut Socket, frame: &Frame) {
    let header = frame.sequence.to_le_bytes();
    socket
        .send(Message::Binary(header.to_vec().into()))
        .await
        .unwrap();
    let mut offset = 0;
    while offset < frame.pixels.len() {
        let end = (offset + CHUNK_BYTES).min(frame.pixels.len());
        socket
            .send(Message::Binary(frame.pixels.slice(offset..end)))
            .await
            .unwrap();
        offset = end;
    }
    assert_eq!(binary(socket).await.unwrap().as_ref(), header);
}

async fn binary(socket: &mut Socket) -> Option<Bytes> {
    match socket.next().await.expect("open frame stream").unwrap() {
        Message::Binary(bytes) => Some(bytes),
        Message::Close(_) => None,
        _ => panic!("unexpected message on frame stream"),
    }
}

pub(super) async fn receive(input: Input) {
    let url = format!("ws://127.0.0.1:{}{}", input.port, input.path);
    let mut request = url.into_client_request().expect("frame URL");
    request
        .headers_mut()
        .insert("authorization", bearer(&input));
    let patterns = input.workload.pixels();
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, input.port))
        .await
        .unwrap();
    stream.set_nodelay(true).unwrap();
    let (mut socket, _) = client_async_with_config(request, stream, Some(handshake::config()))
        .await
        .expect("authenticate frame receiver");
    let mut pixels = vec![0; input.workload.byte_len()];
    let mut previous = None;
    while let Some(header) = binary(&mut socket).await {
        let sequence = u64::from_le_bytes(header.as_ref().try_into().expect("frame sequence"));
        assert!(sequence < FRAME_COUNT);
        assert!(previous.is_none_or(|previous| previous < sequence));
        for output in pixels.chunks_mut(CHUNK_BYTES) {
            let chunk = binary(&mut socket).await.expect("complete frame");
            output.copy_from_slice(&chunk);
        }
        assert!(pixels.as_slice() == pixels_for(&patterns, sequence).as_ref());
        previous = Some(sequence);
        socket.send(Message::Binary(header)).await.unwrap();
    }
    assert_eq!(previous, Some(FRAME_COUNT - 1));
}
