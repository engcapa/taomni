use super::configuration::MSTSC_LIKE_CODECS;
use super::configuration::parse_compression;
use crate::Args;
use crate::ProbeError;
use crate::audio::ProbeRdpsnd;
use crate::audio_input::AudioInputClient;
use crate::clipboard::ProbeClipboard;
use crate::rfx_stats::RfxStats;
use ironrdp::connector::connection_activation::ConnectionActivationFactory;
use ironrdp::connector::connection_activation::ConnectionActivationSequence;
use ironrdp::input::Database as InputDatabase;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::rdp::autodetect::AutoDetectRequest;
use ironrdp::pdu::rdp::client_info::CompressionType;
use ironrdp::session::ActiveStage;
use ironrdp::session::image::DecodedImage;
use ironrdp_tokio::TokioFramed;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

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
    /// Where to save the decoded framebuffer as PNG whenever a report is built,
    /// so a red run shows exactly what the client saw.
    pub snapshot: Option<PathBuf>,
    /// `client_codecs_capabilities` configuration. The default mimics mstsc,
    /// which offers RemoteFX but none of IronRDP's QOI codecs.
    pub codecs: Vec<String>,
    pub compression: Option<CompressionType>,
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
            snapshot: args.opt("snapshot").map(PathBuf::from),
            compression: parse_compression(&args.str("compression", "rdp61"))?,
            codecs: args
                .str("codecs", MSTSC_LIKE_CODECS)
                .split(',')
                .map(|codec| codec.trim().to_string())
                .filter(|codec| !codec.is_empty())
                .collect(),
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
    pub(super) framed: TokioFramed<Stream>,
    pub active_stage: ActiveStage,
    pub image: DecodedImage,
    pub(super) input: InputDatabase,
    pub(super) activation_factory: ConnectionActivationFactory,
    pub(super) reactivation: Option<ConnectionActivationSequence>,
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
    /// Updates whose union rectangle was empty: frame markers or surface
    /// commands without pixels. Counted apart so "graphics_updates" is not
    /// mistaken for painted content.
    pub empty_updates: u64,
    pub(super) snapshot: Option<PathBuf>,
    /// Bitmap codec ids offered in the client capability set.
    pub(super) advertised_codecs: Vec<u8>,
    /// RemoteFX wire statistics (quantization, tiles, bytes per frame).
    pub(super) rfx: RfxStats,
    pub(super) compression: Option<CompressionType>,
}

pub(crate) type SvcMessagesOf<C> = ironrdp::svc::SvcProcessorMessages<C>;
