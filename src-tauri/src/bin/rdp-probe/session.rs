//! Connection sequence and active-stage pump shared by every probe scenario.
//!
//! Mirrors the Taomni client's proven order (`src/rdp/session.rs`
//! `drive_ironrdp_connection`): X.224 negotiation → TLS → CredSSP/NLA →
//! capability exchange → active stage. Unlike the product client, the probe
//! accepts any server certificate (it targets disposable local servers) but
//! records the SHA-256 fingerprint so a report can still identify the server.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ironrdp::cliprdr::CliprdrClient;
use ironrdp::connector::connection_activation::{
    ConnectionActivationFactory, ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp::connector::{self, Credentials, Sequence};
use ironrdp::core::WriteBuf;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{Database as InputDatabase, MouseButton, MousePosition, Operation};
use ironrdp::pdu::Action;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::rdp::autodetect::AutoDetectRequest;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::pdu::rdp::headers::ShareDataPdu;
use ironrdp::pdu::rdp::refresh_rectangle::RefreshRectanglePdu;
use ironrdp::rdpsnd::client::Rdpsnd;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::{FramedWrite, TokioFramed};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use x509_cert::der::Decode;

use crate::audio::ProbeRdpsnd;
use crate::audio_input::AudioInputClient;
use crate::clipboard::ProbeClipboard;
use crate::{Args, ProbeError};

pub(crate) type Stream = TlsStream<TcpStream>;

/// Which optional channels a scenario wants negotiated.
#[derive(Default)]
pub(crate) struct ChannelPlan {
    pub clipboard: Option<ProbeClipboard>,
    pub audio: Option<ProbeRdpsnd>,
    pub audio_input: Option<AudioInputClient>,
}

#[derive(Clone)]
pub(crate) struct ConnectOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
    pub alternate_shell: String,
    pub work_dir: String,
    pub timeout: Duration,
}

impl ConnectOptions {
    pub fn from_args(args: &Args) -> Result<Self, ProbeError> {
        let password_env = args.str("password-env", "QA_RDP_PASSWORD");
        let password = std::env::var(&password_env).map_err(|_| {
            ProbeError::usage(format!(
                "password environment variable {password_env} is not set"
            ))
        })?;
        let user = args
            .opt("user")
            .ok_or_else(|| ProbeError::usage("--user is required"))?;
        let port = u16::try_from(args.u64("port", 3389)?)
            .map_err(|_| ProbeError::usage("--port must fit in 16 bits"))?;
        let width = u16::try_from(args.u64("width", 1280)?)
            .map_err(|_| ProbeError::usage("--width out of range"))?;
        let height = u16::try_from(args.u64("height", 720)?)
            .map_err(|_| ProbeError::usage("--height out of range"))?;
        Ok(Self {
            host: args.str("host", "127.0.0.1"),
            port,
            user,
            password,
            domain: args.opt("domain"),
            width: width.clamp(200, 8192) & !1,
            height: height.clamp(200, 8192),
            alternate_shell: args.str("alternate-shell", ""),
            work_dir: args.str("work-dir", ""),
            timeout: Duration::from_secs(args.u64("connect-timeout-sec", 30)?),
        })
    }
}

/// Something the active stage produced that a scenario may care about.
/// Payload fields are kept for `Debug` diagnostics even where a scenario only
/// matches the variant.
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum PumpEvent {
    Graphics(InclusiveRectangle),
    PointerBitmap,
    PointerPosition,
    AutoDetect(AutoDetectRequest),
    Reactivated { width: u16, height: u16 },
}

pub(crate) struct ProbeSession {
    framed: TokioFramed<Stream>,
    pub active_stage: ActiveStage,
    pub image: DecodedImage,
    input: InputDatabase,
    activation_factory: ConnectionActivationFactory,
    reactivation: Option<ConnectionActivationSequence>,
    pub connected_at: Instant,
    pub connect_ms: u64,
    pub first_graphics_ms: Option<u64>,
    pub bytes_in: u64,
    pub pdus_in: u64,
    pub graphics_updates: u64,
    pub pointer_updates: u64,
    pub fingerprint: String,
    pub channels: Vec<&'static str>,
    pub terminated: Option<String>,
}

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

async fn tls_upgrade(stream: TcpStream, host: &str) -> Result<(Stream, Vec<u8>, String), String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS protocol versions: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();
    let domain = ServerName::try_from(host.to_owned()).map_err(|e| format!("server name: {e}"))?;
    let mut tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(domain, stream)
        .await
        .map_err(|e| format!("TLS handshake: {e}"))?;
    tls.flush().await.map_err(|e| format!("TLS flush: {e}"))?;
    let cert_der = tls
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .ok_or_else(|| "server presented no certificate".to_string())?;
    let cert = x509_cert::Certificate::from_der(cert_der.as_ref())
        .map_err(|e| format!("server certificate: {e}"))?;
    let public_key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| "server public key is not byte aligned".to_string())?
        .to_vec();
    let fingerprint = hex::encode(Sha256::digest(cert_der.as_ref()));
    Ok((tls, public_key, fingerprint))
}

fn connector_config(opts: &ConnectOptions, audio_playback: bool) -> connector::Config {
    let codecs = ironrdp::pdu::rdp::capability_sets::client_codecs_capabilities(&["remotefx"])
        .unwrap_or_default();
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: opts.user.clone(),
            password: opts.password.clone(),
        },
        domain: opts.domain.clone(),
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        alternate_shell: opts.alternate_shell.clone(),
        work_dir: opts.work_dir.clone(),
        desktop_size: connector::DesktopSize {
            width: opts.width,
            height: opts.height,
        },
        desktop_scale_factor: 0,
        bitmap: Some(connector::BitmapConfig {
            lossy_compression: false,
            color_depth: 32,
            codecs,
        }),
        client_build: 0,
        client_name: "taomni-probe".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: MajorPlatformType::WINDOWS,
        enable_server_pointer: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: audio_playback,
        pointer_software_rendering: false,
        performance_flags: PerformanceFlags::DISABLE_WALLPAPER
            | PerformanceFlags::DISABLE_MENUANIMATIONS
            | PerformanceFlags::DISABLE_CURSOR_SHADOW,
        hardware_id: None,
        license_cache: None::<Arc<dyn connector::LicenseCache>>,
        timezone_info: TimezoneInfo::default(),
        compression_type: None,
        multitransport_flags: None,
    }
}

/// Errors from the CredSSP stage that mean "the server refused these
/// credentials" rather than "the transport failed".
fn looks_like_auth_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "logon",
        "credssp",
        "authentication",
        "ntlm",
        "access denied",
        "access_denied",
        "invalid credentials",
        "0xc000006d",
        "0x8009030c",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

impl ProbeSession {
    pub async fn connect(opts: &ConnectOptions, plan: ChannelPlan) -> Result<Self, ProbeError> {
        let started = Instant::now();
        let addr = format!("{}:{}", opts.host, opts.port);
        let tcp = tokio::time::timeout(opts.timeout, TcpStream::connect(&addr))
            .await
            .map_err(|_| ProbeError::connection(format!("TCP connect to {addr} timed out")))?
            .map_err(|e| ProbeError::connection(format!("TCP connect to {addr}: {e}")))?;
        let _ = tcp.set_nodelay(true);
        let local_addr: SocketAddr = tcp
            .local_addr()
            .map_err(|e| ProbeError::connection(format!("local address: {e}")))?;

        let mut channels = Vec::new();
        let mut connector =
            connector::ClientConnector::new(connector_config(opts, plan.audio.is_some()), local_addr);
        if let Some(clipboard) = plan.clipboard {
            connector.attach_static_channel(CliprdrClient::new(Box::new(clipboard)));
            channels.push("cliprdr");
        }
        if let Some(audio) = plan.audio {
            connector.attach_static_channel(Rdpsnd::new(Box::new(audio)));
            channels.push("rdpsnd");
        }
        let mut drdynvc = DrdynvcClient::new()
            .with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(Vec::new())));
        if let Some(audio_input) = plan.audio_input {
            drdynvc = drdynvc.with_dynamic_channel(audio_input);
            channels.push("audio_input");
        }
        connector.attach_static_channel(drdynvc);
        channels.push("drdynvc");

        let mut framed = ironrdp_tokio::TokioFramed::new(tcp);
        let should_upgrade = tokio::time::timeout(
            opts.timeout,
            ironrdp_tokio::connect_begin(&mut framed, &mut connector),
        )
        .await
        .map_err(|_| ProbeError::connection("RDP negotiation timed out"))?
        .map_err(|e| ProbeError::connection(format!("RDP negotiation: {e}")))?;
        let tcp = framed.into_inner_no_leftover();
        let (tls, public_key, fingerprint) =
            tokio::time::timeout(opts.timeout, tls_upgrade(tcp, &opts.host))
                .await
                .map_err(|_| ProbeError::connection("TLS upgrade timed out"))?
                .map_err(ProbeError::connection)?;
        let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
        let mut framed = ironrdp_tokio::TokioFramed::new(tls);
        let mut network_client = ironrdp_tokio::reqwest::ReqwestNetworkClient::new();
        let result = tokio::time::timeout(
            opts.timeout,
            ironrdp_tokio::connect_finalize(
                upgraded,
                connector,
                &mut framed,
                &mut network_client,
                opts.host.clone().into(),
                public_key,
                None,
            ),
        )
        .await
        .map_err(|_| ProbeError::connection("CredSSP/connection finalization timed out"))?
        .map_err(|e| {
            let message = format!("RDP connection finalization: {e}");
            if looks_like_auth_failure(&message) {
                ProbeError {
                    kind: crate::ErrorKind::Auth,
                    message,
                }
            } else {
                ProbeError::connection(message)
            }
        })?;

        let width = result.desktop_size.width;
        let height = result.desktop_size.height;
        let activation_factory = result.activation_factory.clone();
        let active_stage = ActiveStageBuilder {
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
        Ok(Self {
            framed,
            active_stage,
            image: DecodedImage::new(PixelFormat::RgbA32, width, height),
            input: InputDatabase::new(),
            activation_factory,
            reactivation: None,
            connected_at: Instant::now(),
            connect_ms: started.elapsed().as_millis() as u64,
            first_graphics_ms: None,
            bytes_in: 0,
            pdus_in: 0,
            graphics_updates: 0,
            pointer_updates: 0,
            fingerprint,
            channels,
            terminated: None,
        })
    }

    pub fn width(&self) -> u16 {
        self.image.width()
    }

    pub fn height(&self) -> u16 {
        self.image.height()
    }

    /// RGBA of one desktop pixel, or `None` outside the framebuffer.
    pub fn pixel(&self, x: u16, y: u16) -> Option<[u8; 4]> {
        if x >= self.image.width() || y >= self.image.height() {
            return None;
        }
        let stride = usize::from(self.image.width()) * 4;
        let offset = usize::from(y) * stride + usize::from(x) * 4;
        self.image
            .data()
            .get(offset..offset + 4)
            .map(|px| [px[0], px[1], px[2], px[3]])
    }

    /// Cheap fingerprint of a rectangle sampled on a sparse grid; used to count
    /// visible changes without hashing the whole framebuffer per update.
    pub fn region_signature(&self, rect: (u16, u16, u16, u16)) -> u64 {
        let (x, y, w, h) = rect;
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let steps_x = 32u16.min(w.max(1));
        let steps_y = 18u16.min(h.max(1));
        for sy in 0..steps_y {
            for sx in 0..steps_x {
                let px = x.saturating_add(sx.saturating_mul(w) / steps_x);
                let py = y.saturating_add(sy.saturating_mul(h) / steps_y);
                if let Some(value) = self.pixel(px, py) {
                    for byte in &value[..3] {
                        hash ^= u64::from(*byte);
                        hash = hash.wrapping_mul(0x0100_0000_01b3);
                    }
                }
            }
        }
        hash
    }

    /// Process at most one server PDU (waiting up to `wait`). Returns the
    /// events it produced; an empty vector means the wait elapsed.
    pub async fn pump(&mut self, wait: Duration) -> Result<Vec<PumpEvent>, ProbeError> {
        let read = match tokio::time::timeout(wait, self.framed.read_pdu()).await {
            Err(_) => return Ok(Vec::new()),
            Ok(read) => read,
        };
        let (action, payload) =
            read.map_err(|e| ProbeError::connection(format!("RDP read: {e}")))?;
        self.pdus_in += 1;
        self.bytes_in += payload.len() as u64;
        if let Some(sequence) = self.reactivation.as_mut() {
            if !matches!(action, Action::X224) {
                return Ok(Vec::new());
            }
            let mut output = WriteBuf::new();
            sequence
                .step(&payload, &mut output)
                .map_err(|e| ProbeError::connection(format!("reactivation: {e}")))?;
            loop {
                if !output.filled().is_empty() {
                    self.framed
                        .write_all(output.filled())
                        .await
                        .map_err(|e| ProbeError::connection(format!("reactivation write: {e}")))?;
                }
                if let ConnectionActivationState::Finalized {
                    desktop_size,
                    enable_server_pointer,
                    ..
                } = sequence.connection_activation_state()
                {
                    self.active_stage
                        .set_enable_server_pointer(enable_server_pointer);
                    self.image = DecodedImage::new(
                        PixelFormat::RgbA32,
                        desktop_size.width,
                        desktop_size.height,
                    );
                    self.reactivation = None;
                    self.request_refresh().await?;
                    return Ok(vec![PumpEvent::Reactivated {
                        width: desktop_size.width,
                        height: desktop_size.height,
                    }]);
                }
                if sequence.next_pdu_hint().is_some() {
                    return Ok(Vec::new());
                }
                output.clear();
                sequence
                    .step_no_input(&mut output)
                    .map_err(|e| ProbeError::connection(format!("reactivation step: {e}")))?;
            }
        }
        let outputs = self
            .active_stage
            .process(&mut self.image, action, &payload)
            .map_err(|e| ProbeError::connection(format!("active stage: {e}")))?;
        self.handle_outputs(outputs).await
    }

    async fn handle_outputs(
        &mut self,
        outputs: Vec<ActiveStageOutput>,
    ) -> Result<Vec<PumpEvent>, ProbeError> {
        let mut events = Vec::new();
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    if !frame.is_empty() {
                        self.framed
                            .write_all(&frame)
                            .await
                            .map_err(|e| ProbeError::connection(format!("RDP write: {e}")))?;
                    }
                }
                ActiveStageOutput::GraphicsUpdate(rect) => {
                    self.graphics_updates += 1;
                    if self.first_graphics_ms.is_none() {
                        self.first_graphics_ms =
                            Some(self.connected_at.elapsed().as_millis() as u64 + self.connect_ms);
                    }
                    events.push(PumpEvent::Graphics(rect));
                }
                ActiveStageOutput::PointerBitmap(_) => {
                    self.pointer_updates += 1;
                    events.push(PumpEvent::PointerBitmap);
                }
                ActiveStageOutput::PointerPosition { .. } => {
                    self.pointer_updates += 1;
                    events.push(PumpEvent::PointerPosition);
                }
                ActiveStageOutput::PointerDefault | ActiveStageOutput::PointerHidden => {
                    self.pointer_updates += 1;
                }
                ActiveStageOutput::AutoDetect(request) => {
                    events.push(PumpEvent::AutoDetect(request));
                }
                ActiveStageOutput::Terminate(reason) => {
                    self.terminated = Some(reason.description().to_string());
                }
                ActiveStageOutput::DeactivateAll => {
                    self.reactivation = Some(self.activation_factory.create());
                }
                ActiveStageOutput::MultitransportRequest(_) => {}
            }
        }
        Ok(events)
    }

    /// Ask the server to repaint the whole desktop (RefreshRectangle PDU).
    pub async fn request_refresh(&mut self) -> Result<(), ProbeError> {
        let (width, height) = (self.image.width(), self.image.height());
        if width == 0 || height == 0 {
            return Ok(());
        }
        let pdu = ShareDataPdu::RefreshRectangle(RefreshRectanglePdu {
            areas_to_refresh: vec![InclusiveRectangle {
                left: 0,
                top: 0,
                right: width - 1,
                bottom: height - 1,
            }],
        });
        let mut output = WriteBuf::new();
        self.active_stage
            .encode_static(&mut output, pdu)
            .map_err(|e| ProbeError::connection(format!("refresh encode: {e}")))?;
        self.write_raw(output.filled()).await
    }

    pub async fn write_raw(&mut self, bytes: &[u8]) -> Result<(), ProbeError> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.framed
            .write_all(bytes)
            .await
            .map_err(|e| ProbeError::connection(format!("RDP write: {e}")))
    }

    pub async fn send_operations(&mut self, ops: Vec<Operation>) -> Result<(), ProbeError> {
        let events = self.input.apply(ops);
        if events.is_empty() {
            return Ok(());
        }
        let outputs = self
            .active_stage
            .process_fastpath_input(&mut self.image, &events)
            .map_err(|e| ProbeError::connection(format!("input encode: {e}")))?;
        let _ = self.handle_outputs(outputs).await?;
        Ok(())
    }

    pub async fn click(&mut self, x: u16, y: u16) -> Result<(), ProbeError> {
        self.send_operations(vec![
            Operation::MouseMove(MousePosition { x, y }),
            Operation::MouseButtonPressed(MouseButton::Left),
        ])
        .await?;
        self.send_operations(vec![Operation::MouseButtonReleased(MouseButton::Left)])
            .await
    }

    pub async fn type_char(&mut self, ch: char) -> Result<(), ProbeError> {
        self.send_operations(vec![
            Operation::UnicodeKeyPressed(ch),
            Operation::UnicodeKeyReleased(ch),
        ])
        .await
    }

    /// Flush messages a static-channel backend queued (clipboard, audio input).
    pub async fn send_svc_messages<C>(
        &mut self,
        messages: ironrdp::svc::SvcProcessorMessages<C>,
    ) -> Result<(), ProbeError>
    where
        C: ironrdp::svc::SvcProcessor + 'static,
    {
        let frame = self
            .active_stage
            .process_svc_processor_messages(messages)
            .map_err(|e| ProbeError::connection(format!("SVC encode: {e}")))?;
        self.write_raw(&frame).await
    }

    /// Encode pending DVC messages of a dynamic channel client.
    pub async fn send_dvc_messages(
        &mut self,
        channel_id: u32,
        messages: Vec<ironrdp::dvc::DvcMessage>,
    ) -> Result<(), ProbeError> {
        if messages.is_empty() {
            return Ok(());
        }
        let svc_messages = ironrdp::dvc::encode_dvc_messages(
            channel_id,
            messages,
            ironrdp::svc::ChannelFlags::empty(),
        )
        .map_err(|e| ProbeError::connection(format!("DVC encode: {e}")))?;
        let drdynvc = SvcMessagesOf::<DrdynvcClient>::new(svc_messages);
        self.send_svc_messages(drdynvc).await
    }

    /// Pump until `deadline`, returning every event. Stops early on terminate.
    pub async fn pump_until(&mut self, deadline: Instant) -> Result<Vec<PumpEvent>, ProbeError> {
        let mut all = Vec::new();
        while Instant::now() < deadline && self.terminated.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            all.extend(self.pump(left.min(Duration::from_millis(200))).await?);
        }
        Ok(all)
    }

    /// Wait until the first graphics update arrives (or fail).
    pub async fn wait_first_frame(&mut self, limit: Duration) -> Result<(), ProbeError> {
        let deadline = Instant::now() + limit;
        while self.first_graphics_ms.is_none() {
            if Instant::now() >= deadline {
                return Err(ProbeError::unmet(format!(
                    "no graphics update within {} ms after activation",
                    limit.as_millis()
                )));
            }
            if let Some(reason) = &self.terminated {
                return Err(ProbeError::connection(format!(
                    "server terminated the session: {reason}"
                )));
            }
            let _ = self.pump(Duration::from_millis(200)).await?;
        }
        Ok(())
    }

    /// Common facts every report includes.
    pub fn summary(&mut self) -> serde_json::Value {
        serde_json::json!({
            "connect_ms": self.connect_ms,
            "first_graphics_ms": self.first_graphics_ms,
            "desktop": { "width": self.width(), "height": self.height() },
            "bytes_in": self.bytes_in,
            "pdus_in": self.pdus_in,
            "graphics_updates": self.graphics_updates,
            "pointer_updates": self.pointer_updates,
            "server_cert_sha256": self.fingerprint,
            "requested_channels": self.channels,
            "negotiated": {
                "cliprdr": self.active_stage.get_svc_processor::<CliprdrClient>().is_some(),
                "rdpsnd": self.active_stage.get_svc_processor::<Rdpsnd>().is_some(),
                "drdynvc": self.active_stage.get_svc_processor::<DrdynvcClient>().is_some(),
            },
            "terminated": self.terminated,
        })
    }
}

pub(crate) type SvcMessagesOf<C> = ironrdp::svc::SvcProcessorMessages<C>;
