//! Loopback contract between Taomni's RDP client stack and its RDP server
//! stack: whatever bitmap codec the server negotiates from a client's
//! capability set must be decodable by that client.
//!
//! A mismatch is silent on the wire — the client keeps receiving surface
//! updates but paints nothing — so the user sees a black desktop. That is what
//! QOIZ did before `ironrdp`'s `qoi`/`qoiz` features were enabled for the
//! session crate (the server's default features had already made ironrdp-pdu
//! advertise them).

use std::net::SocketAddr;
use std::num::{NonZeroU16, NonZeroUsize};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use ironrdp::connector::{self, Credentials};
use ironrdp::graphics::image_processing::PixelFormat as ClientPixelFormat;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::{
    BitmapCodecs, MajorPlatformType, client_codecs_capabilities,
};
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::server::{
    BitmapUpdate, DesktopSize, DisplayUpdate, PixelFormat, RdpServer, RdpServerDisplay,
    RdpServerDisplayUpdates, ServerEvent, TlsIdentityCtx,
};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::FramedWrite as _;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::net::TcpStream;

const WIDTH: u16 = 256;
const HEIGHT: u16 = 128;
const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const WHITE: [u8; 3] = [255, 255, 255];
const QOIZ_CODEC_ID: u8 = 0x0B;

/// Left half red, right half blue, white 16x16 marker at (200, 40). BGRA.
fn pattern() -> Vec<u8> {
    let mut data = Vec::with_capacity(usize::from(WIDTH) * usize::from(HEIGHT) * 4);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let [r, g, b] = expected_rgb(x, y);
            data.extend_from_slice(&[b, g, r, 0xff]);
        }
    }
    data
}

fn expected_rgb(x: u16, y: u16) -> [u8; 3] {
    if (200..216).contains(&x) && (40..56).contains(&y) {
        WHITE
    } else if x < WIDTH / 2 {
        RED
    } else {
        BLUE
    }
}

struct PatternDisplay;

#[async_trait]
impl RdpServerDisplay for PatternDisplay {
    async fn size(&mut self) -> DesktopSize {
        DesktopSize {
            width: WIDTH,
            height: HEIGHT,
        }
    }

    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        Ok(Box::new(PatternUpdates { sent: false }))
    }
}

/// Sends the pattern once, then idles like a static desktop.
struct PatternUpdates {
    sent: bool,
}

#[async_trait]
impl RdpServerDisplayUpdates for PatternUpdates {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        if self.sent {
            std::future::pending::<()>().await;
        }
        self.sent = true;
        Ok(Some(DisplayUpdate::Bitmap(BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(WIDTH).expect("non-zero width"),
            height: NonZeroU16::new(HEIGHT).expect("non-zero height"),
            format: PixelFormat::BgrA32,
            data: pattern().into(),
            stride: NonZeroUsize::new(usize::from(WIDTH) * 4).expect("non-zero stride"),
        })))
    }
}

fn tls_identity(dir: &Path) -> TlsIdentityCtx {
    super::tls::ensure_crypto_provider();
    std::fs::create_dir_all(dir).expect("create identity dir");
    let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
        .expect("generate self-signed certificate");
    let (cert, key) = (dir.join("cert.pem"), dir.join("key.pem"));
    std::fs::write(&cert, certified.cert.pem()).expect("write cert");
    std::fs::write(&key, certified.signing_key.serialize_pem()).expect("write key");
    TlsIdentityCtx::init_from_paths(&cert, &key).expect("load identity")
}

/// The test server presents a throwaway self-signed certificate.
#[derive(Debug)]
struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

async fn tls_connect(tcp: TcpStream) -> anyhow::Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
        .with_no_client_auth();
    let name = ServerName::try_from("localhost".to_string())?;
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await?)
}
fn client_config(codecs: BitmapCodecs) -> connector::Config {
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: "loopback".to_owned(),
            password: "loopback".to_owned(),
        },
        domain: None,
        enable_tls: true,
        enable_credssp: false,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        desktop_size: connector::DesktopSize {
            width: WIDTH,
            height: HEIGHT,
        },
        desktop_scale_factor: 0,
        bitmap: Some(connector::BitmapConfig {
            lossy_compression: false,
            color_depth: 32,
            codecs,
        }),
        client_build: 0,
        client_name: "taomni-loopback".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: MajorPlatformType::WINDOWS,
        enable_server_pointer: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        pointer_software_rendering: false,
        performance_flags: PerformanceFlags::DISABLE_WALLPAPER,
        hardware_id: None,
        license_cache: None::<Arc<dyn connector::LicenseCache>>,
        timezone_info: TimezoneInfo::default(),
        compression_type: None,
        multitransport_flags: None,
    }
}

async fn connect_with_retry(addr: SocketAddr) -> anyhow::Result<TcpStream> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match TcpStream::connect(addr).await {
            Ok(stream) => return Ok(stream),
            Err(error) if Instant::now() >= deadline => {
                anyhow::bail!("RDP test server never listened on {addr}: {error}")
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

fn pixel(image: &DecodedImage, x: u16, y: u16) -> [u8; 4] {
    let offset = (usize::from(y) * usize::from(image.width()) + usize::from(x)) * 4;
    let px = &image.data()[offset..offset + 4];
    [px[0], px[1], px[2], px[3]]
}

fn close_to(actual: [u8; 4], wanted: [u8; 3], tolerance: u8) -> bool {
    actual[3] != 0 && (0..3).all(|i| actual[i].abs_diff(wanted[i]) <= tolerance)
}
/// Connect with `codecs`, then pump the active stage until the pattern is
/// visible in the decoded framebuffer (or fail with what was decoded).
async fn decode_desktop(
    addr: SocketAddr,
    codecs: BitmapCodecs,
    tolerance: u8,
) -> anyhow::Result<()> {
    let tcp = connect_with_retry(addr).await?;
    let local = tcp.local_addr()?;
    let mut connector = connector::ClientConnector::new(client_config(codecs), local);
    let mut framed = ironrdp_tokio::TokioFramed::new(tcp);
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .map_err(|e| anyhow::anyhow!("connect_begin: {e}"))?;
    let tls = tls_connect(framed.into_inner_no_leftover()).await?;
    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = ironrdp_tokio::TokioFramed::new(tls);
    let mut network = ironrdp_tokio::reqwest::ReqwestNetworkClient::new();
    let result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut network,
        "localhost".to_string().into(),
        Vec::new(),
        None,
    )
    .await
    .map_err(|e| anyhow::anyhow!("connect_finalize: {e}"))?;

    let (width, height) = (result.desktop_size.width, result.desktop_size.height);
    anyhow::ensure!(
        (width, height) == (WIDTH, HEIGHT),
        "negotiated desktop {width}x{height}, expected {WIDTH}x{HEIGHT}"
    );
    let mut image = DecodedImage::new(ClientPixelFormat::RgbA32, width, height);
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();

    let probes = [(10, 10, RED), (250, 120, BLUE), (207, 47, WHITE)];
    let visible = |image: &DecodedImage| {
        probes
            .iter()
            .all(|(x, y, rgb)| close_to(pixel(image, *x, *y), *rgb, tolerance))
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut updates = 0usize;
    while Instant::now() < deadline {
        let read = tokio::time::timeout(Duration::from_secs(5), framed.read_pdu()).await;
        let Ok(read) = read else { break };
        let (action, payload) = read?;
        let outputs = stage
            .process(&mut image, action, &payload)
            .map_err(|e| anyhow::anyhow!("active stage: {e}"))?;
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) if !frame.is_empty() => {
                    framed.write_all(&frame).await?;
                }
                ActiveStageOutput::GraphicsUpdate(_) => {
                    updates += 1;
                    if visible(&image) {
                        return Ok(());
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    anyhow::bail!("server terminated the session: {reason:?}")
                }
                _ => {}
            }
        }
    }
    let seen: Vec<_> = probes
        .iter()
        .map(|(x, y, _)| pixel(&image, *x, *y))
        .collect();
    anyhow::bail!("pattern not decoded after {updates} graphics updates; probe pixels {seen:?}")
}
/// Run a TLS-only server with the pattern display on its own thread.
/// `RdpServer::run()` is `!Send`, so — like `spawn_server` in production — it
/// lives on a dedicated current-thread runtime. Returns the bound address and
/// the server's event sender (used to quit it).
fn start_server(dir: &Path) -> (SocketAddr, tokio::sync::mpsc::UnboundedSender<ServerEvent>) {
    let identity = tls_identity(dir);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("rdp-loopback-server".to_string())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("server runtime");
            runtime.block_on(async move {
                let mut server = RdpServer::builder()
                    .with_addr(SocketAddr::from(([127, 0, 0, 1], 0)))
                    .with_tls(identity.make_acceptor().expect("TLS acceptor"))
                    .with_no_input()
                    .with_display_handler(PatternDisplay)
                    .build();
                let events = server.event_sender().clone();
                let (addr_tx, addr_rx) = tokio::sync::oneshot::channel();
                events
                    .send(ServerEvent::GetLocalAddr(addr_tx))
                    .expect("server event channel");
                let run = server.run();
                tokio::pin!(run);
                tokio::select! {
                    addr = addr_rx => {
                        let addr = addr.ok().flatten().expect("server bound address");
                        let _ = ready_tx.send((addr, events));
                    }
                    result = &mut run => panic!("RDP server stopped before listening: {result:?}"),
                }
                let _ = run.await;
            });
        })
        .expect("spawn server thread");
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("RDP test server did not start")
}

/// Start a server with the pattern display and decode it with `codecs`.
async fn round_trip(codecs: BitmapCodecs, tolerance: u8) {
    let dir = std::env::temp_dir().join(format!(
        "taomni-rdp-loopback-{}-{}",
        std::process::id(),
        codecs
            .0
            .iter()
            .map(|codec| codec.id.to_string())
            .collect::<Vec<_>>()
            .join("-")
    ));
    let (addr, events) = start_server(&dir);
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        decode_desktop(addr, codecs, tolerance),
    )
    .await;
    let _ = events.send(ServerEvent::Quit("loopback test finished".to_string()));
    let _ = std::fs::remove_dir_all(&dir);
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(error)) => panic!("{error:#}"),
        Err(_) => panic!("loopback round trip timed out"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn taomni_client_decodes_the_codec_the_server_picks_for_it() {
    let codecs = crate::rdp::session::client_bitmap_codecs();
    // The server prefers QOIZ whenever a client offers it, so this exercises
    // the lossless IronRDP codec path end to end.
    assert!(
        codecs.0.iter().any(|codec| codec.id == QOIZ_CODEC_ID),
        "the Taomni client is expected to offer QOIZ"
    );
    round_trip(codecs, 0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mstsc_like_client_decodes_remotefx_from_the_server() {
    // mstsc never offers IronRDP's QOI codecs, so the server falls back to
    // RemoteFX. RemoteFX is lossy, hence the per-channel tolerance.
    let codecs = client_codecs_capabilities(&["remotefx", "qoi:off", "qoiz:off"])
        .expect("RemoteFX-only codec list");
    round_trip(codecs, 24).await;
}
