use super::limits::MAX_FRAME_LEN;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::wire;
use futures::SinkExt;
use futures::StreamExt;
use serde_json::json;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio_util::codec::Framed;
use tokio_util::codec::LengthDelimitedCodec;

/// A length-delimited codec with our explicit frame-length cap.
pub(super) fn new_codec() -> LengthDelimitedCodec {
    let mut codec = LengthDelimitedCodec::new();
    codec.set_max_frame_length(MAX_FRAME_LEN);
    codec
}

pub(super) type LanFramed<T> = Framed<T, LengthDelimitedCodec>;

pub(super) async fn send_frame<T: AsyncWrite + Unpin>(
    framed: &mut LanFramed<T>,
    env: &Envelope,
) -> Result<(), String> {
    let json = env.encode().map_err(|e| e.to_string())?;
    framed
        .send(wire::frame_control(&json))
        .await
        .map_err(|e| e.to_string())
}

pub(super) async fn recv_frame<T: AsyncRead + Unpin>(
    framed: &mut LanFramed<T>,
) -> Result<Envelope, String> {
    match framed.next().await {
        Some(Ok(buf)) => match wire::decode_frame(&buf) {
            Some(wire::Frame::Control(env)) => Ok(env),
            Some(wire::Frame::Piece(..)) => Err("unexpected binary frame during handshake".into()),
            Some(wire::Frame::Media(..)) => Err("unexpected media frame during handshake".into()),
            None => Err("undecodable frame".into()),
        },
        Some(Err(e)) => Err(e.to_string()),
        None => Err("connection closed during handshake".into()),
    }
}
