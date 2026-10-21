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
//! Public API preserved here; implementation is split by protocol responsibility:
//!
//! - The public [`GatewayOpt`] config + thin re-export from `crate::rdp`.
//! - DCE/RPC common header (`rpc_pdu_header`), used by every TsProxy call.
//! - PDU constructors for Bind, BindAck, AlterContext, Request, Response.
//! - HTTP request line builders for RPC_IN_DATA and RPC_OUT_DATA.
//! - HTTP response parsing and gateway auth header helpers.
//! - NDR-bypass data packet builders for TsProxySendToServer and
//!   TsProxySetupReceivePipe.
//! - The NTLMv2 helper module (`ntlm`) — type 1/2/3 message framing
//!   plus HMAC-MD5 compute.
//! - The [`GatewayStream`] type implementing `AsyncRead + AsyncWrite`.
//! - The high-level [`open_tunnel`] entry that opens the authenticated
//!   HTTPS pair, completes the RTS bootstrap, runs the TsProxy handshake,
//!   and exposes the resulting channel as a byte stream.

pub use crate::rdp::GatewayOpt;
pub use bootstrap::{
    GatewayInitialPackets, RPC_HTTP_CONTENT_LENGTH, build_gateway_initial_packets, gateway_rpc_path,
};
pub use http::{
    HttpResponseHead, build_basic_authorization, build_rpc_in_request,
    build_rpc_in_request_with_auth, build_rpc_out_request, build_rpc_out_request_with_auth,
    parse_http_response_head, www_authenticate_token,
};
pub use payload::{
    RDG_CONTEXT_HANDLE_SIZE, ReceivePipePayload, TSPROXY_OPNUM_SEND_TO_SERVER,
    TSPROXY_OPNUM_SETUP_RECEIVE_PIPE, build_receive_pipe_message, build_send_data_message,
    build_send_to_server_request, build_setup_receive_pipe_request, decode_receive_pipe_response,
};
pub use rpc::{
    BindAckPdu, BindAckResult, BindParams, DEFAULT_RPC_FRAG_SIZE, FaultPdu,
    NDR_TRANSFER_SYNTAX_UUID, NDR_TRANSFER_SYNTAX_VERSION, PFC_FIRST_FRAG, PFC_LAST_FRAG,
    PFC_OBJECT_UUID, PFC_PENDING_CANCEL, PFC_SUPPORT_HEADER_SIGN, RPC_PT_ALTER_CONTEXT,
    RPC_PT_ALTER_CONTEXT_RESP, RPC_PT_BIND, RPC_PT_BIND_ACK, RPC_PT_BIND_NAK, RPC_PT_FAULT,
    RPC_PT_REQUEST, RPC_PT_RESPONSE, RPC_VERSION, RPC_VERSION_MINOR, ResponsePdu, RpcPduHeader,
    TSPROXY_RPC_INTERFACE_UUID, TSPROXY_RPC_INTERFACE_VERSION, build_bind_body, build_bind_pdu,
    build_request_pdu, build_tsproxy_bind_pdu, parse_bind_ack_pdu, parse_fault_pdu,
    parse_response_pdu,
};
pub use stream::GatewayStream;
pub use tunnel::open_tunnel;
mod authentication;
mod bootstrap;
mod http;
mod payload;
mod rpc;
mod rpc_transport;
mod stream;
mod transport;
mod tunnel;

#[cfg(test)]
mod tests;

pub mod ndr;
pub mod ntlm;
pub mod rpch;
