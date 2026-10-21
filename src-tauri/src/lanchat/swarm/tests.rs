use super::bitfield::Bitfield;
#[cfg(any(unix, windows))]
use super::file_io::pread_exact;
#[cfg(any(unix, windows))]
use super::file_io::pwrite_all;
use super::lifetime::SwarmFile;
use super::lifetime::SwarmInner;
use super::limits::PER_PEER_WINDOW;
use super::manifest::Manifest;
use super::manifest::build_manifest;
use super::scheduling::schedule_requests;
use crate::lanchat::protocol::PIECE_SIZE;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio::sync::Notify;

#[test]
fn bitfield_pack_round_trips() {
    let mut bf = Bitfield::empty(20);
    for i in [0usize, 3, 7, 8, 19] {
        bf.set(i);
    }
    assert_eq!(bf.count(), 5);
    assert!(!bf.is_complete());
    let restored = Bitfield::from_base64(&bf.to_base64(), 20);
    for i in 0..20 {
        assert_eq!(restored.get(i), bf.get(i), "bit {i}");
    }
}

#[test]
fn bitfield_full_is_complete() {
    assert!(Bitfield::full(4).is_complete());
    assert!(!Bitfield::empty(0).is_complete());
}

#[test]
fn manifest_build_and_piece_len() {
    let dir = std::env::temp_dir().join(format!("lanchat-swarm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("data.bin");
    // 2.5 pieces worth so the last piece is short.
    let size = PIECE_SIZE * 2 + 123;
    std::fs::write(&path, vec![0xABu8; size]).unwrap();

    let m = build_manifest(&path, "data.bin".into(), PIECE_SIZE).unwrap();
    assert_eq!(m.size as usize, size);
    assert_eq!(m.piece_count(), 3);
    assert_eq!(m.piece_len(0), PIECE_SIZE);
    assert_eq!(m.piece_len(1), PIECE_SIZE);
    assert_eq!(m.piece_len(2), 123);
    assert_eq!(m.piece_len(3), 0);
    assert_eq!(m.file_id.len(), 64);

    // Deterministic + content-addressed: same bytes → same id.
    let m2 = build_manifest(&path, "renamed.bin".into(), PIECE_SIZE).unwrap();
    assert_eq!(m.file_id, m2.file_id);
    // Round-trips through JSON.
    let back = Manifest::from_json(&m.to_json()).unwrap();
    assert_eq!(back.file_id, m.file_id);
    assert_eq!(back.pieces, m.pieces);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn positioned_io_round_trips() {
    let dir = std::env::temp_dir().join(format!("lanchat-pio-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("f.bin");
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    f.set_len(1000).unwrap();
    pwrite_all(&f, 500, &[1, 2, 3, 4]).unwrap();
    let got = pread_exact(&f, 500, 4).unwrap();
    assert_eq!(got, vec![1, 2, 3, 4]);
    std::fs::remove_dir_all(&dir).ok();
}

fn test_leecher(n: usize, peers: HashMap<String, Bitfield>) -> Arc<SwarmFile> {
    Arc::new(SwarmFile {
        manifest: Manifest {
            file_id: "f".repeat(64),
            name: "x".into(),
            size: (n * 1024) as u64,
            piece_size: 1024,
            pieces: vec!["00".into(); n],
        },
        conv_id: "direct:peer".into(),
        group_id: None,
        direction: "recv".into(),
        save_path: PathBuf::from("/tmp/x"),
        temp_path: PathBuf::from("/tmp/x.part"),
        origin: Some("origin".into()),
        file: std::sync::Mutex::new(None),
        inner: Mutex::new(SwarmInner {
            have: Bitfield::empty(n),
            peers,
            inflight: HashMap::new(),
        }),
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        resume: Notify::new(),
        wake: Notify::new(),
        started: Instant::now(),
        finalized: AtomicBool::new(false),
    })
}

#[tokio::test]
async fn scheduler_respects_per_peer_window() {
    // Only one source for 20 pieces → capped at the per-peer window.
    let mut peers = HashMap::new();
    peers.insert("origin".to_string(), Bitfield::full(20));
    let sf = test_leecher(20, peers);
    let reqs = schedule_requests(&sf, 20).await;
    assert_eq!(reqs.len(), PER_PEER_WINDOW);
    assert!(reqs.iter().all(|(p, _)| p == "origin"));
    assert_eq!(sf.inner.lock().await.inflight.len(), PER_PEER_WINDOW);
}

#[tokio::test]
async fn scheduler_only_requests_pieces_a_peer_has() {
    // origin has all; peer B has only piece 2. Two sources → 2*window slots.
    let mut peers = HashMap::new();
    peers.insert("origin".to_string(), Bitfield::full(4));
    let mut b = Bitfield::empty(4);
    b.set(2);
    peers.insert("B".to_string(), b);
    let sf = test_leecher(4, peers);
    let reqs = schedule_requests(&sf, 4).await;
    // All 4 pieces get scheduled (origin can serve every one).
    let mut idxs: Vec<u32> = reqs.iter().map(|(_, i)| *i).collect();
    idxs.sort_unstable();
    assert_eq!(idxs, vec![0, 1, 2, 3]);
    // Whoever was asked for piece 2 must actually hold it.
    for (peer, idx) in &reqs {
        if *idx == 2 {
            assert!(peer == "origin" || peer == "B");
        } else {
            assert_eq!(peer, "origin");
        }
    }
}

// End-to-end data plane (no network/AppHandle): rebuild a real multi-piece
// file by applying its pieces OUT OF ORDER through the exact read → verify →
// write path the swarm uses, and confirm the result is byte-identical and a
// tampered piece is rejected.
#[test]
fn reconstruct_file_from_out_of_order_verified_pieces() {
    let dir = std::env::temp_dir().join(format!("lanchat-recon-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("src.bin");
    let dst = dir.join("dst.part");

    // 3 pieces + a short tail, with varied bytes so piece hashes differ.
    let size = PIECE_SIZE * 3 + 777;
    let mut content = vec![0u8; size];
    for (i, b) in content.iter_mut().enumerate() {
        *b = (i % 251) as u8;
    }
    std::fs::write(&src, &content).unwrap();

    let manifest = build_manifest(&src, "src.bin".into(), PIECE_SIZE).unwrap();
    let n = manifest.piece_count();
    assert_eq!(n, 4);

    let seed = std::fs::File::open(&src).unwrap();
    let sink = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&dst)
        .unwrap();
    sink.set_len(size as u64).unwrap();

    // Apply pieces in a deliberately non-sequential order.
    let mut have = Bitfield::empty(n);
    for &idx in &[2usize, 0, 3, 1] {
        let off = idx as u64 * PIECE_SIZE as u64;
        let data = pread_exact(&seed, off, manifest.piece_len(idx)).unwrap();
        // Verify exactly as handle_piece does.
        let mut h = Sha256::new();
        h.update(&data);
        assert_eq!(
            hex::encode(h.finalize()),
            manifest.pieces[idx],
            "piece {idx} hash"
        );
        pwrite_all(&sink, off, &data).unwrap();
        have.set(idx);
    }
    assert!(have.is_complete());
    drop(sink);

    let got = std::fs::read(&dst).unwrap();
    assert_eq!(
        got, content,
        "reconstructed file matches source byte-for-byte"
    );

    // A tampered piece must fail the hash check.
    let mut bad = pread_exact(&seed, 0, manifest.piece_len(0)).unwrap();
    bad[0] ^= 0xFF;
    let mut h = Sha256::new();
    h.update(&bad);
    assert_ne!(
        hex::encode(h.finalize()),
        manifest.pieces[0],
        "tampered piece rejected"
    );

    std::fs::remove_dir_all(&dir).ok();
}
