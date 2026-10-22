use super::model::PendingSecurity;
use super::model::RfbConnection;
use super::negotiation::SEC_TYPE_ANONYMOUS_TLS;
use crate::vnc::encodings::HextileState;
use crate::vnc::encodings::ZrleDecoder;
use crate::vnc::framebuffer::Framebuffer;
use crate::vnc::limits::DecodeLimits;
use crate::vnc::pixel::PixelConverter;
use crate::vnc::policy::VncSecurityPolicy;
use crate::vnc::rfb::stream;
use crate::vnc::rfb::stream::RUNTIME_READ_BUFFER_BYTES;
use crate::vnc::rfb::stream::ReadBuffer;
use crate::vnc::rfb::stream::RuntimeStats;
use crate::vnc::tight::TightDecoder;
use std::net::TcpStream;
use std::net::ToSocketAddrs;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

impl RfbConnection {
    pub fn connect(host: &str, port: u16) -> Result<Self, String> {
        Self::connect_with_options(
            host,
            port,
            None,
            VncSecurityPolicy::default(),
            DecodeLimits::default(),
        )
    }

    pub fn connect_with_options(
        host: &str,
        port: u16,
        timeout: Option<Duration>,
        security_policy: VncSecurityPolicy,
        limits: DecodeLimits,
    ) -> Result<Self, String> {
        let addr = format!("{}:{}", host, port);
        let timeout = timeout.unwrap_or(Duration::from_secs(15));
        let socket_addr = addr
            .to_socket_addrs()
            .map_err(|e| format!("DNS lookup for {}: {}", host, e))?
            .next()
            .ok_or_else(|| format!("DNS lookup for {} returned no addresses", host))?;
        let stream = TcpStream::connect_timeout(&socket_addr, timeout)
            .map_err(|e| format!("TCP connect to {}: {}", addr, e))?;
        Self::from_stream(stream, timeout, security_policy, limits)
    }

    pub fn from_stream(
        stream: TcpStream,
        timeout: Duration,
        security_policy: VncSecurityPolicy,
        limits: DecodeLimits,
    ) -> Result<Self, String> {
        let mut conn = Self::new_stream(stream, timeout, limits, security_policy, 8, None, None)?;

        conn.handshake_protocol_version()?;
        Ok(conn)
    }

    pub(crate) fn from_negotiated_stream(
        stream: TcpStream,
        timeout: Duration,
        security_policy: VncSecurityPolicy,
        limits: DecodeLimits,
        proto_minor: u8,
        pending_security: Option<PendingSecurity>,
        outer_security_type: Option<u8>,
    ) -> Result<Self, String> {
        Self::new_stream(
            stream,
            timeout,
            limits,
            security_policy,
            proto_minor,
            pending_security,
            outer_security_type,
        )
    }

    pub(super) fn new_stream(
        stream: TcpStream,
        timeout: Duration,
        limits: DecodeLimits,
        security_policy: VncSecurityPolicy,
        proto_minor: u8,
        pending_security: Option<PendingSecurity>,
        outer_security_type: Option<u8>,
    ) -> Result<Self, String> {
        // Tokio's `TcpStream::into_std` intentionally preserves nonblocking
        // mode. The RFB decoder is synchronous, so restore blocking semantics
        // before applying bounded socket timeouts.
        stream
            .set_nonblocking(false)
            .map_err(|e| format!("set blocking mode failed: {}", e))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| format!("set read timeout failed: {}", e))?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|e| format!("set write timeout failed: {}", e))?;
        stream
            .set_nodelay(true)
            .map_err(|e| format!("set_nodelay failed: {}", e))?;

        Ok(Self {
            stream,
            secure_io: None,
            width: 0,
            height: 0,
            name: String::new(),
            security_type: None,
            framebuffer: Framebuffer::empty().shared(),
            scratch: Vec::new(),
            read_buffer: ReadBuffer::new(RUNTIME_READ_BUFFER_BYTES),
            stats: RuntimeStats::default(),
            limits,
            security_policy,
            pending_security,
            outer_security_type,
            proto_minor,
            hextile_state: HextileState::new(),
            zrle_decoder: ZrleDecoder::new(),
            tight_decoder: TightDecoder::new(),
            pixel: PixelConverter::default(),
            pending_pixel_format: Arc::new(Mutex::new(None)),
            shared: true,
        })
    }

    /// ClientInit shared flag; set before authenticating.
    pub fn set_shared(&mut self, shared: bool) {
        self.shared = shared;
    }

    pub fn protocol_version(&self) -> String {
        format!("3.{}", self.proto_minor)
    }

    pub fn security_label(&self) -> String {
        let inner = self
            .security_type
            .and_then(crate::vnc::policy::security_type_kind)
            .map(|kind| kind.label())
            .unwrap_or("Unknown");
        if self.outer_security_type == Some(SEC_TYPE_ANONYMOUS_TLS) {
            format!("TLS (anonymous) + {inner}")
        } else {
            inner.to_string()
        }
    }

    pub fn encrypted(&self) -> bool {
        self.outer_security_type == Some(SEC_TYPE_ANONYMOUS_TLS)
            || self
                .security_type
                .and_then(crate::vnc::policy::security_type_kind)
                .is_some_and(|kind| kind.encrypted())
    }

    pub fn shutdown_handle(&self) -> Result<TcpStream, String> {
        self.stream
            .try_clone()
            .map_err(|e| format!("clone VNC shutdown handle: {e}"))
    }
}
