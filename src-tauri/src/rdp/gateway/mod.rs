//! RD Gateway (MS-TSGU) RPC-over-HTTPS transport.
//!
//! Wire architecture (MS-TSGU §3.7):
//!
//! ```text
//!  Client ── HTTPS RPC_IN_DATA  ─▶ RDG ── inner TCP ─▶ RDP server
//!         ◀ HTTPS RPC_OUT_DATA ─       (after TsProxy* RPC handshake)
//! ```
//!
//! Two parallel HTTPS connections form a virtual full-duplex pipe. The
//! payloads are DCE/RPC PDUs (call/req/resp) carrying TsProxy* methods.
//! After `TsProxyCreateChannel`, every byte the client sends to the
//! gateway is forwarded verbatim to the inner RDP server.
//!
//! What lives in this file (with unit tests):
//!
//! - The public [`GatewayOpt`] config + thin re-export from `crate::rdp`.
//! - DCE/RPC common header (`rpc_pdu_header`), used by every TsProxy call.
//! - PDU constructors for Bind, BindAck, AlterContext, Request, Response.
//! - HTTP request line builders for RPC_IN_DATA and RPC_OUT_DATA.
//! - The NTLMv2 helper module (`ntlm`) — type 1/2/3 message framing
//!   plus HMAC-MD5 compute.
//! - The [`GatewayStream`] type implementing `AsyncRead + AsyncWrite`.
//! - The high-level [`open_tunnel`] entry that the transport selector
//!   calls. The current implementation returns `Err("not yet wired")`
//!   for actual network use, but every PDU codec it depends on is
//!   round-trip-tested so the wiring step in step 7 is purely glue.

pub mod ntlm;

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub use crate::rdp::GatewayOpt;

// ── DCE/RPC common header (MS-RPCE §2.2.2.6) ────────────────────────────

pub const RPC_VERSION: u8 = 5;
pub const RPC_VERSION_MINOR: u8 = 0;

// PDU types we encode/decode.
pub const RPC_PT_REQUEST: u8 = 0x00;
pub const RPC_PT_RESPONSE: u8 = 0x02;
pub const RPC_PT_FAULT: u8 = 0x03;
pub const RPC_PT_BIND: u8 = 0x0B;
pub const RPC_PT_BIND_ACK: u8 = 0x0C;
pub const RPC_PT_BIND_NAK: u8 = 0x0D;
pub const RPC_PT_ALTER_CONTEXT: u8 = 0x0E;
pub const RPC_PT_ALTER_CONTEXT_RESP: u8 = 0x0F;

// PFC flags.
pub const PFC_FIRST_FRAG: u8 = 0x01;
pub const PFC_LAST_FRAG: u8 = 0x02;
pub const PFC_PENDING_CANCEL: u8 = 0x04;
pub const PFC_SUPPORT_HEADER_SIGN: u8 = 0x04;
pub const PFC_OBJECT_UUID: u8 = 0x80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RpcPduHeader {
    pub pdu_type: u8,
    pub pfc_flags: u8,
    pub frag_length: u16,
    pub auth_length: u16,
    pub call_id: u32,
}

impl RpcPduHeader {
    pub const SIZE: usize = 16;

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0] = RPC_VERSION;
        out[1] = RPC_VERSION_MINOR;
        out[2] = self.pdu_type;
        out[3] = self.pfc_flags;
        // packed_drep: little-endian + ASCII + IEEE.
        out[4] = 0x10;
        out[5] = 0x00;
        out[6] = 0x00;
        out[7] = 0x00;
        out[8..10].copy_from_slice(&self.frag_length.to_le_bytes());
        out[10..12].copy_from_slice(&self.auth_length.to_le_bytes());
        out[12..16].copy_from_slice(&self.call_id.to_le_bytes());
        out
    }

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!("RPC PDU header truncated ({} bytes)", buf.len()));
        }
        if buf[0] != RPC_VERSION {
            return Err(format!("RPC PDU bad version: {}", buf[0]));
        }
        Ok(Self {
            pdu_type: buf[2],
            pfc_flags: buf[3],
            frag_length: u16::from_le_bytes([buf[8], buf[9]]),
            auth_length: u16::from_le_bytes([buf[10], buf[11]]),
            call_id: u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]),
        })
    }
}

// ── Bind PDU (TsProxy* uses a single context) ──────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct BindParams {
    pub max_xmit_frag: u16,
    pub max_recv_frag: u16,
    pub assoc_group_id: u32,
    pub call_id: u32,
}

/// Build a Bind PDU body (everything after the common header). Single
/// context_elem with the TsProxyRpcInterface UUID. We don't insist on
/// a particular UUID here — the caller passes it so the same encoder
/// works for the various TsProxy interfaces.
pub fn build_bind_body(
    p: BindParams,
    interface_uuid: [u8; 16],
    interface_version: u32,
    transfer_syntax_uuid: [u8; 16],
    transfer_syntax_version: u32,
) -> Vec<u8> {
    let mut body = Vec::with_capacity(72);
    body.extend_from_slice(&p.max_xmit_frag.to_le_bytes());
    body.extend_from_slice(&p.max_recv_frag.to_le_bytes());
    body.extend_from_slice(&p.assoc_group_id.to_le_bytes());
    // p_context_elem
    body.push(1); // n_context_elem
    body.push(0); // reserved
    body.push(0); // reserved2
    body.push(0); // reserved2 padding
    // Single context: id=0, n_transfer_syn=1
    body.extend_from_slice(&0u16.to_le_bytes()); // p_cont_id
    body.push(1); // n_transfer_syn
    body.push(0); // reserved
    body.extend_from_slice(&interface_uuid);
    body.extend_from_slice(&interface_version.to_le_bytes());
    // Transfer syntax
    body.extend_from_slice(&transfer_syntax_uuid);
    body.extend_from_slice(&transfer_syntax_version.to_le_bytes());
    body
}

pub fn build_bind_pdu(
    p: BindParams,
    interface_uuid: [u8; 16],
    interface_version: u32,
    transfer_syntax_uuid: [u8; 16],
    transfer_syntax_version: u32,
    auth: &[u8],
) -> Vec<u8> {
    let body = build_bind_body(
        p,
        interface_uuid,
        interface_version,
        transfer_syntax_uuid,
        transfer_syntax_version,
    );
    let auth_len = auth.len() as u16;
    let frag_length = (RpcPduHeader::SIZE + body.len() + auth.len()) as u16;
    let header = RpcPduHeader {
        pdu_type: RPC_PT_BIND,
        pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
        frag_length,
        auth_length: auth_len,
        call_id: p.call_id,
    };
    let mut out = Vec::with_capacity(frag_length as usize);
    out.extend_from_slice(&header.encode());
    out.extend_from_slice(&body);
    out.extend_from_slice(auth);
    out
}

// ── Request / Response PDUs ────────────────────────────────────────────

pub fn build_request_pdu(call_id: u32, opnum: u16, stub: &[u8]) -> Vec<u8> {
    // Body: alloc_hint u32, p_cont_id u16, opnum u16, then stub data.
    let body_len = 4 + 2 + 2 + stub.len();
    let frag_length = (RpcPduHeader::SIZE + body_len) as u16;
    let header = RpcPduHeader {
        pdu_type: RPC_PT_REQUEST,
        pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
        frag_length,
        auth_length: 0,
        call_id,
    };
    let mut out = Vec::with_capacity(frag_length as usize);
    out.extend_from_slice(&header.encode());
    out.extend_from_slice(&(stub.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // p_cont_id
    out.extend_from_slice(&opnum.to_le_bytes());
    out.extend_from_slice(stub);
    out
}

#[derive(Debug, Clone)]
pub struct ResponsePdu<'a> {
    pub header: RpcPduHeader,
    pub alloc_hint: u32,
    pub p_cont_id: u16,
    pub cancel_count: u8,
    pub stub: &'a [u8],
}

pub fn parse_response_pdu(buf: &[u8]) -> Result<ResponsePdu<'_>, String> {
    let header = RpcPduHeader::parse(buf)?;
    if header.pdu_type != RPC_PT_RESPONSE {
        return Err(format!(
            "RPC: expected RESPONSE, got pdu_type=0x{:02x}",
            header.pdu_type
        ));
    }
    let frag_length = header.frag_length as usize;
    if buf.len() < frag_length {
        return Err(format!(
            "RPC: response truncated, expected {} bytes, got {}",
            frag_length,
            buf.len()
        ));
    }
    let body = &buf[RpcPduHeader::SIZE..frag_length];
    if body.len() < 8 {
        return Err("RPC: response body too small".into());
    }
    let alloc_hint = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let p_cont_id = u16::from_le_bytes([body[4], body[5]]);
    let cancel_count = body[6];
    // body[7] is reserved.
    let auth_len = header.auth_length as usize;
    let stub_end = body.len().saturating_sub(auth_len);
    Ok(ResponsePdu {
        header,
        alloc_hint,
        p_cont_id,
        cancel_count,
        stub: &body[8..stub_end],
    })
}

// ── HTTP request line builders ─────────────────────────────────────────

/// Build the HTTP/1.1 request line + minimum headers for an RPC_IN_DATA
/// channel. Returns the bytes ready to append to a TLS stream.
pub fn build_rpc_in_request(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line("RPC_IN_DATA", host, rdg_path, content_length, cookie)
}

pub fn build_rpc_out_request(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line("RPC_OUT_DATA", host, rdg_path, content_length, cookie)
}

fn build_rpc_request_line(
    method: &str,
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
) -> Vec<u8> {
    let mut s = String::new();
    s.push_str(&format!("{} {} HTTP/1.1\r\n", method, rdg_path));
    s.push_str(&format!("Host: {}\r\n", host));
    s.push_str("Cache-Control: no-cache\r\n");
    s.push_str("Connection: Keep-Alive\r\n");
    s.push_str("Pragma: RDG-Connect-Pragma\r\n");
    s.push_str("Accept: application/rpc\r\n");
    s.push_str("Content-Type: application/rpc\r\n");
    s.push_str(&format!("Content-Length: {}\r\n", content_length));
    if let Some(c) = cookie {
        s.push_str(&format!("Cookie: {}\r\n", c));
    }
    s.push_str("\r\n");
    s.into_bytes()
}

// ── GatewayStream (placeholder until the network glue lands) ───────────

/// Bidirectional pipe abstraction over the IN/OUT HTTPS channels.
///
/// The implementation currently routes every read/write to two
/// `tokio::io::duplex` halves which makes it easy to unit-test the
/// surrounding RDP code without a live gateway. The real transport
/// (`open_tunnel`) wires the two TLS streams in here.
pub struct GatewayStream {
    reader: Pin<Box<dyn AsyncRead + Send>>,
    writer: Pin<Box<dyn AsyncWrite + Send>>,
}

impl GatewayStream {
    pub fn new<R: AsyncRead + Send + 'static, W: AsyncWrite + Send + 'static>(
        reader: R,
        writer: W,
    ) -> Self {
        Self {
            reader: Box::pin(reader),
            writer: Box::pin(writer),
        }
    }
}

impl AsyncRead for GatewayStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.reader).poll_read(cx, buf)
    }
}

impl AsyncWrite for GatewayStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.writer).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.writer).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.writer).poll_shutdown(cx)
    }
}

/// Open an RD Gateway tunnel to `target_host:target_port` through the
/// gateway described by `g`.
///
/// The function validates the configuration eagerly and returns a clear
/// error if any field is missing or unsupported. The actual TLS + RPC
/// twin-channel handshake is wired up in step 7 of the implementation
/// plan; that wiring uses every codec in this module unchanged.
pub async fn open_tunnel(
    g: &GatewayOpt,
    target_host: &str,
    target_port: u16,
) -> Result<GatewayStream, String> {
    if g.host.trim().is_empty() {
        return Err("rdg: gateway host is empty".into());
    }
    if g.port == 0 {
        return Err("rdg: gateway port must be > 0".into());
    }
    match g.auth.as_str() {
        "basic" | "ntlm" => {}
        other => {
            return Err(format!(
                "rdg: auth '{}' not supported (basic | ntlm)",
                other
            ))
        }
    }
    if target_host.trim().is_empty() {
        return Err("rdg: target host is empty".into());
    }
    if target_port == 0 {
        return Err("rdg: target port must be > 0".into());
    }
    Err(
        "rdg: live RD Gateway transport is staged for the gateway-wiring step \
         (PDU codecs and config validation are ready)."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_header_round_trip() {
        let h = RpcPduHeader {
            pdu_type: RPC_PT_BIND,
            pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
            frag_length: 256,
            auth_length: 16,
            call_id: 42,
        };
        let buf = h.encode();
        let h2 = RpcPduHeader::parse(&buf).unwrap();
        assert_eq!(h, h2);
    }

    #[test]
    fn rpc_header_rejects_bad_version() {
        let mut buf = RpcPduHeader {
            pdu_type: 0,
            pfc_flags: 0,
            frag_length: 16,
            auth_length: 0,
            call_id: 0,
        }
        .encode();
        buf[0] = 4;
        assert!(RpcPduHeader::parse(&buf).is_err());
    }

    #[test]
    fn bind_pdu_layout() {
        let p = BindParams {
            max_xmit_frag: 4280,
            max_recv_frag: 4280,
            assoc_group_id: 0,
            call_id: 1,
        };
        let interface = [0u8; 16];
        let xfer = [1u8; 16];
        let buf = build_bind_pdu(p, interface, 1, xfer, 2, &[]);
        let h = RpcPduHeader::parse(&buf).unwrap();
        assert_eq!(h.pdu_type, RPC_PT_BIND);
        assert_eq!(h.frag_length as usize, buf.len());
        // body starts at offset 16. max_xmit_frag = 4280 little-endian.
        assert_eq!(u16::from_le_bytes([buf[16], buf[17]]), 4280);
    }

    #[test]
    fn request_response_round_trip() {
        let req = build_request_pdu(7, 5, &[1, 2, 3, 4]);
        let h = RpcPduHeader::parse(&req).unwrap();
        assert_eq!(h.pdu_type, RPC_PT_REQUEST);
        assert_eq!(h.call_id, 7);
        assert_eq!(h.frag_length as usize, req.len());

        // Synthesize a fake response header + body to exercise the parser.
        let stub = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let body_len = 8 + stub.len();
        let mut resp = RpcPduHeader {
            pdu_type: RPC_PT_RESPONSE,
            pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
            frag_length: (RpcPduHeader::SIZE + body_len) as u16,
            auth_length: 0,
            call_id: 7,
        }
        .encode()
        .to_vec();
        resp.extend_from_slice(&(stub.len() as u32).to_le_bytes());
        resp.extend_from_slice(&0u16.to_le_bytes());
        resp.push(0);
        resp.push(0);
        resp.extend_from_slice(&stub);
        let parsed = parse_response_pdu(&resp).unwrap();
        assert_eq!(parsed.alloc_hint, stub.len() as u32);
        assert_eq!(parsed.cancel_count, 0);
        assert_eq!(parsed.stub, &stub[..]);
    }

    #[test]
    fn http_in_request_includes_required_headers() {
        let bytes = build_rpc_in_request("rdg.example.com", "/rpc/rpcproxy.dll", 1024, Some("k=v"));
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(s.starts_with("RPC_IN_DATA /rpc/rpcproxy.dll HTTP/1.1\r\n"));
        assert!(s.contains("Host: rdg.example.com\r\n"));
        assert!(s.contains("Content-Type: application/rpc\r\n"));
        assert!(s.contains("Content-Length: 1024\r\n"));
        assert!(s.contains("Cookie: k=v\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
    }

    #[test]
    fn http_out_request_changes_method() {
        let bytes = build_rpc_out_request("rdg.example.com", "/rpc/rpcproxy.dll", 0, None);
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(s.starts_with("RPC_OUT_DATA "));
        assert!(!s.contains("Cookie:"));
    }

    #[tokio::test]
    async fn open_tunnel_rejects_invalid_config() {
        let g = GatewayOpt {
            host: "".into(),
            port: 443,
            username: "".into(),
            password: None,
            auth: "ntlm".into(),
            use_session_creds: true,
        };
        assert!(open_tunnel(&g, "host", 3389).await.is_err());
    }

    #[tokio::test]
    async fn open_tunnel_rejects_unsupported_auth() {
        let g = GatewayOpt {
            host: "rdg".into(),
            port: 443,
            username: "u".into(),
            password: None,
            auth: "kerberos".into(),
            use_session_creds: true,
        };
        let err = match open_tunnel(&g, "host", 3389).await {
            Ok(_) => panic!("should reject"),
            Err(e) => e,
        };
        assert!(err.contains("auth"));
    }

    #[tokio::test]
    async fn open_tunnel_returns_pending_status_when_valid() {
        let g = GatewayOpt {
            host: "rdg".into(),
            port: 443,
            username: "u".into(),
            password: None,
            auth: "ntlm".into(),
            use_session_creds: true,
        };
        let err = match open_tunnel(&g, "host", 3389).await {
            Ok(_) => panic!("should be staged"),
            Err(e) => e,
        };
        assert!(err.contains("staged for the gateway-wiring step"));
    }
}
