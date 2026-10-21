//! IronRDP-backed active RDP session driver.
//!
//! This replaces the earlier post-negotiation placeholder with the real
//! IronRDP connection sequence: X.224 negotiation, TLS upgrade, CredSSP/NLA,
//! MCS/channel/capability exchange, active-stage display decoding, and
//! fast-path keyboard/mouse input.

mod lifecycle;
mod output_queue;
pub use lifecycle::*;
mod clipboard;
pub use clipboard::*;
mod audio;
use audio::*;
mod input;
use input::*;
mod display;
use display::*;
mod events;
use events::*;
mod configuration;
pub use configuration::*;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, Once};

use image::{ColorType, ImageEncoder};
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardFormatName,
    ClipboardGeneralCapabilityFlags, ClipboardPdu, FileContentsFlags, FileContentsRequest,
    FileContentsResponse, FileDescriptor as IronClipboardFileDescriptor, FormatDataRequest,
    FormatDataResponse, LockDataId, OwnedFormatDataResponse, PackedFileList,
};
use ironrdp::connector::connection_activation::{
    ConnectionActivationFactory, ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp::connector::{self, Credentials, Sequence};
use ironrdp::core::{AsAny, IntoOwned, WriteBuf};
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::graphics::pointer::DecodedPointer;
use ironrdp::input::{
    Database as InputDatabase, MouseButton, MousePosition, Operation, Scancode, WheelRotations,
};
use ironrdp::pdu::Action;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::{PerformanceFlags as IronPerformanceFlags, TimezoneInfo};
use ironrdp::pdu::rdp::headers::ShareDataPdu;
use ironrdp::pdu::rdp::refresh_rectangle::RefreshRectanglePdu;
use ironrdp::rdpsnd::client::{Rdpsnd, RdpsndClientHandler};
use ironrdp::rdpsnd::pdu::{
    AudioFormat as IronAudioFormat, PitchPdu, VolumePdu, WaveFormat as IronWaveFormat,
};
use ironrdp::session::image::DecodedImage as IronDecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp::svc::{ChannelFlags, SvcMessage, SvcProcessorMessages};
use ironrdp_tokio::{Framed, FramedRead, FramedWrite};
use serde_json::json;
use tokio::sync::Notify;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::rdp::RdpOptions;
use crate::rdp::frame::{DecodedTile, TileHeader};
use crate::rdp::input::{KeyEvent, PointerEvent, PointerWheelEvent};
use crate::rdp::transport::{RdpStream, open_transport};
use crate::rdp::ws::{RdpControl, channel, cursor, frame_payload_with_header};
use crate::terminal::network::NetworkSettings;

/// Output yielded from the session toward the WS layer.
pub enum SessionOutput {
    Channel { tag: u8, payload: Vec<u8> },
    Text(String),
}

const MAX_PENDING_SESSION_STATUS: usize = 256;
const MAX_FRAME_BATCH_BYTES: usize = 64 * 1024 * 1024;

enum QueuedSessionOutput {
    Control(SessionOutput),
    FrameBatch(Vec<Vec<u8>>),
}

struct SessionOutputState {
    control: std::collections::VecDeque<SessionOutput>,
    building_frame: Vec<Vec<u8>>,
    building_bytes: usize,
    drop_building_frame: bool,
    pending_frame: Vec<Vec<u8>>,
    pending_frame_bytes: usize,
    closed: bool,
}

/// Bounded output relay. RDP graphics updates are incremental dirty rectangles,
/// so pending batches must be appended in order rather than replaced by the
/// newest batch. Replacing one batch leaves untouched canvas regions stale or
/// black. Status, cursor, audio and clipboard messages use a separate bounded
/// reliable queue.
struct SessionOutputQueue {
    state: Mutex<SessionOutputState>,
    wake: Notify,
    space: Condvar,
}

#[derive(Clone)]
pub struct SessionOutputSender(Arc<SessionOutputQueue>);

enum ActiveOutputFlow {
    Continue,
    Terminate,
    Reactivate,
}

pub struct RdpSessionHandle {
    output: Arc<SessionOutputQueue>,
    active_frame: VecDeque<SessionOutput>,
    /// Sends control input from the relay into the session worker.
    ctrl_tx: UnboundedSender<RdpControl>,
}

pub struct RdpSessionConfig {
    pub stream: RdpStream,
    pub local_addr: std::net::SocketAddr,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub options: RdpOptions,
    pub network: Option<NetworkSettings>,
}

struct RdpConnectionSettings {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options: RdpOptions,
    network: Option<NetworkSettings>,
}

struct RdpSessionTransport {
    stream: RdpStream,
    local_addr: std::net::SocketAddr,
}

enum SessionRunOutcome {
    Closed,
    Reconnect { width: u16, height: u16 },
}

enum ControlOutcome {
    Continue,
    Disconnect,
    Reconnect { width: u16, height: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RdpConnectionTestResult {
    pub width: u16,
    pub height: u16,
    pub protocol: String,
    pub server_name: String,
}

const AUDIO_SAMPLE_RATE: u32 = 44_100;
const AUDIO_CHANNELS: u16 = 2;
const AUDIO_BITS_PER_SAMPLE: u16 = 16;
const CLIPRDR_FILE_LIST_FORMAT_VALUE: u32 = 0x0000_C006;
const MAX_CLIPBOARD_FILE_ITEMS: usize = 256;
const MAX_CLIPBOARD_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CLIPBOARD_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const REMOTE_FILE_CHUNK_SIZE: u32 = 1024 * 1024;
const RDP_NEGOTIATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const RDP_TLS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const RDP_AUTHENTICATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

#[derive(Clone)]
struct ClipboardBridge {
    state: Arc<Mutex<ClipboardBridgeState>>,
    out_tx: SessionOutputSender,
}

struct ClipboardBridgeState {
    local_text: Option<String>,
    local_files: Vec<LocalClipboardFile>,
    pending_remote_format: Option<ClipboardFormatId>,
    remote_file_transfer: Option<RemoteFileTransfer>,
    completed_remote_staging: Vec<StagingDirectory>,
    actions: VecDeque<ClipboardAction>,
    ready: bool,
    negotiated_capabilities: ClipboardGeneralCapabilityFlags,
}

enum ClipboardAction {
    AdvertiseFormats(Vec<ClipboardFormat>),
    RequestRemoteData(ClipboardFormatId),
    RequestRemoteFileContents(Vec<FileContentsRequest>),
    SubmitFormatData(OwnedFormatDataResponse),
    SubmitFileContents(FileContentsResponse<'static>),
}

#[derive(Clone, Debug)]
struct LocalClipboardFile {
    path: PathBuf,
    name: String,
    size: u64,
    is_directory: bool,
    attributes: ClipboardFileAttributes,
}

#[derive(Clone, Debug)]
struct RemoteClipboardFile {
    path: PathBuf,
    size: u64,
    is_directory: bool,
}

#[derive(Clone, Debug)]
struct RemoteFileStream {
    index: usize,
    position: u64,
}

#[derive(Debug)]
struct RemoteFileTransfer {
    staging: StagingDirectory,
    files: Vec<RemoteClipboardFile>,
    top_level_paths: Vec<PathBuf>,
    streams: HashMap<u32, RemoteFileStream>,
    next_stream_id: u32,
    received_bytes: u64,
}

#[derive(Debug)]
struct StagingDirectory(PathBuf);

struct TaomniCliprdrBackend {
    bridge: ClipboardBridge,
    temporary_directory: String,
}

struct RdpsndWsBackend {
    out_tx: SessionOutputSender,
    formats: Vec<IronAudioFormat>,
}
