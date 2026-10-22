use crate::vnc::clipboard::ExtendedClipboardMsg;
use crate::vnc::encodings::DecodedCursor;
use crate::vnc::encodings::DecodedPointerPosition;
use crate::vnc::encodings::HextileState;
use crate::vnc::encodings::ZrleDecoder;
use crate::vnc::framebuffer::FbRect;
use crate::vnc::framebuffer::SharedFramebuffer;
use crate::vnc::limits::DecodeLimits;
use crate::vnc::pixel::PixelConverter;
use crate::vnc::pixel::PixelFormat;
use crate::vnc::policy::VncSecurityPolicy;
use crate::vnc::rfb::security::AesEax;
use crate::vnc::rfb::security::RsaAesIo;
use crate::vnc::rfb::stream::ReadBuffer;
use crate::vnc::rfb::stream::RuntimeStats;
use crate::vnc::tight::TightDecoder;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Debug)]
pub struct ServerInit {
    pub width: u16,
    pub height: u16,
    pub name: String,
}

pub struct RfbConnection {
    pub(super) stream: TcpStream,
    pub(super) secure_io: Option<RsaAesIo>,
    pub width: u16,
    pub height: u16,
    pub name: String,
    pub security_type: Option<u8>,
    /// Authoritative RGBA framebuffer shared with the relay, which reads the
    /// newest pixels of damaged regions when the WebView is ready.
    pub(super) framebuffer: SharedFramebuffer,
    /// Reused per-rectangle decode target (`w*h*4`).
    pub(super) scratch: Vec<u8>,
    /// Userspace read buffer for the plaintext runtime stream. Decoders issue
    /// many 1-4 byte reads; without it each was a socket syscall.
    pub(super) read_buffer: ReadBuffer,
    pub(super) stats: RuntimeStats,
    pub(super) limits: DecodeLimits,
    pub(super) security_policy: VncSecurityPolicy,
    pub(super) pending_security: Option<PendingSecurity>,
    pub(super) outer_security_type: Option<u8>,
    /// Negotiated protocol minor version (3, 7, or 8).
    pub(super) proto_minor: u8,
    /// Hextile bg/fg carry across tiles per the RFB spec.
    pub(super) hextile_state: HextileState,
    /// ZRLE uses a single zlib stream for the whole session.
    pub(super) zrle_decoder: ZrleDecoder,
    /// Tight keeps four zlib streams for the whole session.
    pub(super) tight_decoder: TightDecoder,
    /// Wire pixel format of the rectangles currently being decoded.
    pub(super) pixel: PixelConverter,
    /// A SetPixelFormat the writer sent while no update was outstanding; the
    /// next FramebufferUpdate is the first one in that format.
    pub(super) pending_pixel_format: Arc<Mutex<Option<PixelFormat>>>,
    /// ClientInit shared flag (RealVNC `Shared`, default true).
    pub(super) shared: bool,
}

#[derive(Debug, Clone)]
pub(crate) enum PendingSecurity {
    V33(u32),
    Selected(u8),
}

pub struct RfbWriter {
    pub(super) stream: TcpStream,
    pub(super) secure_output: Option<AesEax>,
    pub(super) width: u16,
    pub(super) height: u16,
    pub(super) pending_pixel_format: Arc<Mutex<Option<PixelFormat>>>,
}

#[derive(Debug)]
pub enum ServerMessage {
    FramebufferUpdate {
        /// Damaged framebuffer regions; pixels live in `RfbConnection::framebuffer()`.
        rects: Vec<FbRect>,
        cursor: Option<DecodedCursor>,
        pointer_pos: Option<DecodedPointerPosition>,
    },
    SetColourMapEntries,
    Bell,
    ServerCutText {
        text: String,
    },
    ExtendedClipboard(ExtendedClipboardMsg),
}
