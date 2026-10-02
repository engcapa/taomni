//! Real client/server stacks with controlled display frames; no OS capture,
//! input injection, clipboard or external services are used by these unit tests.
use std::net::SocketAddr;
use std::num::{NonZeroU16, NonZeroUsize};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::loopback_tests::{client_config, connect_with_retry, tls_connect, tls_identity};
use async_trait::async_trait;
use ironrdp::connector::connection_activation::{
    ConnectionActivationFactory, ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp::connector::{ClientConnector, Sequence};
use ironrdp::core::{ReadCursor, WriteBuf, decode_cursor};
use ironrdp::pdu::Action;
use ironrdp::pdu::fast_path::{FastPathHeader, FastPathUpdatePdu, UpdateCode};
use ironrdp::pdu::rdp::capability_sets::client_codecs_capabilities;
use ironrdp::pdu::rdp::client_info::CompressionType;
use ironrdp::pdu::rdp::headers::CompressionFlags;
use ironrdp::server::{
    BitmapUpdate, DesktopSize, DisplayUpdate, EncoderStats, PixelFormat, RdpServer,
    RdpServerDisplay, RdpServerDisplayUpdates, ServerEvent,
};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::{FramedWrite, TokioFramed};

struct ControlledDisplay {
    size: Arc<Mutex<DesktopSize>>,
    receiver: Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<DisplayUpdate>>>,
}
struct ControlledUpdates(
    Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<DisplayUpdate>>>,
);
#[async_trait]
impl RdpServerDisplay for ControlledDisplay {
    async fn size(&mut self) -> DesktopSize {
        *self.size.lock().unwrap()
    }
    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        Ok(Box::new(ControlledUpdates(self.receiver.clone())))
    }
}
#[async_trait]
impl RdpServerDisplayUpdates for ControlledUpdates {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        Ok(self.0.lock().await.recv().await)
    }
}

struct TestServer {
    _dir: tempfile::TempDir,
    addr: SocketAddr,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    updates: tokio::sync::mpsc::UnboundedSender<DisplayUpdate>,
    size: Arc<Mutex<DesktopSize>>,
    stats: Arc<EncoderStats>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl TestServer {
    fn new(width: u16, height: u16, enabled: bool) -> Self {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::ERROR)
            .with_test_writer()
            .try_init();
        let dir = tempfile::tempdir().unwrap();
        let identity = tls_identity(dir.path());
        let size = Arc::new(Mutex::new(DesktopSize { width, height }));
        let stats = Arc::new(EncoderStats::default());
        let (updates, receiver) = tokio::sync::mpsc::unbounded_channel();
        let display = ControlledDisplay {
            size: size.clone(),
            receiver: Arc::new(tokio::sync::Mutex::new(receiver)),
        };
        let thread_stats = stats.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let mut server = RdpServer::builder()
                    .with_addr(SocketAddr::from(([127, 0, 0, 1], 0)))
                    .with_tls(identity.make_acceptor().unwrap()).with_no_input()
                    .with_display_handler(display).with_bulk_compression(enabled)
                    .with_encoder_stats_handle(thread_stats).build();
                let events = server.event_sender().clone();
                let (addr_tx, addr_rx) = tokio::sync::oneshot::channel();
                events.send(ServerEvent::GetLocalAddr(addr_tx)).unwrap();
                let run = server.run();
                tokio::pin!(run);
                tokio::select! {
                    addr = addr_rx => { ready_tx.send((addr.unwrap().unwrap(), events)).unwrap(); }
                    result = &mut run => panic!("server startup: {result:?}"),
                }
                tokio::select! {
                    _ = &mut run => {},
                    _ = &mut shutdown_rx => {},
                }
            });
        });
        let (addr, _events) = ready_rx.recv_timeout(Duration::from_secs(15)).unwrap();
        Self {
            _dir: dir,
            addr,
            shutdown: Some(shutdown),
            updates,
            size,
            stats,
            thread: Some(thread),
        }
    }
    fn send_frame(&self, width: u16, height: u16, data: &[u8]) {
        self.updates
            .send(DisplayUpdate::Bitmap(BitmapUpdate {
                x: 0,
                y: 0,
                width: NonZeroU16::new(width).unwrap(),
                height: NonZeroU16::new(height).unwrap(),
                format: PixelFormat::BgrA32,
                data: data.to_vec().into(),
                stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
            }))
            .unwrap();
    }
}
impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

#[derive(Default)]
struct WireStats {
    bitmap: usize,
    rfx: usize,
    compression: Vec<Option<CompressionType>>,
    flushed: usize,
    last_was_flushed: bool,
    packets: Vec<Vec<u8>>,
}
struct TestClient {
    framed: TokioFramed<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>,
    stage: ActiveStage,
    image: DecodedImage,
    factory: ConnectionActivationFactory,
    reactivation: Option<ConnectionActivationSequence>,
    reactivated: usize,
    wire: WireStats,
}
impl TestClient {
    async fn connect(
        addr: SocketAddr,
        compression: Option<CompressionType>,
        proprietary: bool,
    ) -> anyhow::Result<Self> {
        let tcp = connect_with_retry(addr).await?;
        let codecs = if proprietary {
            crate::rdp::session::client_bitmap_codecs()
        } else {
            client_codecs_capabilities(&["remotefx", "qoi:off", "qoiz:off"])
                .map_err(anyhow::Error::msg)?
        };
        let mut cfg = client_config(codecs);
        cfg.compression_type = compression;
        let mut connector = ClientConnector::new(cfg, tcp.local_addr()?);
        let mut framed = TokioFramed::new(tcp);
        let upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector).await?;
        let tls = tls_connect(framed.into_inner_no_leftover()).await?;
        let upgrade = ironrdp_tokio::mark_as_upgraded(upgrade, &mut connector);
        let mut framed = TokioFramed::new(tls);
        let result = ironrdp_tokio::connect_finalize(
            upgrade,
            connector,
            &mut framed,
            &mut ironrdp_tokio::reqwest::ReqwestNetworkClient::new(),
            "localhost".into(),
            vec![],
            None,
        )
        .await?;
        let image = DecodedImage::new(
            ironrdp::graphics::image_processing::PixelFormat::RgbA32,
            result.desktop_size.width,
            result.desktop_size.height,
        );
        let factory = result.activation_factory.clone();
        let stage = ActiveStageBuilder {
            static_channels: result.static_channels,
            user_channel_id: result.user_channel_id,
            io_channel_id: result.io_channel_id,
            message_channel_id: result.message_channel_id,
            share_id: result.share_id,
            compression_type: result.compression_type,
            enable_server_pointer: result.enable_server_pointer,
            pointer_software_rendering: false,
        }
        .build();
        Ok(Self {
            framed,
            stage,
            image,
            factory,
            reactivation: None,
            reactivated: 0,
            wire: WireStats::default(),
        })
    }
    async fn pump(&mut self) -> anyhow::Result<()> {
        let (action, payload) =
            tokio::time::timeout(Duration::from_secs(8), self.framed.read_pdu()).await??;
        if let Some(sequence) = self.reactivation.as_mut() {
            let mut output = WriteBuf::new();
            sequence.step(&payload, &mut output)?;
            loop {
                if !output.filled().is_empty() {
                    self.framed.write_all(output.filled()).await?;
                }
                if let ConnectionActivationState::Finalized {
                    desktop_size,
                    enable_server_pointer,
                    ..
                } = sequence.connection_activation_state()
                {
                    self.image = DecodedImage::new(
                        ironrdp::graphics::image_processing::PixelFormat::RgbA32,
                        desktop_size.width,
                        desktop_size.height,
                    );
                    self.stage.set_enable_server_pointer(enable_server_pointer);
                    self.reactivation = None;
                    self.reactivated += 1;
                    return Ok(());
                }
                if sequence.next_pdu_hint().is_some() {
                    return Ok(());
                }
                output.clear();
                sequence.step_no_input(&mut output)?;
            }
        }
        if matches!(action, Action::FastPath) {
            self.wire.packets.push(payload.to_vec());
            let mut cursor = ReadCursor::new(&payload);
            let _: FastPathHeader = decode_cursor(&mut cursor)?;
            while !cursor.is_empty() {
                let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor)?;
                match update.update_code {
                    UpdateCode::Bitmap => self.wire.bitmap += 1,
                    UpdateCode::SurfaceCommands => self.wire.rfx += 1,
                    _ => {}
                }
                self.wire.compression.push(update.compression_type);
                self.wire.last_was_flushed = update
                    .compression_flags
                    .is_some_and(|f| f.contains(CompressionFlags::FLUSHED));
                self.wire.flushed += usize::from(self.wire.last_was_flushed);
            }
        }
        for output in self.stage.process(&mut self.image, action, &payload)? {
            match output {
                ActiveStageOutput::ResponseFrame(frame) if !frame.is_empty() => {
                    self.framed.write_all(&frame).await?
                }
                ActiveStageOutput::DeactivateAll => self.reactivation = Some(self.factory.create()),
                ActiveStageOutput::Terminate(reason) => anyhow::bail!("terminated: {reason:?}"),
                _ => {}
            }
        }
        Ok(())
    }
    fn matches_frame(&self, expected: &[u8], width: u16, height: u16, photo: bool) -> bool {
        if (self.image.width(), self.image.height()) != (width, height) {
            return false;
        }
        self.image
            .data()
            .chunks_exact(4)
            .zip(expected.chunks_exact(4))
            .enumerate()
            .all(|(i, (actual, wanted))| {
                let tolerance = if photo && i % usize::from(width) >= usize::from(width / 2) {
                    24
                } else {
                    0
                };
                actual[3] == 255
                    && actual[0].abs_diff(wanted[2]) <= tolerance
                    && actual[1].abs_diff(wanted[1]) <= tolerance
                    && actual[2].abs_diff(wanted[0]) <= tolerance
            })
    }
    async fn frame(
        &mut self,
        expected: &[u8],
        width: u16,
        height: u16,
        photo: bool,
    ) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                self.pump().await?;
                if self.matches_frame(expected, width, height, photo) {
                    return Ok(());
                }
            }
        })
        .await?
    }
}

fn frame(width: u16, height: u16, index: u8, photo: bool) -> Vec<u8> {
    let mut seed = 0x9e3779b9u32.wrapping_mul(u32::from(index) + 1);
    (0..usize::from(width) * usize::from(height))
        .flat_map(|i| {
            let x = i % usize::from(width);
            let v = if photo && x >= usize::from(width / 2) {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                // A dark noisy texture exercises the photo selector while staying
                // within the fixed 24-level tolerance of default RemoteFX quant.
                8 + (seed & 15) as u8
            } else if (64..128).contains(&x) {
                128
            } else {
                if ((x + usize::from(index) * 4) / 16) % 2 == 0 {
                    16
                } else {
                    240
                }
            };
            [v, v, v, 255]
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bulk_compressed_planar_round_trip_is_lossless() {
    let server = TestServer::new(256, 128, true);
    let mut client = TestClient::connect(server.addr, Some(CompressionType::Rdp61), false)
        .await
        .unwrap();
    for i in 0..7 {
        let pixels = frame(256, 128, i, false);
        server.send_frame(256, 128, &pixels);
        client.frame(&pixels, 256, 128, false).await.unwrap();
    }
    assert!(client.wire.bitmap > 0 && client.wire.rfx == 0);
    assert!(client.wire.flushed > 0);
    assert!(
        server.stats.bytes_after_bulk.load(Ordering::Relaxed)
            < server.stats.bytes_before_bulk.load(Ordering::Relaxed)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mppc_64k_client_round_trip() {
    let server = TestServer::new(256, 128, true);
    let mut client = TestClient::connect(server.addr, Some(CompressionType::K64), false)
        .await
        .unwrap();
    for i in 0..3 {
        let pixels = frame(256, 128, i, false);
        server.send_frame(256, 128, &pixels);
        client.frame(&pixels, 256, 128, false).await.unwrap();
    }
    assert!(
        client
            .wire
            .compression
            .iter()
            .flatten()
            .all(|kind| *kind == CompressionType::K64)
    );
    assert!(client.wire.bitmap > 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_planar_and_remotefx_frames_decode() {
    let server = TestServer::new(256, 128, true);
    let mut client = TestClient::connect(server.addr, Some(CompressionType::Rdp61), false)
        .await
        .unwrap();
    for (i, photo) in [false, false, false, true, true, false, false]
        .into_iter()
        .enumerate()
    {
        let pixels = frame(256, 128, i as u8, photo);
        server.send_frame(256, 128, &pixels);
        if let Err(error) = client.frame(&pixels, 256, 128, photo).await {
            let differences: Vec<_> = client
                .image
                .data()
                .chunks_exact(4)
                .zip(pixels.chunks_exact(4))
                .enumerate()
                .filter(|(n, (actual, expected))| {
                    let tolerance = if photo && n % 256 >= 128 { 24 } else { 0 };
                    actual[0].abs_diff(expected[2]) > tolerance
                        || actual[1].abs_diff(expected[1]) > tolerance
                        || actual[2].abs_diff(expected[0]) > tolerance
                        || actual[3] != 255
                })
                .take(8)
                .collect();
            panic!("frame {i}, photo={photo}: {error}; differences={differences:?}");
        }
    }
    assert!(server.stats.planar_rects.load(Ordering::Relaxed) > 0);
    assert!(server.stats.rfx_rects.load(Ordering::Relaxed) > 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reactivation_resets_compression_history() {
    let server = TestServer::new(256, 128, true);
    let mut client = TestClient::connect(server.addr, Some(CompressionType::Rdp61), false)
        .await
        .unwrap();
    let pixels = frame(256, 128, 0, false);
    server.send_frame(256, 128, &pixels);
    client.frame(&pixels, 256, 128, false).await.unwrap();
    *server.size.lock().unwrap() = DesktopSize {
        width: 320,
        height: 128,
    };
    server
        .updates
        .send(DisplayUpdate::Resize(DesktopSize {
            width: 320,
            height: 128,
        }))
        .unwrap();
    while client.reactivated == 0 {
        client.pump().await.unwrap();
    }
    let previous_flushes = client.wire.flushed;
    for i in 1..4 {
        let pixels = frame(320, 128, i, false);
        server.send_frame(320, 128, &pixels);
        client.frame(&pixels, 320, 128, false).await.unwrap();
    }
    assert!(client.wire.flushed > previous_flushes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mstsc_like_client_without_compression_gets_remotefx_unchanged() {
    async fn collect(enabled: bool) -> Vec<Vec<u8>> {
        let server = TestServer::new(256, 128, enabled);
        let mut client = TestClient::connect(server.addr, None, false).await.unwrap();
        // Uniform content is exactly represented by the default RemoteFX quantizer.
        let pixels: Vec<u8> = [128, 128, 128, 255]
            .into_iter()
            .cycle()
            .take(256 * 128 * 4)
            .collect();
        server.send_frame(256, 128, &pixels);
        client.pump().await.unwrap();
        assert!(
            client
                .image
                .data()
                .chunks_exact(4)
                .all(|p| p[..3].iter().all(|v| v.abs_diff(128) <= 24))
        );
        assert!(client.wire.bitmap == 0 && client.wire.rfx > 0);
        assert!(client.wire.compression.iter().all(Option::is_none));
        client.wire.packets
    }
    assert_eq!(
        collect(false).await,
        collect(true).await,
        "non-compression wire bytes changed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proprietary_codec_with_compression_keeps_its_existing_wire_format() {
    let server = TestServer::new(256, 128, true);
    let mut client = TestClient::connect(server.addr, Some(CompressionType::Rdp61), true)
        .await
        .unwrap();
    let pixels = frame(256, 128, 0, false);
    server.send_frame(256, 128, &pixels);
    client.frame(&pixels, 256, 128, false).await.unwrap();
    assert!(client.wire.compression.iter().all(Option::is_none));
    assert_eq!(client.wire.bitmap, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_creates_a_fresh_bulk_history() {
    let server = TestServer::new(256, 128, true);
    for round in 0..2 {
        let mut client = TestClient::connect(server.addr, Some(CompressionType::Rdp61), false)
            .await
            .unwrap();
        let pixels = frame(256, 128, round, false);
        server.send_frame(256, 128, &pixels);
        client.frame(&pixels, 256, 128, false).await.unwrap();
        assert!(
            client.wire.flushed > 0,
            "connection {round} must flush the peer"
        );
    }
}
