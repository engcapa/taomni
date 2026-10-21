mod stream;
pub use stream::*;
mod security;
mod writer;
pub use security::*;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::io::{Error, ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::vnc::clipboard::{
    ExtendedClipboardMsg, decode_legacy_cut_text, encode_legacy_cut_text,
    parse_extended_body_with_limits,
};
use crate::vnc::encodings::{
    self, DecodedCursor, DecodedPointerPosition, ENCODING_DESKTOP_SIZE, ENCODING_POINTER_POS,
    ENCODING_RICH_CURSOR, ENCODING_X_CURSOR, HextileState, ZrleDecoder,
};
use crate::vnc::framebuffer::{FbRect, Framebuffer, SharedFramebuffer};
use crate::vnc::limits::DecodeLimits;
use crate::vnc::pixel::{PixelConverter, PixelFormat};
use crate::vnc::policy::VncSecurityPolicy;
use crate::vnc::tight::{self, ENCODING_TIGHT, TightDecoder};

const SEC_TYPE_NONE: u8 = 1;
const SEC_TYPE_VNC_AUTH: u8 = 2;
const SEC_TYPE_RA2_128: u8 = 5;
const SEC_TYPE_RA2NE_128: u8 = 6;
pub(crate) const SEC_TYPE_ANONYMOUS_TLS: u8 = 18;
const SEC_TYPE_RA2_256: u8 = 129;
const SEC_TYPE_RA2NE_256: u8 = 130;
/// Apple Remote Desktop (macOS Screen Sharing).
const SEC_TYPE_ARD: u8 = 30;
/// Diffie-Hellman modulus sizes accepted for ARD (macOS sends 128 bytes).
const ARD_MIN_KEY_BYTES: usize = 64;
const ARD_MAX_KEY_BYTES: usize = 1024;
/// Username and password are NUL-terminated in 64-byte fields.
const ARD_FIELD_BYTES: usize = 64;

/// The chosen security type needs a password the caller did not supply; the
/// attempt stops before any challenge is answered so the viewer can ask
/// (DEC-VNC-21). `VncError::classify` maps it to `credentials-required`.
pub(crate) const CREDENTIALS_REQUIRED: &str =
    "credentials required: the server asks for a password to log in";

/// Security types that authenticate with a password.
fn needs_password(sec_type: u8) -> bool {
    matches!(
        sec_type,
        SEC_TYPE_VNC_AUTH
            | SEC_TYPE_RA2_128
            | SEC_TYPE_RA2NE_128
            | SEC_TYPE_RA2_256
            | SEC_TYPE_RA2NE_256
            | SEC_TYPE_ARD
    )
}

fn missing_password(password: Option<&str>) -> bool {
    password.is_none_or(str::is_empty)
}

const RA2_SUBTYPE_USER_PASS: u8 = 1;
const RA2_SUBTYPE_PASS: u8 = 2;
const RA2_MIN_KEY_BITS: usize = 1024;
const RA2_MAX_KEY_BITS: usize = 8192;
const RA2_AES_FRAME_MAX: usize = 8192;

pub(crate) fn negotiate_protocol_version(
    server_banner: &[u8; 12],
) -> Result<([u8; 12], u8), String> {
    if &server_banner[..4] != b"RFB " || server_banner[11] != b'\n' {
        return Err(format!(
            "invalid RFB version: {:?}",
            String::from_utf8_lossy(server_banner)
        ));
    }

    let major: u32 = std::str::from_utf8(&server_banner[4..7])
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3);
    let minor: u32 = std::str::from_utf8(&server_banner[8..11])
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3);

    let (reply, negotiated_minor) = if major > 3 || minor >= 8 {
        (*b"RFB 003.008\n", 8)
    } else if minor >= 7 {
        (*b"RFB 003.007\n", 7)
    } else {
        (*b"RFB 003.003\n", 3)
    };
    Ok((reply, negotiated_minor))
}

fn authentication_read_error(action: &str, error: Error) -> String {
    if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
        format!("VNC authentication timed out while {action}")
    } else {
        format!("VNC authentication failed while {action}: {error}")
    }
}

#[derive(Debug)]
pub struct ServerInit {
    pub width: u16,
    pub height: u16,
    pub name: String,
}

pub struct RfbConnection {
    stream: TcpStream,
    secure_io: Option<RsaAesIo>,
    pub width: u16,
    pub height: u16,
    pub name: String,
    pub security_type: Option<u8>,
    /// Authoritative RGBA framebuffer shared with the relay, which reads the
    /// newest pixels of damaged regions when the WebView is ready.
    framebuffer: SharedFramebuffer,
    /// Reused per-rectangle decode target (`w*h*4`).
    scratch: Vec<u8>,
    /// Userspace read buffer for the plaintext runtime stream. Decoders issue
    /// many 1-4 byte reads; without it each was a socket syscall.
    read_buffer: ReadBuffer,
    stats: RuntimeStats,
    limits: DecodeLimits,
    security_policy: VncSecurityPolicy,
    pending_security: Option<PendingSecurity>,
    outer_security_type: Option<u8>,
    /// Negotiated protocol minor version (3, 7, or 8).
    proto_minor: u8,
    /// Hextile bg/fg carry across tiles per the RFB spec.
    hextile_state: HextileState,
    /// ZRLE uses a single zlib stream for the whole session.
    zrle_decoder: ZrleDecoder,
    /// Tight keeps four zlib streams for the whole session.
    tight_decoder: TightDecoder,
    /// Wire pixel format of the rectangles currently being decoded.
    pixel: PixelConverter,
    /// A SetPixelFormat the writer sent while no update was outstanding; the
    /// next FramebufferUpdate is the first one in that format.
    pending_pixel_format: Arc<Mutex<Option<PixelFormat>>>,
    /// ClientInit shared flag (RealVNC `Shared`, default true).
    shared: bool,
}

#[derive(Debug, Clone)]
pub(crate) enum PendingSecurity {
    V33(u32),
    Selected(u8),
}

pub struct RfbWriter {
    stream: TcpStream,
    secure_output: Option<AesEax>,
    width: u16,
    height: u16,
    pending_pixel_format: Arc<Mutex<Option<PixelFormat>>>,
}

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

    fn new_stream(
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

    /// Perform protocol version handshake.
    /// Negotiates the highest mutually supported minor version (3, 7, or 8).
    fn handshake_protocol_version(&mut self) -> Result<(), String> {
        let mut buf = [0u8; 12];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read protocol version: {}", e))?;

        let (reply, negotiated_minor) = negotiate_protocol_version(&buf)?;

        self.proto_minor = negotiated_minor;

        self.write_all(&reply)
            .map_err(|e| format!("write protocol version: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Perform security handshake and return ServerInit on success.
    pub fn authenticate(
        &mut self,
        username: Option<&str>,
        password: Option<&str>,
    ) -> Result<ServerInit, String> {
        self.authenticate_with_policy(username, password, self.security_policy)
    }

    pub fn authenticate_with_policy(
        &mut self,
        username: Option<&str>,
        password: Option<&str>,
        policy: VncSecurityPolicy,
    ) -> Result<ServerInit, String> {
        self.security_policy = policy;
        if matches!(self.pending_security, Some(PendingSecurity::V33(_))) {
            let Some(PendingSecurity::V33(sec_type)) = self.pending_security.take() else {
                unreachable!();
            };
            return self.authenticate_v33_with_policy(password, policy, Some(sec_type));
        }
        // RFB 3.3: server dictates the security type directly as a u32.
        if self.proto_minor <= 3 {
            return self.authenticate_v33_with_policy(password, policy, None);
        }

        let has_username = username.is_some_and(|name| !name.trim().is_empty());
        let (chosen, write_selection) = match self.pending_security.take() {
            Some(PendingSecurity::Selected(chosen)) => (chosen, false),
            Some(PendingSecurity::V33(_)) => unreachable!(),
            None => (self.read_and_choose_security_type(has_username)?, true),
        };
        self.security_type = Some(chosen);
        if needs_password(chosen) && missing_password(password) {
            return Err(CREDENTIALS_REQUIRED.into());
        }

        if write_selection {
            self.write_all(&[chosen])
                .map_err(|e| format!("write security type: {}", e))?;
            self.flush().map_err(|e| format!("flush: {}", e))?;
        }

        match chosen {
            SEC_TYPE_NONE => {} // None — no auth
            SEC_TYPE_VNC_AUTH => {
                let pwd = password.unwrap_or("");
                self.vnc_auth_des(pwd)?;
            }
            SEC_TYPE_RA2_128 | SEC_TYPE_RA2NE_128 | SEC_TYPE_RA2_256 | SEC_TYPE_RA2NE_256 => {
                let pwd = password.unwrap_or("");
                self.vnc_auth_ra2(chosen, username.unwrap_or(""), pwd)?;
            }
            SEC_TYPE_ARD => {
                self.vnc_auth_ard(username.unwrap_or("").trim(), password.unwrap_or(""))?;
            }
            _ => unreachable!(),
        }

        // RFB 3.8 always sends SecurityResult; 3.7 only sends it on failure
        if self.proto_minor >= 8 || chosen != 1 {
            let mut result_buf = [0u8; 4];
            self.read_exact(&mut result_buf)
                .map_err(|e| authentication_read_error("waiting for the security result", e))?;
            let result = u32::from_be_bytes(result_buf);
            if result != 0 {
                // 3.8 sends a reason string; 3.7 does not
                if self.proto_minor >= 8 {
                    let mut len_buf = [0u8; 4];
                    self.read_exact(&mut len_buf)
                        .map_err(|e| format!("read auth failure len: {}", e))?;
                    let reason_len = u32::from_be_bytes(len_buf) as usize;
                    if reason_len > self.limits.max_reason_bytes {
                        return Err("VNC authentication reason exceeds configured limit".into());
                    }
                    let mut reason = vec![0u8; reason_len];
                    self.read_exact(&mut reason)
                        .map_err(|e| format!("read auth failure reason: {}", e))?;
                    return Err(format!(
                        "authentication failed: {}",
                        String::from_utf8_lossy(&reason)
                    ));
                } else {
                    return Err(format!(
                        "authentication failed (security result: {})",
                        result
                    ));
                }
            }
        }

        // ClientInit: send shared flag
        self.write_all(&[u8::from(self.shared)])
            .map_err(|e| format!("write client init: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        self.read_server_init()
    }

    fn read_and_choose_security_type(&mut self, has_username: bool) -> Result<u8, String> {
        let mut sec_buf = [0u8; 1];
        self.read_exact(&mut sec_buf)
            .map_err(|e| authentication_read_error("reading the security type count", e))?;

        let num_types = sec_buf[0] as usize;
        if num_types == 0 {
            let mut len_buf = [0u8; 4];
            self.read_exact(&mut len_buf)
                .map_err(|e| authentication_read_error("reading the rejection reason", e))?;
            let reason_len = u32::from_be_bytes(len_buf) as usize;
            if reason_len > self.limits.max_reason_bytes {
                return Err("VNC failure reason exceeds configured limit".into());
            }
            let mut reason = vec![0u8; reason_len];
            self.read_exact(&mut reason)
                .map_err(|e| authentication_read_error("reading the rejection reason", e))?;
            return Err(format!(
                "server rejected connection: {}",
                String::from_utf8_lossy(&reason)
            ));
        }

        let mut types = vec![0u8; num_types];
        self.read_exact(&mut types)
            .map_err(|e| authentication_read_error("reading the security types", e))?;
        self.security_policy
            .choose_with_username(&types, has_username)
            .map_err(|e| e.0)
    }

    /// RFB 3.3 security handshake: server sends a u32 security type, no client choice.
    fn authenticate_v33_with_policy(
        &mut self,
        password: Option<&str>,
        policy: VncSecurityPolicy,
        pending_security_type: Option<u32>,
    ) -> Result<ServerInit, String> {
        let sec_type = match pending_security_type {
            Some(value) => value,
            None => {
                let mut buf = [0u8; 4];
                self.read_exact(&mut buf)
                    .map_err(|e| authentication_read_error("reading the security type", e))?;
                u32::from_be_bytes(buf)
            }
        };
        if sec_type == 1 && !policy.allows_v33_none() {
            return Err(
                "server offers unauthenticated VNC; enable allow-none explicitly to continue"
                    .into(),
            );
        }
        if !matches!(sec_type, 1 | 2) {
            return Err(format!("unsupported v3.3 security type: {}", sec_type));
        }
        self.security_type = Some(sec_type as u8);
        match sec_type {
            1 => {
                // None — no authentication, proceed directly to ClientInit
                self.write_all(&[u8::from(self.shared)])
                    .map_err(|e| format!("write client init: {}", e))?;
                self.flush().map_err(|e| format!("flush: {}", e))?;
                self.read_server_init()
            }
            2 => {
                // VNC Authentication
                if missing_password(password) {
                    return Err(CREDENTIALS_REQUIRED.into());
                }
                let pwd = password.unwrap_or("");
                self.vnc_auth_des(pwd)?;

                // SecurityResult
                let mut result_buf = [0u8; 4];
                self.read_exact(&mut result_buf)
                    .map_err(|e| authentication_read_error("waiting for the security result", e))?;
                let result = u32::from_be_bytes(result_buf);
                if result != 0 {
                    return Err(format!("authentication failed (result={})", result));
                }

                self.write_all(&[u8::from(self.shared)])
                    .map_err(|e| format!("write client init: {}", e))?;
                self.flush().map_err(|e| format!("flush: {}", e))?;
                self.read_server_init()
            }
            _ => Err(format!("unsupported v3.3 security type: {}", sec_type)),
        }
    }

    /// VNC DES authentication (security type 2).
    fn vnc_auth_des(&mut self, password: &str) -> Result<(), String> {
        let mut challenge = [0u8; 16];
        self.read_exact(&mut challenge)
            .map_err(|e| authentication_read_error("reading the VNC challenge", e))?;

        let response = vnc_des_encrypt(password, &challenge);

        self.write_all(&response)
            .map_err(|e| format!("write VNC response: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Apple Remote Desktop authentication (security type 30, macOS Screen
    /// Sharing): the server sends a Diffie-Hellman generator, key length,
    /// prime and public key; the client answers with the macOS account name
    /// and password encrypted under MD5(shared secret) and its public key.
    fn vnc_auth_ard(&mut self, username: &str, password: &str) -> Result<(), String> {
        use rsa::rand_core::OsRng;

        if username.is_empty() {
            return Err(
                "ARD authentication requires the macOS account name: no VNC username was provided"
                    .into(),
            );
        }
        let mut head = [0u8; 4];
        self.read_exact(&mut head)
            .map_err(|e| authentication_read_error("reading the ARD key parameters", e))?;
        let generator = u16::from_be_bytes([head[0], head[1]]);
        let key_len = u16::from_be_bytes([head[2], head[3]]) as usize;
        if !(ARD_MIN_KEY_BYTES..=ARD_MAX_KEY_BYTES).contains(&key_len) {
            return Err(format!(
                "ARD authentication: unsupported Diffie-Hellman key length {key_len} bytes"
            ));
        }
        let mut prime = vec![0u8; key_len];
        self.read_exact(&mut prime)
            .map_err(|e| authentication_read_error("reading the ARD prime", e))?;
        let mut server_public = vec![0u8; key_len];
        self.read_exact(&mut server_public)
            .map_err(|e| authentication_read_error("reading the ARD server key", e))?;

        let (credentials, client_public) = ard_response(
            generator,
            &prime,
            &server_public,
            username,
            password,
            &mut OsRng,
        )?;
        self.write_all(&credentials)
            .map_err(|e| format!("ARD authentication: write credentials: {e}"))?;
        self.write_all(&client_public)
            .map_err(|e| format!("ARD authentication: write public key: {e}"))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    /// RealVNC RSA-AES authentication (RA2/RA2ne, 128- and 256-bit variants).
    fn vnc_auth_ra2(&mut self, sec_type: u8, username: &str, password: &str) -> Result<(), String> {
        use rsa::pkcs1v15::Pkcs1v15Encrypt;
        use rsa::rand_core::RngCore;
        use rsa::traits::PublicKeyParts;
        use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};

        let (random_len, all_encrypted) = match sec_type {
            SEC_TYPE_RA2_128 => (16usize, true),
            SEC_TYPE_RA2NE_128 => (16usize, false),
            SEC_TYPE_RA2_256 => (32usize, true),
            SEC_TYPE_RA2NE_256 => (32usize, false),
            _ => return Err(format!("RA2: unsupported security type {}", sec_type)),
        };

        // 1. Read server public key: u32 key bits, modulus, exponent.
        let mut len_buf = [0u8; 4];
        self.read_exact(&mut len_buf)
            .map_err(|e| format!("RA2: read key length: {}", e))?;
        let key_bits = u32::from_be_bytes(len_buf) as usize;

        if !(RA2_MIN_KEY_BITS..=RA2_MAX_KEY_BITS).contains(&key_bits) {
            return Err(format!("RA2: unreasonable key length: {} bits", key_bits));
        }
        let key_bytes_len = (key_bits + 7) / 8;

        let mut server_n = vec![0u8; key_bytes_len];
        self.read_exact(&mut server_n)
            .map_err(|e| format!("RA2: read modulus: {}", e))?;
        let mut server_e = vec![0u8; key_bytes_len];
        self.read_exact(&mut server_e)
            .map_err(|e| format!("RA2: read exponent: {}", e))?;

        let modulus = BigUint::from_bytes_be(&server_n);
        let exponent = BigUint::from_bytes_be(&server_e);
        let server_pubkey = RsaPublicKey::new(modulus, exponent)
            .map_err(|e| format!("RA2: construct server pubkey: {}", e))?;

        // 2. Generate a client key pair matching the server key size and send
        //    the public key in RealVNC's fixed-width format.
        let mut rng = rsa::rand_core::OsRng;
        let client_privkey = RsaPrivateKey::new(&mut rng, key_bits)
            .map_err(|e| format!("RA2: gen client key: {}", e))?;
        let client_pubkey = RsaPublicKey::from(&client_privkey);
        let client_n = biguint_to_fixed_bytes(client_pubkey.n(), key_bytes_len)?;
        let client_e = biguint_to_fixed_bytes(client_pubkey.e(), key_bytes_len)?;

        self.write_all(&(key_bits as u32).to_be_bytes())
            .map_err(|e| format!("RA2: write client key length: {}", e))?;
        self.write_all(&client_n)
            .map_err(|e| format!("RA2: write client modulus: {}", e))?;
        self.write_all(&client_e)
            .map_err(|e| format!("RA2: write client exponent: {}", e))?;
        self.flush()
            .map_err(|e| format!("RA2: flush client key: {}", e))?;

        // 3. Send the client random encrypted with the server's public key.
        let mut client_random = vec![0u8; random_len];
        rng.fill_bytes(&mut client_random);
        let encrypted_client_random = server_pubkey
            .encrypt(&mut rng, Pkcs1v15Encrypt, &client_random)
            .map_err(|e| format!("RA2: RSA encrypt: {}", e))?;
        let encrypted_client_random = left_pad(
            &encrypted_client_random,
            key_bytes_len,
            "RA2: encrypted client random",
        )?;

        self.write_all(&(key_bytes_len as u16).to_be_bytes())
            .map_err(|e| format!("RA2: write encrypted client random len: {}", e))?;
        self.write_all(&encrypted_client_random)
            .map_err(|e| format!("RA2: write encrypted client random: {}", e))?;
        self.flush()
            .map_err(|e| format!("RA2: flush client random: {}", e))?;

        // 4. Read and decrypt the server random with the client private key.
        let mut enc_len_buf = [0u8; 2];
        self.read_exact(&mut enc_len_buf)
            .map_err(|e| format!("RA2: read encrypted server random len: {}", e))?;
        let encrypted_server_random_len = u16::from_be_bytes(enc_len_buf) as usize;
        if encrypted_server_random_len != key_bytes_len {
            return Err(format!(
                "RA2: encrypted server random length mismatch: got {}, expected {}",
                encrypted_server_random_len, key_bytes_len
            ));
        }
        let mut encrypted_server_random = vec![0u8; encrypted_server_random_len];
        self.read_exact(&mut encrypted_server_random)
            .map_err(|e| format!("RA2: read encrypted server random: {}", e))?;
        let server_random = client_privkey
            .decrypt(Pkcs1v15Encrypt, &encrypted_server_random)
            .map_err(|e| format!("RA2: RSA decrypt server random: {}", e))?;
        if server_random.len() != random_len {
            return Err(format!(
                "RA2: decrypted server random length mismatch: got {}, expected {}",
                server_random.len(),
                random_len
            ));
        }

        // 5. All remaining RA2 authentication messages are AES-EAX framed.
        let (in_key, out_key) = derive_ra2_aes_keys(random_len, &client_random, &server_random);
        let mut aes_in = AesEax::new(&in_key)?;
        let mut aes_out = AesEax::new(&out_key)?;

        let client_hash = ra2_public_key_hash(
            random_len, key_bits, &client_n, &client_e, key_bits, &server_n, &server_e,
        );
        rsa_aes_write_message(&mut self.stream, &mut aes_out, &client_hash)
            .map_err(|e| format!("RA2: write client hash: {}", e))?;

        let server_hash = rsa_aes_read_message(&mut self.stream, &mut aes_in)
            .map_err(|e| format!("RA2: read server hash: {}", e))?;
        let expected_server_hash = ra2_public_key_hash(
            random_len, key_bits, &server_n, &server_e, key_bits, &client_n, &client_e,
        );
        if server_hash != expected_server_hash {
            return Err("RA2: server hash does not match".to_string());
        }

        let subtype_msg = rsa_aes_read_message(&mut self.stream, &mut aes_in)
            .map_err(|e| format!("RA2: read auth subtype: {}", e))?;
        if subtype_msg.len() != 1 {
            return Err(format!(
                "RA2: invalid auth subtype length {}",
                subtype_msg.len()
            ));
        }
        let subtype = subtype_msg[0];
        if subtype != RA2_SUBTYPE_USER_PASS && subtype != RA2_SUBTYPE_PASS {
            return Err(format!("RA2: unsupported auth subtype {}", subtype));
        }

        let username_bytes = username.as_bytes();
        if subtype == RA2_SUBTYPE_USER_PASS && username_bytes.is_empty() {
            return Err(
                "RA2: server requested username/password authentication, but no VNC username was provided"
                    .to_string(),
            );
        }
        if username_bytes.len() > u8::MAX as usize {
            return Err("RA2: username is too long; maximum is 255 bytes".to_string());
        }

        let password_bytes = password.as_bytes();
        if password_bytes.len() > u8::MAX as usize {
            return Err("RA2: password is too long; maximum is 255 bytes".to_string());
        }

        let credential_username_len = if subtype == RA2_SUBTYPE_USER_PASS {
            username_bytes.len()
        } else {
            0
        };
        let mut credentials =
            Vec::with_capacity(password_bytes.len() + credential_username_len + 2);
        if subtype == RA2_SUBTYPE_USER_PASS {
            credentials.push(username_bytes.len() as u8);
            credentials.extend_from_slice(username_bytes);
        } else {
            credentials.push(0);
        }
        credentials.push(password_bytes.len() as u8);
        credentials.extend_from_slice(password_bytes);
        rsa_aes_write_message(&mut self.stream, &mut aes_out, &credentials)
            .map_err(|e| format!("RA2: write credentials: {}", e))?;

        if all_encrypted {
            self.secure_io = Some(RsaAesIo::new(aes_in, aes_out));
        }

        Ok(())
    }

    fn read_server_init(&mut self) -> Result<ServerInit, String> {
        let mut buf = [0u8; 24];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read server init: {}", e))?;

        self.width = u16::from_be_bytes([buf[0], buf[1]]);
        self.height = u16::from_be_bytes([buf[2], buf[3]]);

        // Parsed pixel format from server (we override with RGBA via SetPixelFormat)
        let _bpp = buf[4];
        let _depth = buf[5];
        let _big_endian = buf[6];
        let _true_color = buf[7];
        let _red_max = u16::from_be_bytes([buf[8], buf[9]]);
        let _green_max = u16::from_be_bytes([buf[10], buf[11]]);
        let _blue_max = u16::from_be_bytes([buf[12], buf[13]]);
        let _red_shift = buf[14];
        let _green_shift = buf[15];
        let _blue_shift = buf[16];

        // Name length + name
        let name_len = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]) as usize;
        if name_len > self.limits.max_server_string_bytes {
            return Err("VNC server name exceeds configured limit".into());
        }
        self.limits
            .framebuffer_bytes(self.width, self.height)
            .map_err(|e| e.to_string())?;
        let mut name_bytes = vec![0u8; name_len];
        self.read_exact(&mut name_bytes)
            .map_err(|e| format!("read server name: {}", e))?;
        self.name = String::from_utf8_lossy(&name_bytes).to_string();

        // Allocate framebuffer (RGBA 32-bit) only after applying hard limits.
        let framebuffer = Framebuffer::new(self.width, self.height, &self.limits)?;
        *self.lock_framebuffer()? = framebuffer;

        Ok(ServerInit {
            width: self.width,
            height: self.height,
            name: self.name.clone(),
        })
    }

    /// Request pixel format: 32-bit true-colour with depth 24 so ZRLE can use
    /// the 3-byte CPIXEL form and rectangles copy straight into RGBA.
    pub fn set_pixel_format_rgba(&mut self) -> Result<(), String> {
        self.set_pixel_format(PixelFormat::RGB888)
    }

    /// Request a pixel format before the first update request.
    pub fn set_pixel_format(&mut self, format: PixelFormat) -> Result<(), String> {
        self.write_all(&set_pixel_format_message(format))
            .map_err(|e| format!("write set pixel format: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;
        self.pixel = PixelConverter::new(format);
        self.stats.pixel_format = format;
        Ok(())
    }

    /// Request encodings in preference order.
    pub fn set_encodings(&mut self, encodings: &[i32]) -> Result<(), String> {
        let msg = set_encodings_message(encodings)?;
        self.write_all(&msg)
            .map_err(|e| format!("write set encodings: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send FramebufferUpdateRequest. incremental=true skips unchanged regions.
    pub fn request_update(&mut self, incremental: bool) -> Result<(), String> {
        let mut msg = [0u8; 10];
        msg[0] = 3; // FramebufferUpdateRequest
        msg[1] = if incremental { 1 } else { 0 };
        msg[2..4].copy_from_slice(&0u16.to_be_bytes()); // x
        msg[4..6].copy_from_slice(&0u16.to_be_bytes()); // y
        msg[6..8].copy_from_slice(&self.width.to_be_bytes()); // width
        msg[8..10].copy_from_slice(&self.height.to_be_bytes()); // height

        self.write_all(&msg)
            .map_err(|e| format!("write update request: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Authentication uses a bounded read timeout so an unresponsive peer
    /// cannot hold a connection attempt forever. Once the RFB session is
    /// established, however, a server may legitimately stay silent while no
    /// pixels change or while the viewer is hidden. Runtime cancellation closes
    /// the socket explicitly, so remove the handshake timeout before entering
    /// the long-lived read loop.
    pub fn enter_runtime_mode(&mut self) -> Result<(), String> {
        self.stream
            .set_read_timeout(None)
            .map_err(|e| format!("clear VNC runtime read timeout failed: {e}"))?;
        // Handshake reads stay unbuffered so no byte meant for a sub-protocol
        // (RA2, TLS bridge) is consumed early. From here on every read goes
        // through `read_exact`/`RfbStreamReader`, so buffering is safe.
        if self.secure_io.is_none() {
            self.read_buffer.enabled = true;
        }
        Ok(())
    }

    /// Counters for the session-information view and performance evidence.
    pub fn runtime_stats(&self) -> RuntimeStats {
        RuntimeStats {
            wire_bytes: self.read_buffer.total,
            ..self.stats
        }
    }

    /// Handle to the authoritative framebuffer for relay-side extraction.
    pub fn framebuffer(&self) -> SharedFramebuffer {
        self.framebuffer.clone()
    }

    fn lock_framebuffer(&self) -> Result<std::sync::MutexGuard<'_, Framebuffer>, String> {
        self.framebuffer
            .lock()
            .map_err(|_| "VNC framebuffer lock poisoned".to_string())
    }

    /// Split out an independent writer so input events can be sent while the
    /// reader is blocked waiting for the next server message.
    pub fn take_writer(&mut self) -> Result<RfbWriter, String> {
        let stream = self
            .stream
            .try_clone()
            .map_err(|e| format!("clone VNC stream for writer: {}", e))?;
        let secure_output = match self.secure_io.as_mut() {
            Some(io) => Some(
                io.take_output()
                    .ok_or_else(|| "VNC secure writer already split".to_string())?,
            ),
            None => None,
        };

        Ok(RfbWriter {
            stream,
            secure_output,
            width: self.width,
            height: self.height,
            pending_pixel_format: self.pending_pixel_format.clone(),
        })
    }

    /// Read the next server-to-client message, decoding rectangle data in
    /// place. `FramebufferUpdate` is returned with the already-decoded rects
    /// so callers never have to know about the specific wire encoding.
    pub fn read_server_message(&mut self) -> Result<ServerMessage, String> {
        let msg_type = self.read_u8()?;
        match msg_type {
            0 => self.read_framebuffer_update(),
            1 => {
                self.read_exact(&mut [0u8; 1])
                    .map_err(|e| format!("read colourmap padding: {}", e))?;
                let _first = self.read_u16()?;
                let count = self.read_u16()?;
                let entry_size = (count as usize)
                    .checked_mul(6)
                    .ok_or_else(|| "colour-map byte count overflow".to_string())?;
                if entry_size > self.limits.max_server_string_bytes {
                    return Err("colour-map payload exceeds configured limit".into());
                }
                let mut entries = vec![0u8; entry_size];
                self.read_exact(&mut entries)
                    .map_err(|e| format!("read colourmap entries: {}", e))?;
                Ok(ServerMessage::SetColourMapEntries)
            }
            2 => Ok(ServerMessage::Bell),
            3 => {
                self.read_exact(&mut [0u8; 3])
                    .map_err(|e| format!("read cut text padding: {}", e))?;
                let len_signed = self.read_i32()?;
                if len_signed < 0 {
                    // ExtendedClipboard rides on ServerCutText with a negative length.
                    let len = len_signed
                        .checked_abs()
                        .ok_or_else(|| "extended clipboard length overflow".to_string())?
                        as usize;
                    // Reasonable cap so a corrupt server can't make us allocate
                    // a 4 GiB buffer.
                    if len > self.limits.max_clipboard_decompressed_bytes {
                        return Err("extended clipboard body exceeds configured limit".into());
                    }
                    let mut body = vec![0u8; len];
                    self.read_exact(&mut body)
                        .map_err(|e| format!("read ext clipboard: {}", e))?;
                    match parse_extended_body_with_limits(&body, &self.limits)? {
                        Some(msg) => Ok(ServerMessage::ExtendedClipboard(msg)),
                        None => {
                            // Unknown action — return a no-op so the relay keeps running.
                            Ok(ServerMessage::SetColourMapEntries)
                        }
                    }
                } else {
                    let len = len_signed as usize;
                    if len > self.limits.max_clipboard_format_bytes {
                        return Err("legacy clipboard body exceeds configured limit".into());
                    }
                    let mut text = vec![0u8; len];
                    self.read_exact(&mut text)
                        .map_err(|e| format!("read cut text: {}", e))?;
                    Ok(ServerMessage::ServerCutText {
                        text: decode_legacy_cut_text(&text),
                    })
                }
            }
            _ => Err(format!("unknown server message type: {}", msg_type)),
        }
    }

    fn read_framebuffer_update(&mut self) -> Result<ServerMessage, String> {
        // The writer only switches formats while no update is outstanding, so
        // this update is the first one encoded in the new format.
        if let Some(format) = self
            .pending_pixel_format
            .lock()
            .map_err(|_| "VNC pixel format lock poisoned".to_string())?
            .take()
        {
            self.pixel = PixelConverter::new(format);
            self.stats.pixel_format = format;
        }
        self.read_exact(&mut [0u8; 1])
            .map_err(|e| format!("read fu padding: {}", e))?;
        let num_rects = self.read_u16()? as usize;
        if num_rects > self.limits.max_rectangles_per_update {
            return Err("framebuffer update contains too many rectangles".into());
        }

        let update_started = std::time::Instant::now();
        let wire_before = self.read_buffer.total;
        let mut pixel_rects = 0u16;
        let mut tight_rects = 0u16;
        let mut compressed_rects = 0u16;
        let mut raw_pixels = 0u64;
        let mut damage: Vec<FbRect> = Vec::with_capacity(num_rects.min(64));
        let mut cursor = None;
        let mut pointer_pos = None;
        for _ in 0..num_rects {
            let x = self.read_u16()?;
            let y = self.read_u16()?;
            let w = self.read_u16()?;
            let h = self.read_u16()?;
            let encoding = self.read_i32()?;
            if encoding == ENCODING_DESKTOP_SIZE {
                self.limits
                    .framebuffer_bytes(w, h)
                    .map_err(|e| e.to_string())?;
            } else if encoding == ENCODING_POINTER_POS {
                if w != 0 || h != 0 {
                    return Err("pointer position encoding must have zero dimensions".into());
                }
            } else if encoding != ENCODING_RICH_CURSOR && encoding != ENCODING_X_CURSOR {
                self.limits
                    .rectangle_bytes(w, h)
                    .map_err(|e| e.to_string())?;
            }
            if x.checked_add(w).is_none_or(|end| end > self.width)
                || y.checked_add(h).is_none_or(|end| end > self.height)
            {
                // DesktopSize is the only rectangle allowed to describe a new
                // framebuffer geometry; pixel rectangles must stay in bounds.
                if encoding != ENCODING_DESKTOP_SIZE
                    && encoding != ENCODING_RICH_CURSOR
                    && encoding != ENCODING_X_CURSOR
                    && encoding != ENCODING_POINTER_POS
                {
                    return Err("framebuffer rectangle is outside the negotiated size".into());
                }
            }

            let rect = FbRect::new(x, y, w, h);
            match encoding {
                0 | 5 | 16 | ENCODING_TIGHT => {
                    self.stats.last_encoding = Some(encoding);
                    pixel_rects = pixel_rects.saturating_add(1);
                    if encoding == ENCODING_TIGHT {
                        tight_rects = tight_rects.saturating_add(1);
                    }
                    if encoding == 0 {
                        raw_pixels += u64::from(w) * u64::from(h);
                    } else {
                        compressed_rects = compressed_rects.saturating_add(1);
                    }
                    self.decode_pixels(encoding, w, h)?;
                    self.lock_framebuffer()?.blit(rect, &self.scratch)?;
                    damage.push(rect);
                }
                1 => {
                    self.stats.last_encoding.get_or_insert(1);
                    let (src_x, src_y) =
                        self.decode_via_reader(|reader| encodings::read_copyrect_source(reader))?;
                    self.lock_framebuffer()?.copy_rect(src_x, src_y, rect)?;
                    damage.push(rect);
                }
                ENCODING_DESKTOP_SIZE => {
                    // DesktopSize pseudo-encoding: no payload, just a resize.
                    // Rectangles decoded earlier in this update refer to the
                    // old geometry; the relay repaints the whole new surface.
                    self.lock_framebuffer()?.resize(w, h, &self.limits)?;
                    self.width = w;
                    self.height = h;
                    damage.clear();
                    damage.push(FbRect::new(0, 0, w, h));
                }
                ENCODING_RICH_CURSOR => {
                    let conv = self.pixel.clone();
                    cursor = Some(self.decode_via_reader(|reader| {
                        encodings::read_rich_cursor(reader, x, y, w, h, &conv)
                    })?);
                }
                ENCODING_X_CURSOR => {
                    cursor = Some(self.decode_via_reader(|reader| {
                        encodings::read_x_cursor(reader, x, y, w, h)
                    })?);
                }
                ENCODING_POINTER_POS => {
                    pointer_pos = Some(DecodedPointerPosition { x, y });
                }
                other => {
                    return Err(format!(
                        "unsupported encoding {} — client did not request this",
                        other
                    ));
                }
            }
        }

        self.stats.updates += 1;
        self.stats.last_update_pixel_rects = pixel_rects;
        self.stats.last_update_tight_rects = tight_rects;
        self.stats.last_update_compressed_rects = compressed_rects;
        self.stats.last_update_raw_pixels = raw_pixels;
        self.stats.last_update_wire_bytes = self.read_buffer.total - wire_before;
        self.stats.last_update_micros = update_started.elapsed().as_micros() as u64;
        self.stats.last_update_started_at = Some(update_started);
        self.stats.last_update_finished_at = Some(std::time::Instant::now());
        Ok(ServerMessage::FramebufferUpdate {
            rects: damage,
            cursor,
            pointer_pos,
        })
    }

    /// Decode one pixel rectangle into `self.scratch` (resized to `w*h*4`).
    fn decode_pixels(&mut self, encoding: i32, w: u16, h: u16) -> Result<(), String> {
        let bytes = self
            .limits
            .rectangle_bytes(w, h)
            .map_err(|e| e.to_string())?;
        let limits = self.limits;
        let Self {
            stream,
            secure_io,
            read_buffer,
            scratch,
            hextile_state,
            zrle_decoder,
            tight_decoder,
            pixel,
            ..
        } = self;
        if scratch.capacity() < bytes {
            // A fresh zeroed allocation maps zero pages lazily instead of
            // memsetting megabytes the decoder overwrites anyway.
            *scratch = vec![0u8; bytes];
        } else {
            scratch.resize(bytes, 0);
        }
        let mut reader = RfbStreamReader::new(stream, secure_io.as_mut(), read_buffer);
        match encoding {
            0 => encodings::decode_raw_into(&mut reader, w, h, pixel, scratch),
            5 => encodings::decode_hextile_into(&mut reader, w, h, hextile_state, pixel, scratch),
            16 => encodings::decode_zrle_into(
                &mut reader,
                w,
                h,
                zrle_decoder,
                &limits,
                pixel,
                scratch,
            ),
            ENCODING_TIGHT => {
                tight::decode_tight_into(&mut reader, w, h, tight_decoder, &limits, pixel, scratch)
            }
            other => Err(format!("unsupported pixel encoding {other}")),
        }
    }

    /// Run a decoder closure over a temporary `impl Read` view of the stream.
    /// Scoped borrowing so self stays available for framebuffer writes afterwards.
    fn decode_via_reader<T>(
        &mut self,
        f: impl FnOnce(&mut RfbStreamReader<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let Self {
            stream,
            secure_io,
            read_buffer,
            ..
        } = self;
        let mut reader = RfbStreamReader::new(stream, secure_io.as_mut(), read_buffer);
        f(&mut reader)
    }

    // --- I/O helpers ---

    fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.read_exact(&mut self.stream, buf),
            None => self.read_buffer.read_exact(&mut self.stream, buf),
        }
    }

    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.write_all(&mut self.stream, buf),
            None => self.stream.write_all(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        let mut buf = [0u8; 1];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u8: {}", e))?;
        Ok(buf[0])
    }

    fn read_u16(&mut self) -> Result<u16, String> {
        let mut buf = [0u8; 2];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u16: {}", e))?;
        Ok(u16::from_be_bytes(buf))
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u32: {}", e))?;
        Ok(u32::from_be_bytes(buf))
    }

    fn read_i32(&mut self) -> Result<i32, String> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read i32: {}", e))?;
        Ok(i32::from_be_bytes(buf))
    }
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
