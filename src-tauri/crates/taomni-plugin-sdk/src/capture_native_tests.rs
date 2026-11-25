//! Real SDK receiver boundaries. These tests use sockets and only run on CI.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    net::{TcpListener, TcpStream},
    thread::JoinHandle,
};
use taomni_plugin_api::{BinaryRef, ErrorCode};
use tokio_tungstenite::tungstenite::{
    Error as WebSocketError, Message, WebSocket, accept,
    error::ProtocolError,
    protocol::{CloseFrame, frame::coding::CloseCode},
};

struct Peer {
    listener: TcpListener,
    descriptor: BinaryRef,
}

impl Peer {
    fn new(bytes: &[u8]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let descriptor = BinaryRef {
            stream_url: format!("ws://{}/capture", listener.local_addr().unwrap()),
            token: "native-sdk-fixture".into(),
            content_type: LUMA_FRAMES_CONTENT_TYPE.into(),
            byte_len: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        };
        Self {
            listener,
            descriptor,
        }
    }

    fn connect(self) -> WebSocket<TcpStream> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match self.listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "SDK did not connect");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("native fixture accept failed: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        accept(stream).unwrap()
    }
}

fn luma() -> Vec<u8> {
    encode_luma_frames(&[LumaFrameRef {
        width: 4,
        height: 3,
        luma: &[7; 12],
    }])
    .unwrap()
}

fn receiver(
    descriptor: BinaryRef,
    deadline: Instant,
) -> (
    Arc<Operation>,
    mpsc::Receiver<Result<Vec<u8>, taomni_plugin_api::RpcError>>,
    JoinHandle<()>,
) {
    let (output, requests) = mpsc::sync_channel(8);
    let client = ServiceClient::new(output);
    let operation = Arc::new(Operation::new(Some(context()), deadline, client.clone()));
    let worker = operation.clone();
    let (sender, result) = mpsc::sync_channel(1);
    let task = std::thread::spawn(move || {
        sender.send(worker.capture_still()).unwrap();
    });
    let request = take_request(&requests);
    assert_eq!(request.method, CAPTURE_STILL_METHOD);
    let mut bytes = SensitiveRpcResponse::success(
        request.id,
        CaptureStillResult {
            context: context(),
            binary: descriptor,
        },
    )
    .encode_line()
    .unwrap();
    client.deliver(&mut bytes).unwrap();
    assert!(bytes.is_empty());
    (operation, result, task)
}

fn assert_peer_closed(socket: &mut WebSocket<TcpStream>) {
    // The peer observes actual TCP closure. A timeout is a failed cleanup,
    // even if Operation::check_current already reports cancellation/deadline.
    match socket.read() {
        Ok(Message::Close(_)) | Err(WebSocketError::ConnectionClosed) => (),
        Err(WebSocketError::Protocol(ProtocolError::ResetWithoutClosingHandshake)) => (),
        Err(WebSocketError::Io(error)) => assert!(
            matches!(
                error.kind(),
                io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::BrokenPipe
            ),
            "SDK socket did not close: {error}"
        ),
        other => panic!("SDK socket did not close: {other:?}"),
    }
}

fn stalled_capture(cancel: bool) {
    let bytes = luma();
    let peer = Peer::new(&bytes);
    let descriptor = peer.descriptor.clone();
    let (ready, connected) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        let mut socket = peer.connect();
        // Send a real prefix, then deliberately hold the remaining pixels.
        socket
            .send(Message::Binary(bytes[..8].to_vec().into()))
            .unwrap();
        ready.send(()).unwrap();
        assert_peer_closed(&mut socket);
    });
    let deadline = Instant::now() + Duration::from_secs(if cancel { 5 } else { 2 });
    let (operation, result, worker) = receiver(descriptor, deadline);
    connected.recv_timeout(Duration::from_secs(3)).unwrap();
    let started = Instant::now();
    if cancel {
        operation.cancel();
    }
    let error = result
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap_err();
    assert_eq!(
        error.code,
        if cancel {
            ErrorCode::RequestCancelled as i32
        } else {
            ErrorCode::RequestTimeout as i32
        }
    );
    if cancel {
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "SDK ignored cancellation while reading pixels"
        );
    } else {
        assert!(
            Instant::now() >= deadline,
            "SDK returned before its original deadline"
        );
        assert!(
            Instant::now() < deadline + Duration::from_secs(1),
            "SDK restarted its timeout for binary reception"
        );
    }
    worker.join().unwrap();
    server.join().unwrap();
}

#[test]
#[ignore = "real SDK socket receive: GitHub only"]
fn cancellation_while_receiving_pixels_closes_the_actual_sdk_connection() {
    stalled_capture(true);
}

#[test]
#[ignore = "real SDK socket receive: GitHub only"]
fn original_operation_deadline_also_ends_a_partially_received_capture() {
    stalled_capture(false);
}

#[test]
#[ignore = "real SDK socket receive: GitHub only"]
fn a_complete_hash_valid_but_malformed_luma_container_is_never_returned_to_business_code() {
    let mut bytes = luma();
    bytes[8..12].fill(0); // zero width; the descriptor hashes these actual bytes
    let peer = Peer::new(&bytes);
    let descriptor = peer.descriptor.clone();
    let server = std::thread::spawn(move || {
        let mut socket = peer.connect();
        socket.send(Message::Binary(bytes.into())).unwrap();
        socket
            .close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "".into(),
            }))
            .unwrap();
    });
    let (_, result, worker) = receiver(descriptor, Instant::now() + Duration::from_secs(5));
    assert_eq!(
        result
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::InvalidParams as i32,
    );
    worker.join().unwrap();
    server.join().unwrap();
}
