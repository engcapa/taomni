use super::connection::duplicate_replaces_existing;
use super::framing::new_codec;
use super::handshake::handshake;
use super::limits::MEDIA_QUEUE_CAP;
use super::outgoing::MediaQueue;
use crate::lanchat::identity;
use crate::lanchat::protocol::Envelope;
use crate::lanchat::protocol::frame;
use crate::lanchat::protocol::wire;
use crate::lanchat::tls;
use futures::SinkExt;
use futures::StreamExt;
use serde_json::json;
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::TlsConnector;
use tokio_rustls::TlsStream;
use tokio_util::codec::Framed;
use tokio_util::codec::LengthDelimitedCodec;

use tokio::net::TcpListener;

#[test]
fn glare_tie_break_keeps_same_connection_on_both_ends() {
    // Two peers, lexically "aaa" < "bbb". Glare creates two connections:
    // X dialed by "aaa" (inbound on "bbb"), Y dialed by "bbb" (inbound on "aaa").
    // Whatever the local registration order, both ends must keep the *same*
    // physical connection — the one dialed by the min id ("aaa", via X).
    let (lo, hi) = ("aaa", "bbb");
    // On lo's side (my=lo, peer=hi): X is outbound, Y is inbound.
    assert!(
        duplicate_replaces_existing(true, false, lo, hi),
        "lo: X replaces existing Y"
    );
    assert!(
        !duplicate_replaces_existing(false, true, lo, hi),
        "lo: Y dropped, keep X"
    );
    // On hi's side (my=hi, peer=lo): X is inbound, Y is outbound.
    assert!(
        duplicate_replaces_existing(false, true, hi, lo),
        "hi: X replaces existing Y"
    );
    assert!(
        !duplicate_replaces_existing(true, false, hi, lo),
        "hi: Y dropped, keep X"
    );
    // Both ends converge on X (the connection dialed by the min id).
}

#[test]
fn same_direction_duplicate_never_replaces() {
    // A redundant dial in the same direction is always dropped, regardless of
    // ids — only the opposite-direction glare pair triggers a replacement.
    for (a, b) in [("aaa", "bbb"), ("bbb", "aaa")] {
        assert!(!duplicate_replaces_existing(true, true, a, b));
        assert!(!duplicate_replaces_existing(false, false, a, b));
    }
}

#[test]
fn media_queue_is_drop_oldest_and_bounded() {
    let q = MediaQueue::new();
    // Fill to capacity with identifiable single-byte frames.
    for i in 0..MEDIA_QUEUE_CAP {
        assert_eq!(
            q.push(bytes::Bytes::from(vec![i as u8])),
            0,
            "no drops while filling"
        );
    }
    // One more overflows: the oldest (frame 0) is dropped.
    assert_eq!(
        q.push(bytes::Bytes::from(vec![0xFFu8])),
        1,
        "overflow drops oldest"
    );
    {
        let inner = q.inner.lock().unwrap();
        assert_eq!(inner.len(), MEDIA_QUEUE_CAP, "stays at cap");
        assert_eq!(inner.front().unwrap()[0], 1, "front is now the 2nd-oldest");
        assert_eq!(inner.back().unwrap()[0], 0xFF, "newest is at the back");
    }
    // Drain order is FIFO over what survived.
    assert_eq!(q.pop().unwrap()[0], 1);
}

// Real TCP handshake over loopback: both sides learn each other's node id
// (plus name + advertised control port) through length-delimited JSON
// frames. Exercises the codec + handshake without mDNS or a Tauri handle.
#[tokio::test]
async fn handshake_exchanges_node_ids_over_tcp() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let acceptor = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
        handshake(&mut framed, "node-acceptor", "Acceptor", 5001, None).await
    });

    let stream = TcpStream::connect(addr).await.unwrap();
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    let dialer = handshake(
        &mut framed,
        "node-dialer",
        "Dialer",
        5002,
        Some("node-acceptor".to_string()),
    )
    .await
    .unwrap();

    assert_eq!(dialer.id, "node-acceptor", "dialer learns acceptor id");
    assert_eq!(dialer.name, "Acceptor", "dialer learns acceptor name");
    assert_eq!(dialer.port, Some(5001), "dialer learns acceptor port");

    let accepted = acceptor.await.unwrap().unwrap();
    assert_eq!(accepted.id, "node-dialer", "acceptor learns dialer id");
    assert_eq!(accepted.name, "Dialer", "acceptor learns dialer name");
    assert_eq!(accepted.port, Some(5002), "acceptor learns dialer port");
}

// A dialer expecting a specific peer id must reject a mismatched ack.
#[tokio::test]
async fn dialer_detects_peer_id_mismatch() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
        let _ = handshake(&mut framed, "node-other", "Other", 5003, None).await;
    });

    let stream = TcpStream::connect(addr).await.unwrap();
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    // handshake() returns the *actual* peer id; setup_connection compares
    // it against the expected one. Here the actual ("node-other") differs
    // from what a caller would expect.
    let learned = handshake(
        &mut framed,
        "node-dialer",
        "Dialer",
        5004,
        Some("node-expected".to_string()),
    )
    .await
    .unwrap();
    assert_eq!(learned.id, "node-other");
    assert_ne!(learned.id, "node-expected");
}

// Real loopback mutual-TLS handshake between two self-signed identities:
// each side must observe the other's certificate fingerprint, which is the
// peer's node id. This is the binding the anti-spoofing check relies on.
#[tokio::test]
async fn mutual_tls_binds_peer_cert_fingerprint() {
    use crate::lanchat::identity::{Identity, fingerprint};

    let server_id = Identity::generate().unwrap();
    let client_id = Identity::generate().unwrap();
    let (server_fp, client_fp) = (server_id.node_id.clone(), client_id.node_id.clone());
    let server_cfg = tls::server_config(&server_id).unwrap();
    let client_cfg = tls::client_config(&client_id).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let srv = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let tls = TlsStream::from(TlsAcceptor::from(server_cfg).accept(tcp).await.unwrap());
        let (_, conn) = tls.get_ref();
        tls::peer_cert_der(conn).map(|c| fingerprint(&c))
    });

    let tcp = TcpStream::connect(addr).await.unwrap();
    let sni = rustls::pki_types::ServerName::try_from(tls::SNI).unwrap();
    let tls = TlsStream::from(
        TlsConnector::from(client_cfg)
            .connect(sni, tcp)
            .await
            .unwrap(),
    );
    let seen_server_fp = {
        let (_, conn) = tls.get_ref();
        tls::peer_cert_der(conn).map(|c| fingerprint(&c))
    };

    let seen_client_fp = srv.await.unwrap();
    assert_eq!(
        seen_client_fp.as_deref(),
        Some(client_fp.as_str()),
        "server sees client fp"
    );
    assert_eq!(
        seen_server_fp.as_deref(),
        Some(server_fp.as_str()),
        "client sees server fp"
    );
}

// v3 wire over the *real* mutual-TLS + length-delimited transport: a large
// (256 KiB) binary piece frame interleaved with a JSON control frame must
// survive the TLS record layer and the codec, and demux correctly by tag.
#[tokio::test]
async fn v3_piece_and_control_frames_survive_tls_transport() {
    use crate::lanchat::identity::Identity;

    let server_id = Identity::generate().unwrap();
    let client_id = Identity::generate().unwrap();
    let server_cfg = tls::server_config(&server_id).unwrap();
    let client_cfg = tls::client_config(&client_id).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let file_id = "c".repeat(64);
    let fid = file_id.clone();
    // Server side: receive two frames, demux, and report what it saw.
    let srv = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let tls = TlsStream::from(TlsAcceptor::from(server_cfg).accept(tcp).await.unwrap());
        let mut framed = Framed::new(tls, new_codec());
        let mut ctrl_type = None;
        let mut piece = None;
        for _ in 0..2 {
            let buf = framed.next().await.unwrap().unwrap();
            match wire::decode_frame(&buf) {
                Some(wire::Frame::Control(env)) => ctrl_type = Some(env.frame_type),
                Some(wire::Frame::Piece(id, idx, data)) => piece = Some((id, idx, data.len())),
                Some(wire::Frame::Media(_)) => panic!("unexpected media frame"),
                None => panic!("undecodable frame"),
            }
        }
        (ctrl_type, piece)
    });

    let tcp = TcpStream::connect(addr).await.unwrap();
    let sni = rustls::pki_types::ServerName::try_from(tls::SNI).unwrap();
    let tls = TlsStream::from(
        TlsConnector::from(client_cfg)
            .connect(sni, tcp)
            .await
            .unwrap(),
    );
    let mut framed = Framed::new(tls, new_codec());

    let ctrl = Envelope::new(
        frame::SWARM_REQUEST,
        "a",
        Some("b".into()),
        json!({ "fileId": fid, "piece": 7 }),
    );
    framed
        .send(wire::frame_control(&ctrl.encode().unwrap()))
        .await
        .unwrap();
    let data = vec![0xA5u8; 256 * 1024];
    framed
        .send(wire::frame_piece(&fid, 7, &data))
        .await
        .unwrap();
    framed.flush().await.unwrap();

    let (ctrl_type, piece) = srv.await.unwrap();
    assert_eq!(ctrl_type.as_deref(), Some(frame::SWARM_REQUEST));
    assert_eq!(piece, Some((file_id, 7, 256 * 1024)));
}
