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

const RUNTIME_READ_BUFFER_BYTES: usize = 256 * 1024;

/// Runtime counters. `wire_bytes` counts plaintext RFB bytes read after
/// `enter_runtime_mode` (TLS/RA2 framing overhead excluded).
#[derive(Debug, Clone, Copy)]
pub struct RuntimeStats {
    pub wire_bytes: u64,
    pub updates: u64,
    pub last_encoding: Option<i32>,
    /// Pixel format of the latest decoded update.
    pub pixel_format: PixelFormat,
    /// Pixel rectangles (and Tight ones among them) in the latest update.
    pub last_update_pixel_rects: u16,
    pub last_update_tight_rects: u16,
    /// Bytes and time from the first rectangle header to the end of the last
    /// FramebufferUpdate; large updates approximate the line speed.
    pub last_update_wire_bytes: u64,
    pub last_update_micros: u64,
    pub last_update_started_at: Option<std::time::Instant>,
    pub last_update_finished_at: Option<std::time::Instant>,
}

impl Default for RuntimeStats {
    fn default() -> Self {
        Self {
            wire_bytes: 0,
            updates: 0,
            last_encoding: None,
            pixel_format: PixelFormat::RGB888,
            last_update_pixel_rects: 0,
            last_update_tight_rects: 0,
            last_update_wire_bytes: 0,
            last_update_micros: 0,
            last_update_started_at: None,
            last_update_finished_at: None,
        }
    }
}

fn set_encodings_message(encodings: &[i32]) -> Result<Vec<u8>, String> {
    let count = u16::try_from(encodings.len())
        .map_err(|_| "too many VNC encodings requested".to_string())?;
    let message_len = encodings
        .len()
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(4))
        .ok_or_else(|| "VNC encoding list length overflow".to_string())?;
    let mut msg = vec![0u8; message_len];
    msg[0] = 2; // SetEncodings
    msg[2..4].copy_from_slice(&count.to_be_bytes());
    for (i, enc) in encodings.iter().enumerate() {
        let off = 4 + i * 4;
        msg[off..off + 4].copy_from_slice(&enc.to_be_bytes());
    }
    Ok(msg)
}

fn set_pixel_format_message(format: PixelFormat) -> [u8; 20] {
    let mut msg = [0u8; 20];
    // Message type 0 and three bytes of padding, then PIXEL_FORMAT.
    msg[4..20].copy_from_slice(&format.to_wire());
    msg
}

pub fn encoding_name(encoding: i32) -> &'static str {
    match encoding {
        0 => "Raw",
        1 => "CopyRect",
        5 => "Hextile",
        7 => "Tight",
        16 => "ZRLE",
        _ => "Unknown",
    }
}

/// Userspace read-ahead for the plaintext RFB stream. Disabled during the
/// handshake; `enter_runtime_mode` turns it on.
pub(crate) struct ReadBuffer {
    data: Box<[u8]>,
    start: usize,
    end: usize,
    enabled: bool,
    /// Bytes read from the socket while enabled.
    total: u64,
}

impl ReadBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            data: vec![0u8; capacity].into_boxed_slice(),
            start: 0,
            end: 0,
            enabled: false,
            total: 0,
        }
    }

    fn read_exact(&mut self, stream: &mut TcpStream, dst: &mut [u8]) -> std::io::Result<()> {
        if !self.enabled {
            return stream.read_exact(dst);
        }
        let mut offset = 0;
        let buffered = self.end - self.start;
        if buffered > 0 {
            let n = buffered.min(dst.len());
            dst[..n].copy_from_slice(&self.data[self.start..self.start + n]);
            self.start += n;
            offset = n;
        }
        while offset < dst.len() {
            let remaining = dst.len() - offset;
            // Large payloads (compressed ZRLE bodies, Raw rectangles) bypass
            // the buffer and land directly in the destination.
            if remaining >= self.data.len() {
                stream.read_exact(&mut dst[offset..])?;
                self.total += remaining as u64;
                return Ok(());
            }
            self.start = 0;
            self.end = loop {
                match stream.read(&mut self.data) {
                    Ok(0) => {
                        return Err(Error::new(
                            ErrorKind::UnexpectedEof,
                            "VNC server closed the connection",
                        ));
                    }
                    Ok(n) => {
                        self.total += n as u64;
                        break n;
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            };
            let n = self.end.min(remaining);
            dst[offset..offset + n].copy_from_slice(&self.data[..n]);
            self.start = n;
            offset += n;
        }
        Ok(())
    }
}

/// Temporary read view over the underlying VNC TCP stream (plus an optional
/// AES-EAX secure layer). Lives only for the duration of a single decode call
/// so we can borrow sibling fields of `RfbConnection` at the same time.
pub(crate) struct RfbStreamReader<'a> {
    stream: &'a mut TcpStream,
    secure_io: Option<&'a mut RsaAesIo>,
    read_buffer: &'a mut ReadBuffer,
}

impl<'a> RfbStreamReader<'a> {
    fn new(
        stream: &'a mut TcpStream,
        secure_io: Option<&'a mut RsaAesIo>,
        read_buffer: &'a mut ReadBuffer,
    ) -> Self {
        Self {
            stream,
            secure_io,
            read_buffer,
        }
    }
}

impl<'a> Read for RfbStreamReader<'a> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // Decoders all rely on `read_exact`; this path is just a fallback so
        // generic `Read` combinators keep working. Saturate the requested
        // buffer rather than return a partial read.
        self.read_exact(buf)?;
        Ok(buf.len())
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.read_exact(self.stream, buf),
            None => self.read_buffer.read_exact(self.stream, buf),
        }
    }
}

impl RfbWriter {
    pub fn set_framebuffer_size(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
    }

    /// Switch the wire pixel format mid-session. Callers send this only
    /// while no FramebufferUpdateRequest is outstanding, so the reader can
    /// apply the format to the very next update.
    pub fn set_pixel_format(&mut self, format: PixelFormat) -> Result<(), String> {
        *self
            .pending_pixel_format
            .lock()
            .map_err(|_| "VNC pixel format lock poisoned".to_string())? = Some(format);
        self.write_all(&set_pixel_format_message(format))
            .map_err(|e| format!("write set pixel format: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))
    }

    /// Replace the encoding preference list mid-session.
    pub fn set_encodings(&mut self, encodings: &[i32]) -> Result<(), String> {
        self.write_all(&set_encodings_message(encodings)?)
            .map_err(|e| format!("write set encodings: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))
    }

    /// Non-incremental request for one pixel: a liveness probe that every
    /// server must answer (KeepAlive, VNC-SESS-003).
    pub fn request_probe(&mut self) -> Result<(), String> {
        let mut msg = [0u8; 10];
        msg[0] = 3;
        msg[6..8].copy_from_slice(&1u16.to_be_bytes());
        msg[8..10].copy_from_slice(&1u16.to_be_bytes());
        self.write_all(&msg)
            .map_err(|e| format!("write keepalive request: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))
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

    /// Send KeyEvent.
    pub fn send_key_event(&mut self, down: bool, keysym: u32) -> Result<(), String> {
        let mut msg = [0u8; 8];
        msg[0] = 4;
        msg[1] = if down { 1 } else { 0 };
        msg[2..4].copy_from_slice(&0u16.to_be_bytes()); // padding
        msg[4..8].copy_from_slice(&keysym.to_be_bytes());

        self.write_all(&msg)
            .map_err(|e| format!("write key event: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send PointerEvent.
    pub fn send_pointer_event(&mut self, x: u16, y: u16, buttons: u8) -> Result<(), String> {
        if self.width == 0 || self.height == 0 || x >= self.width || y >= self.height {
            return Err("pointer coordinates are outside the remote framebuffer".into());
        }
        let mut msg = [0u8; 6];
        msg[0] = 5;
        msg[1] = buttons;
        msg[2..4].copy_from_slice(&x.to_be_bytes());
        msg[4..6].copy_from_slice(&y.to_be_bytes());

        self.write_all(&msg)
            .map_err(|e| format!("write pointer event: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send ClientCutText (clipboard).
    pub fn send_client_cut_text(&mut self, text: &str) -> Result<(), String> {
        let text_bytes = encode_legacy_cut_text(text);
        DecodeLimits::default()
            .clipboard_bytes(text_bytes.len())
            .map_err(|error| error.to_string())?;
        let text_len = u32::try_from(text_bytes.len())
            .map_err(|_| "clipboard text exceeds RFB length limit".to_string())?;
        let message_len = 8usize
            .checked_add(text_bytes.len())
            .ok_or_else(|| "clipboard message length overflow".to_string())?;
        let mut msg = vec![0u8; message_len];
        msg[0] = 6;
        msg[1..4].copy_from_slice(&[0u8; 3]);
        msg[4..8].copy_from_slice(&text_len.to_be_bytes());
        msg[8..].copy_from_slice(&text_bytes);

        self.write_all(&msg)
            .map_err(|e| format!("write client cut text: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    /// Send an ExtendedClipboard body. The wire frame is a ClientCutText (msg
    /// type 6) with a *negative* length signaling the extended payload.
    pub fn send_extended_clipboard(&mut self, body: &[u8]) -> Result<(), String> {
        if body.len() < 4 {
            return Err("extended clipboard body is truncated".into());
        }
        if body.len() > DecodeLimits::default().max_clipboard_decompressed_bytes {
            return Err("extended clipboard body exceeds configured limit".into());
        }
        let body_len = i32::try_from(body.len())
            .map_err(|_| "extended clipboard body exceeds RFB length limit".to_string())?;
        let neg_len = body_len
            .checked_neg()
            .ok_or_else(|| "extended clipboard length overflow".to_string())?;
        let capacity = 8usize
            .checked_add(body.len())
            .ok_or_else(|| "extended clipboard message length overflow".to_string())?;
        let mut msg = Vec::with_capacity(capacity);
        msg.push(6);
        msg.extend_from_slice(&[0u8; 3]); // padding
        msg.extend_from_slice(&neg_len.to_be_bytes());
        msg.extend_from_slice(body);

        self.write_all(&msg)
            .map_err(|e| format!("write ext clipboard: {}", e))?;
        self.flush().map_err(|e| format!("flush: {}", e))?;

        Ok(())
    }

    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self.secure_output.as_mut() {
            Some(output) => {
                for chunk in buf.chunks(RA2_AES_FRAME_MAX) {
                    rsa_aes_write_message(&mut self.stream, output, chunk)?;
                }
                Ok(())
            }
            None => self.stream.write_all(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

struct RsaAesIo {
    input: AesEax,
    output: Option<AesEax>,
    read_buf: VecDeque<u8>,
}

impl RsaAesIo {
    fn new(input: AesEax, output: AesEax) -> Self {
        Self {
            input,
            output: Some(output),
            read_buf: VecDeque::new(),
        }
    }

    fn read_exact(&mut self, stream: &mut TcpStream, buf: &mut [u8]) -> std::io::Result<()> {
        let mut offset = 0;
        while offset < buf.len() {
            if self.read_buf.is_empty() {
                let msg = rsa_aes_read_message(stream, &mut self.input)?;
                self.read_buf.extend(msg);
                if self.read_buf.is_empty() {
                    continue;
                }
            }

            let n = (buf.len() - offset).min(self.read_buf.len());
            for (dst, src) in buf[offset..offset + n]
                .iter_mut()
                .zip(self.read_buf.drain(..n))
            {
                *dst = src;
            }
            offset += n;
        }
        Ok(())
    }

    fn write_all(&mut self, stream: &mut TcpStream, buf: &[u8]) -> std::io::Result<()> {
        let output = self.output.as_mut().ok_or_else(|| {
            Error::new(
                ErrorKind::BrokenPipe,
                "secure VNC output writer has already been split",
            )
        })?;
        for chunk in buf.chunks(RA2_AES_FRAME_MAX) {
            rsa_aes_write_message(stream, output, chunk)?;
        }
        Ok(())
    }

    fn take_output(&mut self) -> Option<AesEax> {
        self.output.take()
    }
}

enum AesKey {
    Aes128(aes::Aes128),
    Aes256(aes::Aes256),
}

struct AesEax {
    key: AesKey,
    counter: [u8; 16],
}

impl AesEax {
    fn new(key: &[u8]) -> Result<Self, String> {
        use aes::cipher::KeyInit;

        let key = match key.len() {
            16 => AesKey::Aes128(
                aes::Aes128::new_from_slice(key)
                    .map_err(|e| format!("AES-128 init failed: {}", e))?,
            ),
            32 => AesKey::Aes256(
                aes::Aes256::new_from_slice(key)
                    .map_err(|e| format!("AES-256 init failed: {}", e))?,
            ),
            _ => return Err(format!("unsupported AES key length {}", key.len())),
        };

        Ok(Self {
            key,
            counter: [0u8; 16],
        })
    }

    fn encrypt_packet(&mut self, ad: &[u8], plaintext: &[u8]) -> (Vec<u8>, [u8; 16]) {
        let (ciphertext, tag) = self.eax_encrypt(&self.counter, ad, plaintext);
        increment_le(&mut self.counter);
        (ciphertext, tag)
    }

    fn decrypt_packet(
        &mut self,
        ad: &[u8],
        ciphertext: &[u8],
        tag: &[u8],
    ) -> Result<Vec<u8>, String> {
        let expected = self.eax_tag(&self.counter, ad, ciphertext);
        if tag != expected {
            return Err("AES-EAX tag mismatch".to_string());
        }
        let plaintext = self.eax_decrypt(&self.counter, ciphertext);
        increment_le(&mut self.counter);
        Ok(plaintext)
    }

    fn eax_encrypt(&self, nonce: &[u8; 16], ad: &[u8], plaintext: &[u8]) -> (Vec<u8>, [u8; 16]) {
        let nonce_mac = self.omac(0, nonce);
        let header_mac = self.omac(1, ad);
        let mut ciphertext = plaintext.to_vec();
        self.ctr_xor(&nonce_mac, &mut ciphertext);
        let message_mac = self.omac(2, &ciphertext);
        (ciphertext, xor3(&nonce_mac, &header_mac, &message_mac))
    }

    fn eax_decrypt(&self, nonce: &[u8; 16], ciphertext: &[u8]) -> Vec<u8> {
        let nonce_mac = self.omac(0, nonce);
        let mut plaintext = ciphertext.to_vec();
        self.ctr_xor(&nonce_mac, &mut plaintext);
        plaintext
    }

    fn eax_tag(&self, nonce: &[u8; 16], ad: &[u8], ciphertext: &[u8]) -> [u8; 16] {
        let nonce_mac = self.omac(0, nonce);
        let header_mac = self.omac(1, ad);
        let message_mac = self.omac(2, ciphertext);
        xor3(&nonce_mac, &header_mac, &message_mac)
    }

    fn omac(&self, domain: u8, data: &[u8]) -> [u8; 16] {
        let mut prefixed = Vec::with_capacity(16 + data.len());
        prefixed.extend_from_slice(&[0u8; 15]);
        prefixed.push(domain);
        prefixed.extend_from_slice(data);
        self.cmac(&prefixed)
    }

    fn cmac(&self, data: &[u8]) -> [u8; 16] {
        let mut zero = [0u8; 16];
        self.encrypt_block(&mut zero);
        let k1 = dbl_block(&zero);
        let k2 = dbl_block(&k1);

        let block_count = if data.is_empty() {
            1
        } else {
            (data.len() + 15) / 16
        };
        let complete_last = !data.is_empty() && data.len() % 16 == 0;

        let mut x = [0u8; 16];
        for i in 0..block_count - 1 {
            let mut block = [0u8; 16];
            block.copy_from_slice(&data[i * 16..i * 16 + 16]);
            xor_in_place(&mut x, &block);
            self.encrypt_block(&mut x);
        }

        let mut last = [0u8; 16];
        if complete_last {
            last.copy_from_slice(&data[(block_count - 1) * 16..block_count * 16]);
            xor_in_place(&mut last, &k1);
        } else {
            let start = (block_count - 1) * 16;
            let rem = data.len().saturating_sub(start);
            if rem > 0 {
                last[..rem].copy_from_slice(&data[start..]);
            }
            last[rem] = 0x80;
            xor_in_place(&mut last, &k2);
        }

        xor_in_place(&mut x, &last);
        self.encrypt_block(&mut x);
        x
    }

    fn ctr_xor(&self, initial_counter: &[u8; 16], data: &mut [u8]) {
        let mut counter = *initial_counter;
        for chunk in data.chunks_mut(16) {
            let mut pad = counter;
            self.encrypt_block(&mut pad);
            for (dst, key_byte) in chunk.iter_mut().zip(pad.iter()) {
                *dst ^= *key_byte;
            }
            increment_be(&mut counter);
        }
    }

    fn encrypt_block(&self, block: &mut [u8; 16]) {
        use aes::cipher::{Array, BlockCipherEncrypt};

        match &self.key {
            AesKey::Aes128(cipher) => {
                cipher.encrypt_block(Array::from_mut_slice(block));
            }
            AesKey::Aes256(cipher) => {
                cipher.encrypt_block(Array::from_mut_slice(block));
            }
        }
    }
}

fn rsa_aes_write_message(
    stream: &mut TcpStream,
    aes: &mut AesEax,
    plaintext: &[u8],
) -> std::io::Result<()> {
    if plaintext.len() > u16::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "RSA-AES message too large",
        ));
    }

    let len = (plaintext.len() as u16).to_be_bytes();
    let (ciphertext, tag) = aes.encrypt_packet(&len, plaintext);
    stream.write_all(&len)?;
    stream.write_all(&ciphertext)?;
    stream.write_all(&tag)?;
    stream.flush()
}

fn rsa_aes_read_message(stream: &mut TcpStream, aes: &mut AesEax) -> std::io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 2];
    stream.read_exact(&mut len_buf)?;
    let len = u16::from_be_bytes(len_buf) as usize;
    let mut encrypted = vec![0u8; len + 16];
    stream.read_exact(&mut encrypted)?;

    aes.decrypt_packet(&len_buf, &encrypted[..len], &encrypted[len..])
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn derive_ra2_aes_keys(
    random_len: usize,
    client_random: &[u8],
    server_random: &[u8],
) -> (Vec<u8>, Vec<u8>) {
    use sha1::Digest;

    if random_len == 16 {
        let mut inbound = sha1::Sha1::new();
        inbound.update(client_random);
        inbound.update(server_random);
        let mut outbound = sha1::Sha1::new();
        outbound.update(server_random);
        outbound.update(client_random);
        (
            inbound.finalize()[..16].to_vec(),
            outbound.finalize()[..16].to_vec(),
        )
    } else {
        let mut inbound = sha2::Sha256::new();
        inbound.update(client_random);
        inbound.update(server_random);
        let mut outbound = sha2::Sha256::new();
        outbound.update(server_random);
        outbound.update(client_random);
        (inbound.finalize().to_vec(), outbound.finalize().to_vec())
    }
}

fn ra2_public_key_hash(
    random_len: usize,
    first_bits: usize,
    first_n: &[u8],
    first_e: &[u8],
    second_bits: usize,
    second_n: &[u8],
    second_e: &[u8],
) -> Vec<u8> {
    use sha1::Digest;

    let mut data =
        Vec::with_capacity(8 + first_n.len() + first_e.len() + second_n.len() + second_e.len());
    data.extend_from_slice(&(first_bits as u32).to_be_bytes());
    data.extend_from_slice(first_n);
    data.extend_from_slice(first_e);
    data.extend_from_slice(&(second_bits as u32).to_be_bytes());
    data.extend_from_slice(second_n);
    data.extend_from_slice(second_e);

    if random_len == 16 {
        sha1::Sha1::digest(&data).to_vec()
    } else {
        sha2::Sha256::digest(&data).to_vec()
    }
}

/// The ARD reply: `{username[64], password[64]}` (NUL-terminated UTF-8, the
/// rest random) encrypted with AES-128-ECB under MD5 of the fixed-width DH
/// shared secret, and the client's public key in the server's key width.
pub(crate) fn ard_response(
    generator: u16,
    prime: &[u8],
    server_public: &[u8],
    username: &str,
    password: &str,
    rng: &mut impl rsa::rand_core::RngCore,
) -> Result<([u8; 2 * ARD_FIELD_BYTES], Vec<u8>), String> {
    use aes::cipher::{Array, BlockCipherEncrypt, KeyInit};
    use md5::Digest;
    use rsa::BigUint;

    for (field, value) in [("username", username), ("password", password)] {
        if value.len() >= ARD_FIELD_BYTES || value.as_bytes().contains(&0) {
            return Err(format!(
                "ARD authentication: the {field} must be under {ARD_FIELD_BYTES} bytes without NUL characters"
            ));
        }
    }
    let key_len = prime.len();
    let p = BigUint::from_bytes_be(prime);
    let one = BigUint::from(1u32);
    let two = BigUint::from(2u32);
    let server_key = BigUint::from_bytes_be(server_public);
    if generator < 2 || p <= BigUint::from(3u32) || server_key <= one || server_key >= &p - &one {
        return Err("ARD authentication: invalid Diffie-Hellman parameters from the server".into());
    }
    let mut secret = vec![0u8; key_len];
    rng.fill_bytes(&mut secret);
    // Private exponent in [1, p - 2].
    let private = BigUint::from_bytes_be(&secret) % (&p - &two) + &one;
    let client_public = BigUint::from(generator).modpow(&private, &p);
    let shared = server_key.modpow(&private, &p);
    let client_public = left_pad(&client_public.to_bytes_be(), key_len, "ARD public key")?;
    let shared = left_pad(&shared.to_bytes_be(), key_len, "ARD shared secret")?;
    let key = md5::Md5::digest(&shared);

    let mut block = [0u8; 2 * ARD_FIELD_BYTES];
    rng.fill_bytes(&mut block);
    for (offset, value) in [(0, username), (ARD_FIELD_BYTES, password)] {
        block[offset..offset + value.len()].copy_from_slice(value.as_bytes());
        block[offset + value.len()] = 0;
    }
    let cipher = aes::Aes128::new_from_slice(&key)
        .map_err(|e| format!("ARD authentication: AES key: {e}"))?;
    for chunk in block.chunks_exact_mut(16) {
        cipher.encrypt_block(Array::from_mut_slice(chunk));
    }
    Ok((block, client_public))
}

fn biguint_to_fixed_bytes(value: &rsa::BigUint, len: usize) -> Result<Vec<u8>, String> {
    let bytes = value.to_bytes_be();
    left_pad(&bytes, len, "RSA integer")
}

fn left_pad(bytes: &[u8], len: usize, context: &str) -> Result<Vec<u8>, String> {
    if bytes.len() > len {
        return Err(format!(
            "{} is too large: {} bytes, expected at most {}",
            context,
            bytes.len(),
            len
        ));
    }

    let mut out = vec![0u8; len];
    out[len - bytes.len()..].copy_from_slice(bytes);
    Ok(out)
}

fn dbl_block(block: &[u8; 16]) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut carry = 0u8;
    for i in (0..16).rev() {
        out[i] = (block[i] << 1) | carry;
        carry = block[i] >> 7;
    }
    if carry != 0 {
        out[15] ^= 0x87;
    }
    out
}

fn xor_in_place(dst: &mut [u8; 16], src: &[u8; 16]) {
    for (d, s) in dst.iter_mut().zip(src.iter()) {
        *d ^= *s;
    }
}

fn xor3(a: &[u8; 16], b: &[u8; 16], c: &[u8; 16]) -> [u8; 16] {
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = a[i] ^ b[i] ^ c[i];
    }
    out
}

fn increment_be(counter: &mut [u8; 16]) {
    for byte in counter.iter_mut().rev() {
        let (new, carry) = byte.overflowing_add(1);
        *byte = new;
        if !carry {
            break;
        }
    }
}

fn increment_le(counter: &mut [u8; 16]) {
    for byte in counter.iter_mut() {
        let (new, carry) = byte.overflowing_add(1);
        *byte = new;
        if !carry {
            break;
        }
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

/// VNC DES authentication: encrypt the 16-byte challenge with a key derived from the password.
fn vnc_des_encrypt(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    use des::Des;
    use des::cipher::{Array, BlockCipherEncrypt, KeyInit};

    // Build key: password truncated/padded to 8 bytes, each byte's bits reversed
    let mut key_bytes = [0u8; 8];
    let pwd_bytes = password.as_bytes();
    for i in 0..8 {
        let b = if i < pwd_bytes.len() { pwd_bytes[i] } else { 0 };
        key_bytes[i] = reverse_bits(b);
    }

    let cipher = Des::new_from_slice(&key_bytes).expect("DES key should be 8 bytes");

    let mut response = [0u8; 16];
    cipher.encrypt_block_b2b(
        Array::from_slice(&challenge[..8]),
        Array::from_mut_slice(&mut response[..8]),
    );
    cipher.encrypt_block_b2b(
        Array::from_slice(&challenge[8..]),
        Array::from_mut_slice(&mut response[8..]),
    );

    response
}

fn reverse_bits(b: u8) -> u8 {
    let mut result = 0u8;
    for i in 0..8 {
        result |= ((b >> i) & 1) << (7 - i);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    fn write_server_init(stream: &mut TcpStream, width: u16, height: u16, name: &[u8]) {
        let mut init = Vec::with_capacity(24 + name.len());
        init.extend_from_slice(&width.to_be_bytes());
        init.extend_from_slice(&height.to_be_bytes());
        init.extend_from_slice(&[32, 24, 0, 1]);
        init.extend_from_slice(&255u16.to_be_bytes());
        init.extend_from_slice(&255u16.to_be_bytes());
        init.extend_from_slice(&255u16.to_be_bytes());
        init.extend_from_slice(&[0, 8, 16, 0, 0, 0]);
        init.extend_from_slice(&(name.len() as u32).to_be_bytes());
        init.extend_from_slice(name);
        stream.write_all(&init).unwrap();
    }

    fn start_fixture(
        minor: u16,
        security: u32,
        width: u16,
        height: u16,
        name: &[u8],
    ) -> (u16, thread::JoinHandle<()>) {
        let name = name.to_vec();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let banner = format!("RFB 003.{minor:03}\n");
            stream.write_all(banner.as_bytes()).unwrap();
            let mut client_banner = [0u8; 12];
            stream.read_exact(&mut client_banner).unwrap();

            if minor <= 3 {
                stream.write_all(&security.to_be_bytes()).unwrap();
            } else {
                let security_type = security as u8;
                stream.write_all(&[1, security_type]).unwrap();
                let mut chosen = [0u8; 1];
                if stream.read_exact(&mut chosen).is_err() {
                    return;
                }
                assert_eq!(chosen[0], security_type);
            }

            if security == 2 {
                let challenge = [0x5au8; 16];
                stream.write_all(&challenge).unwrap();
                let mut response = [0u8; 16];
                stream.read_exact(&mut response).unwrap();
                assert_eq!(response, vnc_des_encrypt("passw0rd", &challenge));
                stream.write_all(&0u32.to_be_bytes()).unwrap();
            } else if minor >= 8 {
                stream.write_all(&0u32.to_be_bytes()).unwrap();
            }

            let mut client_init = [0u8; 1];
            stream.read_exact(&mut client_init).unwrap();
            assert_eq!(client_init[0], 1);
            write_server_init(&mut stream, width, height, &name);
        });
        (port, handle)
    }

    fn connect_fixture(
        port: u16,
        policy: VncSecurityPolicy,
        limits: DecodeLimits,
    ) -> Result<ServerInit, String> {
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut connection =
            RfbConnection::from_stream(stream, Duration::from_secs(2), policy, limits)?;
        connection.authenticate(None, Some("passw0rd"))
    }

    #[test]
    fn test_reverse_bits() {
        assert_eq!(reverse_bits(0b0000_0001), 0b1000_0000);
        assert_eq!(reverse_bits(0b1000_0000), 0b0000_0001);
        assert_eq!(reverse_bits(0b1111_0000), 0b0000_1111);
    }

    #[test]
    fn test_vnc_des_known_vector() {
        // Test vector: password "passw0rd", challenge all zeros
        let challenge = [0u8; 16];
        let response = vnc_des_encrypt("passw0rd", &challenge);
        // Verify the response is 16 bytes and not all zeros
        assert_eq!(response.len(), 16);
        assert!(response.iter().any(|&b| b != 0));
    }

    #[test]
    fn supports_rfb_33_37_and_38_none_fixtures() {
        for minor in [3, 7, 8] {
            let (port, server) = start_fixture(minor, 1, 800, 600, b"fixture");
            let result =
                connect_fixture(port, VncSecurityPolicy::AllowNone, DecodeLimits::default())
                    .unwrap();
            assert_eq!((result.width, result.height), (800, 600));
            assert_eq!(result.name, "fixture");
            server.join().unwrap();
        }
    }

    #[test]
    fn rejects_none_fixture_without_explicit_opt_in() {
        let (port, server) = start_fixture(8, 1, 800, 600, b"fixture");
        let result = connect_fixture(
            port,
            VncSecurityPolicy::PreferEncryption,
            DecodeLimits::default(),
        );
        assert!(result.unwrap_err().contains("allow-none"));
        server.join().unwrap();
    }

    /// RFC 2409 Oakley group 2 (1024-bit MODP), the size macOS uses for ARD.
    const OAKLEY_GROUP_2: &str = "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74\
        020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437\
        4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED\
        EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF";

    /// Deterministic bytes for reproducible tests.
    struct CountingRng(u8);

    impl rsa::rand_core::RngCore for CountingRng {
        fn next_u32(&mut self) -> u32 {
            let mut bytes = [0u8; 4];
            self.fill_bytes(&mut bytes);
            u32::from_le_bytes(bytes)
        }
        fn next_u64(&mut self) -> u64 {
            let mut bytes = [0u8; 8];
            self.fill_bytes(&mut bytes);
            u64::from_le_bytes(bytes)
        }
        fn fill_bytes(&mut self, dest: &mut [u8]) {
            for byte in dest {
                self.0 = self.0.wrapping_mul(31).wrapping_add(17);
                *byte = self.0;
            }
        }
        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rsa::rand_core::Error> {
            self.fill_bytes(dest);
            Ok(())
        }
    }

    fn hex_bytes(hex: &str) -> Vec<u8> {
        let hex: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    /// The server half of ARD: decrypt the credentials the client sent.
    fn ard_server_decrypt(
        prime: &[u8],
        server_private: &rsa::BigUint,
        credentials: &[u8],
        client_public: &[u8],
    ) -> (String, String) {
        use aes::cipher::{Array, BlockCipherDecrypt, KeyInit};
        use md5::Digest;

        let p = rsa::BigUint::from_bytes_be(prime);
        let shared = rsa::BigUint::from_bytes_be(client_public).modpow(server_private, &p);
        let shared = left_pad(&shared.to_bytes_be(), prime.len(), "shared").unwrap();
        let cipher = aes::Aes128::new_from_slice(&md5::Md5::digest(&shared)).unwrap();
        let mut plain = credentials.to_vec();
        for chunk in plain.chunks_exact_mut(16) {
            cipher.decrypt_block(Array::from_mut_slice(chunk));
        }
        let field = |range: std::ops::Range<usize>| {
            let bytes = &plain[range];
            let end = bytes.iter().position(|b| *b == 0).unwrap();
            String::from_utf8(bytes[..end].to_vec()).unwrap()
        };
        (field(0..64), field(64..128))
    }

    #[test]
    fn ard_response_encrypts_credentials_under_the_dh_secret() {
        let prime = hex_bytes(OAKLEY_GROUP_2);
        let p = rsa::BigUint::from_bytes_be(&prime);
        let server_private = rsa::BigUint::from(0x1234_5678_9abc_def1u64);
        let server_public = rsa::BigUint::from(2u32).modpow(&server_private, &p);
        let server_public = left_pad(&server_public.to_bytes_be(), 128, "public").unwrap();
        let (credentials, client_public) = ard_response(
            2,
            &prime,
            &server_public,
            "runner",
            "pässwörd",
            &mut CountingRng(1),
        )
        .unwrap();
        assert_eq!(client_public.len(), 128);
        assert_eq!(
            ard_server_decrypt(&prime, &server_private, &credentials, &client_public),
            ("runner".to_string(), "pässwörd".to_string())
        );
        // Fresh randomness gives a different key pair and ciphertext.
        let (other, other_public) = ard_response(
            2,
            &prime,
            &server_public,
            "runner",
            "pässwörd",
            &mut CountingRng(2),
        )
        .unwrap();
        assert_ne!(other, credentials);
        assert_ne!(other_public, client_public);
    }

    #[test]
    fn ard_response_rejects_bad_parameters_and_long_credentials() {
        let prime = hex_bytes(OAKLEY_GROUP_2);
        let mut rng = CountingRng(3);
        let one = left_pad(&[1], 128, "one").unwrap();
        assert!(ard_response(2, &prime, &one, "u", "p", &mut rng).is_err());
        assert!(ard_response(2, &prime, &prime, "u", "p", &mut rng).is_err());
        let public = left_pad(&[5], 128, "five").unwrap();
        assert!(ard_response(1, &prime, &public, "u", "p", &mut rng).is_err());
        let long = "x".repeat(64);
        assert!(ard_response(2, &prime, &public, &long, "p", &mut rng).is_err());
        assert!(ard_response(2, &prime, &public, "u", &long, &mut rng).is_err());
        assert!(ard_response(2, &prime, &public, "u", "p\0q", &mut rng).is_err());
        assert!(ard_response(2, &prime, &public, &"x".repeat(63), "p", &mut rng).is_ok());
    }

    /// macOS-style server: RFB 003.889, offers [30, 2], checks ARD credentials.
    fn start_ard_fixture(expected: (&'static str, &'static str)) -> (u16, thread::JoinHandle<u8>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream.write_all(b"RFB 003.889\n").unwrap();
            let mut client_banner = [0u8; 12];
            stream.read_exact(&mut client_banner).unwrap();
            assert_eq!(&client_banner, b"RFB 003.008\n");
            stream.write_all(&[2, 30, 2]).unwrap();
            let mut chosen = [0u8; 1];
            stream.read_exact(&mut chosen).unwrap();
            if chosen[0] != 30 {
                return chosen[0];
            }
            let prime = hex_bytes(OAKLEY_GROUP_2);
            let p = rsa::BigUint::from_bytes_be(&prime);
            let server_private = rsa::BigUint::from(0xfeed_beef_u64);
            let server_public = rsa::BigUint::from(2u32).modpow(&server_private, &p);
            let mut parameters = vec![0, 2, 0, 128];
            parameters.extend_from_slice(&prime);
            parameters
                .extend_from_slice(&left_pad(&server_public.to_bytes_be(), 128, "pub").unwrap());
            stream.write_all(&parameters).unwrap();
            let mut credentials = [0u8; 128];
            stream.read_exact(&mut credentials).unwrap();
            let mut client_public = [0u8; 128];
            stream.read_exact(&mut client_public).unwrap();
            let (user, password) =
                ard_server_decrypt(&prime, &server_private, &credentials, &client_public);
            if (user.as_str(), password.as_str()) != expected {
                let reason = b"Authentication failed";
                stream.write_all(&1u32.to_be_bytes()).unwrap();
                stream
                    .write_all(&(reason.len() as u32).to_be_bytes())
                    .unwrap();
                stream.write_all(reason).unwrap();
                return chosen[0];
            }
            stream.write_all(&0u32.to_be_bytes()).unwrap();
            let mut client_init = [0u8; 1];
            stream.read_exact(&mut client_init).unwrap();
            write_server_init(&mut stream, 1440, 900, b"Mac mini");
            chosen[0]
        });
        (port, handle)
    }

    fn connect_ard(
        port: u16,
        username: Option<&str>,
        password: &str,
    ) -> Result<ServerInit, String> {
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut connection = RfbConnection::from_stream(
            stream,
            Duration::from_secs(5),
            VncSecurityPolicy::PreferEncryption,
            DecodeLimits::default(),
        )?;
        let init = connection.authenticate(username, Some(password))?;
        assert_eq!(connection.protocol_version(), "3.8");
        Ok(init)
    }

    #[test]
    fn authenticates_mac_screen_sharing_with_ard_when_a_username_is_given() {
        let (port, server) = start_ard_fixture(("runner", "Qa1-secret"));
        let init = connect_ard(port, Some("runner"), "Qa1-secret").unwrap();
        assert_eq!(
            (init.width, init.height, init.name.as_str()),
            (1440, 900, "Mac mini")
        );
        assert_eq!(server.join().unwrap(), 30);

        let (port, server) = start_ard_fixture(("runner", "Qa1-secret"));
        let error = connect_ard(port, Some("runner"), "wrong").unwrap_err();
        assert!(error.contains("authentication failed"), "{error}");
        assert_eq!(server.join().unwrap(), 30);
    }

    #[test]
    fn mac_server_without_a_username_falls_back_to_vncauth() {
        let (port, server) = start_ard_fixture(("runner", "Qa1-secret"));
        // The fixture stops after the choice; the client then fails reading
        // the VNCAuth challenge, which is all this test needs.
        let _ = connect_ard(port, None, "Qa1-secret");
        assert_eq!(server.join().unwrap(), 2);
    }

    #[test]
    fn authenticates_vncauth_fixture_and_reads_server_init() {
        let (port, server) = start_fixture(8, 2, 1024, 768, b"auth fixture");
        let result = connect_fixture(
            port,
            VncSecurityPolicy::PreferEncryption,
            DecodeLimits::default(),
        )
        .unwrap();
        assert_eq!((result.width, result.height), (1024, 768));
        assert_eq!(result.name, "auth fixture");
        server.join().unwrap();
    }

    #[test]
    fn server_init_limits_dimensions_and_name_before_allocation() {
        let mut limits = DecodeLimits::default();
        limits.max_framebuffer_dimension = 100;
        let (port, server) = start_fixture(8, 1, 101, 80, b"fixture");
        let result = connect_fixture(port, VncSecurityPolicy::AllowNone, limits);
        assert!(result.unwrap_err().contains("dimensions exceed"));
        server.join().unwrap();

        let mut limits = DecodeLimits::default();
        limits.max_server_string_bytes = 4;
        let (port, server) = start_fixture(8, 1, 80, 60, b"too long");
        let result = connect_fixture(port, VncSecurityPolicy::AllowNone, limits);
        assert!(result.unwrap_err().contains("server name exceeds"));
        server.join().unwrap();
    }

    #[test]
    fn server_disconnect_is_reported_without_panicking() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"RFB 003.008\n").unwrap();
            let mut client_banner = [0u8; 12];
            stream.read_exact(&mut client_banner).unwrap();
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut connection = RfbConnection::from_stream(
            stream,
            Duration::from_secs(2),
            VncSecurityPolicy::AllowNone,
            DecodeLimits::default(),
        )
        .unwrap();
        assert!(connection.read_server_message().is_err());
        server.join().unwrap();
    }

    #[test]
    fn runtime_mode_clears_the_handshake_read_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address).unwrap();
        let (_server, _) = listener.accept().unwrap();
        let mut connection = RfbConnection::new_stream(
            client,
            Duration::from_secs(2),
            DecodeLimits::default(),
            VncSecurityPolicy::AllowNone,
            8,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            connection.stream.read_timeout().unwrap(),
            Some(Duration::from_secs(2))
        );
        assert!(!connection.read_buffer.enabled);
        connection.enter_runtime_mode().unwrap();
        assert_eq!(connection.stream.read_timeout().unwrap(), None);
        assert!(connection.read_buffer.enabled);
    }

    #[test]
    fn buffered_runtime_reads_decode_many_small_hextile_tiles() {
        // 32x16 Hextile rectangle = two tiles, each "bg specified" (5 bytes):
        // many tiny reads that the runtime buffer must serve exactly, followed
        // by a Raw rectangle whose body bypasses the buffer.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut update = vec![0, 0, 0, 2];
            for value in [0u16, 0, 32, 16] {
                update.extend_from_slice(&value.to_be_bytes());
            }
            update.extend_from_slice(&5i32.to_be_bytes());
            update.extend_from_slice(&[0x02, 9, 8, 7, 0]);
            update.extend_from_slice(&[0x02, 1, 2, 3, 0]);
            for value in [0u16, 16, 1, 1] {
                update.extend_from_slice(&value.to_be_bytes());
            }
            update.extend_from_slice(&0i32.to_be_bytes());
            update.extend_from_slice(&[4, 5, 6, 0]);
            stream.write_all(&update).unwrap();
        });
        let stream = TcpStream::connect(address).unwrap();
        let mut connection = RfbConnection::new_stream(
            stream,
            Duration::from_secs(2),
            DecodeLimits::default(),
            VncSecurityPolicy::AllowNone,
            8,
            None,
            None,
        )
        .unwrap();
        connection.width = 32;
        connection.height = 17;
        connection.framebuffer = Framebuffer::new(32, 17, &DecodeLimits::default())
            .unwrap()
            .shared();
        connection.enter_runtime_mode().unwrap();
        match connection.read_server_message().unwrap() {
            ServerMessage::FramebufferUpdate { rects, .. } => {
                assert_eq!(
                    rects,
                    vec![FbRect::new(0, 0, 32, 16), FbRect::new(0, 16, 1, 1)]
                );
            }
            other => panic!("expected framebuffer update, got {other:?}"),
        }
        let fb = connection.framebuffer();
        let fb = fb.lock().unwrap();
        let relay = fb.relay_frame(FbRect::new(15, 0, 2, 1)).unwrap();
        assert_eq!(&relay[12..], &[9, 8, 7, 255, 1, 2, 3, 255]);
        let raw = fb.relay_frame(FbRect::new(0, 16, 1, 1)).unwrap();
        assert_eq!(&raw[12..], &[4, 5, 6, 255]);
        server.join().unwrap();
    }

    #[test]
    fn decodes_pointer_position_pseudo_encoding_without_a_pixel_payload() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut update = Vec::new();
            update.extend_from_slice(&[0, 0, 0, 1]);
            update.extend_from_slice(&320u16.to_be_bytes());
            update.extend_from_slice(&240u16.to_be_bytes());
            update.extend_from_slice(&0u16.to_be_bytes());
            update.extend_from_slice(&0u16.to_be_bytes());
            update.extend_from_slice(&ENCODING_POINTER_POS.to_be_bytes());
            stream.write_all(&update).unwrap();

            let mut invalid = Vec::new();
            invalid.extend_from_slice(&[0, 0, 0, 1]);
            invalid.extend_from_slice(&320u16.to_be_bytes());
            invalid.extend_from_slice(&240u16.to_be_bytes());
            invalid.extend_from_slice(&1u16.to_be_bytes());
            invalid.extend_from_slice(&0u16.to_be_bytes());
            invalid.extend_from_slice(&ENCODING_POINTER_POS.to_be_bytes());
            stream.write_all(&invalid).unwrap();
        });

        let stream = TcpStream::connect(address).unwrap();
        let mut connection = RfbConnection::new_stream(
            stream,
            Duration::from_secs(2),
            DecodeLimits::default(),
            VncSecurityPolicy::AllowNone,
            8,
            None,
            None,
        )
        .unwrap();
        connection.width = 800;
        connection.height = 600;
        connection.framebuffer = Framebuffer::new(800, 600, &DecodeLimits::default())
            .unwrap()
            .shared();

        match connection.read_server_message().unwrap() {
            ServerMessage::FramebufferUpdate {
                rects,
                cursor,
                pointer_pos,
            } => {
                assert!(rects.is_empty());
                assert!(cursor.is_none());
                assert_eq!(pointer_pos, Some(DecodedPointerPosition { x: 320, y: 240 }));
            }
            other => panic!("expected pointer position update, got {other:?}"),
        }
        assert!(connection.read_server_message().is_err());
        server.join().unwrap();
    }

    #[test]
    fn decodes_visible_and_hidden_x_cursor_pseudo_encodings() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();

            let mut visible = Vec::new();
            visible.extend_from_slice(&[0, 0, 0, 1]);
            visible.extend_from_slice(&1u16.to_be_bytes());
            visible.extend_from_slice(&0u16.to_be_bytes());
            visible.extend_from_slice(&2u16.to_be_bytes());
            visible.extend_from_slice(&1u16.to_be_bytes());
            visible.extend_from_slice(&ENCODING_X_CURSOR.to_be_bytes());
            visible.extend_from_slice(&[1, 2, 3, 4, 5, 6]);
            visible.extend_from_slice(&[0b1000_0000]);
            visible.extend_from_slice(&[0b1100_0000]);
            stream.write_all(&visible).unwrap();

            let mut hidden = Vec::new();
            hidden.extend_from_slice(&[0, 0, 0, 1]);
            hidden.extend_from_slice(&0u16.to_be_bytes());
            hidden.extend_from_slice(&0u16.to_be_bytes());
            hidden.extend_from_slice(&0u16.to_be_bytes());
            hidden.extend_from_slice(&0u16.to_be_bytes());
            hidden.extend_from_slice(&ENCODING_X_CURSOR.to_be_bytes());
            stream.write_all(&hidden).unwrap();
        });

        let stream = TcpStream::connect(address).unwrap();
        let mut connection = RfbConnection::new_stream(
            stream,
            Duration::from_secs(2),
            DecodeLimits::default(),
            VncSecurityPolicy::AllowNone,
            8,
            None,
            None,
        )
        .unwrap();
        connection.width = 800;
        connection.height = 600;
        connection.framebuffer = Framebuffer::new(800, 600, &DecodeLimits::default())
            .unwrap()
            .shared();

        match connection.read_server_message().unwrap() {
            ServerMessage::FramebufferUpdate {
                rects,
                cursor: Some(cursor),
                pointer_pos,
            } => {
                assert!(rects.is_empty());
                assert!(pointer_pos.is_none());
                assert_eq!((cursor.hotspot_x, cursor.hotspot_y), (1, 0));
                assert_eq!((cursor.width, cursor.height), (2, 1));
                assert_eq!(cursor.rgba, vec![1, 2, 3, 255, 4, 5, 6, 255]);
            }
            other => panic!("expected visible X cursor update, got {other:?}"),
        }

        match connection.read_server_message().unwrap() {
            ServerMessage::FramebufferUpdate {
                rects,
                cursor: Some(cursor),
                pointer_pos,
            } => {
                assert!(rects.is_empty());
                assert!(pointer_pos.is_none());
                assert_eq!((cursor.width, cursor.height), (0, 0));
                assert!(cursor.rgba.is_empty());
            }
            other => panic!("expected hidden X cursor update, got {other:?}"),
        }

        server.join().unwrap();
    }
}
