//! VNC performance benchmarks used as evidence for the RealVNC alignment batch
//! (`docs-feature/vnc-realvnc-alignment`). Every test is `#[ignore]` and reads
//! its target from the environment so no host, secret or screen content lands
//! in the repository.
//!
//! Live capture (talks to a real server through a loopback counting proxy):
//!
//! ```text
//! TAOMNI_VNC_LIVE_HOST=<host> TAOMNI_VNC_LIVE_PORT=5900 TAOMNI_VNC_LIVE_PASSWORD=<secret> \
//! TAOMNI_VNC_CAPTURE_DIR=../qa-ui-auto-report/vnc-perf/capture \
//!   cargo test --lib vnc::live_bench::live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Offline replay (decode cost only, deterministic before/after comparison):
//!
//! ```text
//! TAOMNI_VNC_CAPTURE_DIR=../qa-ui-auto-report/vnc-perf/capture \
//!   cargo test --release --lib vnc::live_bench::replay -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Captured frames contain remote screen pixels: keep the directory under the
//! gitignored `qa-ui-auto-report/`.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::vnc::encodings::{ENCODING_DESKTOP_SIZE, ENCODING_POINTER_POS, ENCODING_RICH_CURSOR};
use crate::vnc::framebuffer::{FbRect, SharedFramebuffer};
use crate::vnc::limits::DecodeLimits;
use crate::vnc::policy::VncSecurityPolicy;
use crate::vnc::rfb::{RfbConnection, ServerMessage};

struct CountingProxy {
    port: u16,
    down_bytes: Arc<AtomicU64>,
    up_bytes: Arc<AtomicU64>,
    recording: Arc<AtomicBool>,
    recorded: Arc<Mutex<Vec<u8>>>,
}

fn pump(
    mut from: TcpStream,
    mut to: TcpStream,
    counter: Arc<AtomicU64>,
    tee: Option<(Arc<AtomicBool>, Arc<Mutex<Vec<u8>>>)>,
) {
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if let Some((flag, sink)) = tee.as_ref()
                    && flag.load(Ordering::Acquire)
                {
                    sink.lock().unwrap().extend_from_slice(&buf[..n]);
                }
                counter.fetch_add(n as u64, Ordering::Release);
                if to.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = to.shutdown(Shutdown::Both);
}

fn start_proxy(host: &str, port: u16) -> CountingProxy {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind proxy");
    let local = listener.local_addr().unwrap().port();
    let down = Arc::new(AtomicU64::new(0));
    let up = Arc::new(AtomicU64::new(0));
    let recording = Arc::new(AtomicBool::new(false));
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let (down_c, up_c) = (down.clone(), up.clone());
    let tee = (recording.clone(), recorded.clone());
    let target = format!("{host}:{port}");
    std::thread::spawn(move || {
        if let Ok((client, _)) = listener.accept() {
            let server = TcpStream::connect(&target).expect("connect VNC target");
            let _ = server.set_nodelay(true);
            let _ = client.set_nodelay(true);
            let (c2, s2) = (client.try_clone().unwrap(), server.try_clone().unwrap());
            std::thread::spawn(move || pump(s2, c2, down_c, Some(tee)));
            pump(client, server, up_c, None);
        }
    });
    CountingProxy {
        port: local,
        down_bytes: down,
        up_bytes: up,
        recording,
        recorded,
    }
}

fn profile_encodings(profile: &str) -> Option<Vec<i32>> {
    let pseudo = [
        ENCODING_DESKTOP_SIZE,
        ENCODING_POINTER_POS,
        ENCODING_RICH_CURSOR,
    ];
    let base: Vec<i32> = match profile {
        "production" => vec![16, 5, 1, 0],
        "zrle" => vec![16, 1, 0],
        "hextile" => vec![5, 1, 0],
        "raw" => vec![0],
        _ => return None,
    };
    Some(base.into_iter().chain(pseudo).collect())
}

#[derive(Default, Debug, Clone, Copy)]
struct FrameStats {
    rects: usize,
    decoded_bytes: usize,
    wall_ms: f64,
    wire_bytes: u64,
    package_ms: f64,
}

/// Mirror of the relay's frame packaging in `ws.rs` (damage -> relay frames
/// read from the authoritative framebuffer) so the replay benchmark charges
/// the copy the production path performs before a frame reaches the WebSocket.
fn package_like_relay(framebuffer: &SharedFramebuffer, rects: &[FbRect]) -> usize {
    let mut damage = crate::vnc::framebuffer::Damage::default();
    for rect in rects {
        damage.add(*rect);
    }
    let fb = framebuffer.lock().unwrap();
    damage
        .take()
        .into_iter()
        .filter_map(|rect| fb.relay_frame(rect))
        .map(|frame| std::hint::black_box(frame).len())
        .sum()
}

fn read_until_update(rfb: &mut RfbConnection, down: Option<&AtomicU64>) -> FrameStats {
    let before = down.map(|d| d.load(Ordering::Acquire)).unwrap_or(0);
    let started = Instant::now();
    loop {
        match rfb.read_server_message().expect("read server message") {
            ServerMessage::FramebufferUpdate { rects, .. } => {
                let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
                let package_started = Instant::now();
                let decoded_bytes = package_like_relay(&rfb.framebuffer(), &rects);
                return FrameStats {
                    rects: rects.len(),
                    decoded_bytes,
                    wall_ms,
                    wire_bytes: down.map(|d| d.load(Ordering::Acquire)).unwrap_or(0) - before,
                    package_ms: package_started.elapsed().as_secs_f64() * 1000.0,
                };
            }
            _ => continue,
        }
    }
}

fn capture_dir() -> Option<PathBuf> {
    std::env::var_os("TAOMNI_VNC_CAPTURE_DIR").map(PathBuf::from)
}

#[test]
#[ignore = "requires TAOMNI_VNC_LIVE_HOST/TAOMNI_VNC_LIVE_PASSWORD"]
fn live_full_frame_benchmark() {
    let Ok(host) = std::env::var("TAOMNI_VNC_LIVE_HOST") else {
        eprintln!("TAOMNI_VNC_LIVE_HOST unset; skipping");
        return;
    };
    let port: u16 = std::env::var("TAOMNI_VNC_LIVE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5900);
    let password = std::env::var("TAOMNI_VNC_LIVE_PASSWORD").ok();
    let rounds: usize = std::env::var("TAOMNI_VNC_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    let profiles = std::env::var("TAOMNI_VNC_PROFILES")
        .unwrap_or_else(|_| "production,zrle,hextile,raw".into());
    let capture = capture_dir();
    if let Some(dir) = capture.as_ref() {
        std::fs::create_dir_all(dir).expect("create capture dir");
    }

    for profile in profiles.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let Some(encodings) = profile_encodings(profile) else {
            eprintln!("unknown profile {profile}; skipping");
            continue;
        };
        let proxy = start_proxy(&host, port);
        let connect_started = Instant::now();
        let stream = TcpStream::connect(("127.0.0.1", proxy.port)).expect("connect proxy");
        let mut rfb = RfbConnection::from_stream(
            stream,
            Duration::from_secs(60),
            VncSecurityPolicy::LegacyCompatible,
            DecodeLimits::default(),
        )
        .expect("protocol handshake");
        let init = rfb
            .authenticate_with_policy(
                None,
                password.as_deref(),
                VncSecurityPolicy::LegacyCompatible,
            )
            .expect("authenticate");
        let handshake_ms = connect_started.elapsed().as_secs_f64() * 1000.0;
        rfb.enter_runtime_mode().unwrap();
        rfb.set_pixel_format_rgba().unwrap();
        rfb.set_encodings(&encodings).unwrap();
        proxy.recording.store(true, Ordering::Release);
        rfb.request_update(false).unwrap();
        let first = read_until_update(&mut rfb, Some(&proxy.down_bytes));
        proxy.recording.store(false, Ordering::Release);
        if let Some(dir) = capture.as_ref() {
            let bytes = proxy.recorded.lock().unwrap().clone();
            let path = dir.join(format!("{profile}-{}x{}.rfb", init.width, init.height));
            std::fs::write(&path, &bytes).expect("write capture");
        }

        let mut samples = Vec::new();
        for _ in 0..rounds {
            rfb.request_update(false).unwrap();
            samples.push(read_until_update(&mut rfb, Some(&proxy.down_bytes)));
        }
        let n = samples.len().max(1) as f64;
        let avg = |f: fn(&FrameStats) -> f64| samples.iter().map(f).sum::<f64>() / n;
        println!(
            "VNC-LIVE profile={profile} fb={}x{} handshake_ms={handshake_ms:.1} first_frame_ms={:.1} first_wire_kib={:.1} first_rects={} | full_refresh avg_ms={:.1} avg_wire_kib={:.1} avg_rects={:.0} relay_mib={:.2} up_bytes={}",
            init.width,
            init.height,
            first.wall_ms,
            first.wire_bytes as f64 / 1024.0,
            first.rects,
            avg(|s| s.wall_ms),
            avg(|s| s.wire_bytes as f64) / 1024.0,
            avg(|s| s.rects as f64),
            avg(|s| s.decoded_bytes as f64) / 1024.0 / 1024.0,
            proxy.up_bytes.load(Ordering::Acquire),
        );
    }
}

/// Minimal RFB 3.8 server that replays one recorded FramebufferUpdate after
/// the client's first update request. Security type None keeps the replay
/// free of credentials.
fn start_replay_server(width: u16, height: u16, frame: Arc<Vec<u8>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind replay");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let _ = stream.set_nodelay(true);
        stream.write_all(b"RFB 003.008\n").unwrap();
        let mut banner = [0u8; 12];
        stream.read_exact(&mut banner).unwrap();
        stream.write_all(&[1, 1]).unwrap();
        let mut chosen = [0u8; 1];
        stream.read_exact(&mut chosen).unwrap();
        stream.write_all(&0u32.to_be_bytes()).unwrap();
        let mut shared = [0u8; 1];
        stream.read_exact(&mut shared).unwrap();
        let name = b"replay";
        let mut init = Vec::new();
        init.extend_from_slice(&width.to_be_bytes());
        init.extend_from_slice(&height.to_be_bytes());
        init.extend_from_slice(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
        init.extend_from_slice(&(name.len() as u32).to_be_bytes());
        init.extend_from_slice(name);
        stream.write_all(&init).unwrap();
        // SetPixelFormat (20) + SetEncodings header (4) + list + one update request (10).
        let mut pixel_format = [0u8; 20];
        stream.read_exact(&mut pixel_format).unwrap();
        let mut encodings = [0u8; 4];
        stream.read_exact(&mut encodings).unwrap();
        let count = u16::from_be_bytes([encodings[2], encodings[3]]) as usize;
        let mut list = vec![0u8; count * 4];
        stream.read_exact(&mut list).unwrap();
        let mut request = [0u8; 10];
        stream.read_exact(&mut request).unwrap();
        stream.write_all(&frame).unwrap();
        let mut sink = [0u8; 64];
        while matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
    });
    port
}

fn replay_once(width: u16, height: u16, frame: Arc<Vec<u8>>, encodings: &[i32]) -> FrameStats {
    let port = start_replay_server(width, height, frame);
    let stream = TcpStream::connect(("127.0.0.1", port)).expect("connect replay");
    let mut rfb = RfbConnection::from_stream(
        stream,
        Duration::from_secs(30),
        VncSecurityPolicy::AllowNone,
        DecodeLimits::default(),
    )
    .expect("replay handshake");
    rfb.authenticate_with_policy(None, None, VncSecurityPolicy::AllowNone)
        .expect("replay auth");
    rfb.enter_runtime_mode().unwrap();
    rfb.set_pixel_format_rgba().unwrap();
    rfb.set_encodings(encodings).unwrap();
    rfb.request_update(false).unwrap();
    read_until_update(&mut rfb, None)
}

#[test]
#[ignore = "requires TAOMNI_VNC_CAPTURE_DIR with frames recorded by the live benchmark"]
fn replay_decode_benchmark() {
    let Some(dir) = capture_dir() else {
        eprintln!("TAOMNI_VNC_CAPTURE_DIR unset; skipping");
        return;
    };
    let rounds: usize = std::env::var("TAOMNI_VNC_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .expect("read capture dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rfb"))
        .collect();
    entries.sort();
    for path in entries {
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let Some((profile, size)) = stem.rsplit_once('-') else {
            continue;
        };
        let Some((w, h)) = size.split_once('x') else {
            continue;
        };
        let (Ok(width), Ok(height)) = (w.parse::<u16>(), h.parse::<u16>()) else {
            continue;
        };
        let Some(encodings) = profile_encodings(profile) else {
            continue;
        };
        let frame = Arc::new(std::fs::read(&path).expect("read capture"));
        let mut samples: Vec<FrameStats> = (0..rounds)
            .map(|_| replay_once(width, height, frame.clone(), &encodings))
            .collect();
        samples.sort_by(|a, b| a.wall_ms.total_cmp(&b.wall_ms));
        let median = samples[samples.len() / 2];
        let best = samples[0];
        println!(
            "VNC-REPLAY profile={profile} fb={width}x{height} wire_kib={:.1} rects={} decode_median_ms={:.2} decode_best_ms={:.2} package_median_ms={:.2} relay_mib={:.2} build={}",
            frame.len() as f64 / 1024.0,
            median.rects,
            median.wall_ms,
            best.wall_ms,
            median.package_ms,
            median.decoded_bytes as f64 / 1024.0 / 1024.0,
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
        );
    }
}
