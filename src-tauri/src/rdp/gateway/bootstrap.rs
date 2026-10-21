use super::authentication::build_ntlm_negotiate_authorization;
use super::http::build_basic_authorization;
use super::http::build_rpc_in_request_with_auth;
use super::http::build_rpc_out_request_with_auth;
use super::ndr;
use super::rpc::build_tsproxy_bind_pdu;
use super::rpch;
use super::tunnel::validate_gateway_base;
use crate::rdp::GatewayOpt;
pub const RPC_HTTP_CONTENT_LENGTH: u64 = 0x4000_0000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayInitialPackets {
    pub http_host: String,
    pub rdg_path: String,
    pub session_id: String,
    pub rts_cookies: rpch::RtsCookies,
    pub rpc_in_headers: Vec<u8>,
    pub rpc_out_headers: Vec<u8>,
    pub conn_a1_pdu: Vec<u8>,
    pub conn_b1_pdu: Vec<u8>,
    pub bind_pdu: Vec<u8>,
    pub create_tunnel_pdu: Vec<u8>,
}

pub fn gateway_rpc_path(gateway_host: &str) -> String {
    format!("/rpc/rpcproxy.dll?{}:3388", gateway_host.trim())
}

pub fn build_gateway_initial_packets(g: &GatewayOpt) -> Result<GatewayInitialPackets, String> {
    validate_gateway_base(g, "placeholder", 3389)?;
    let http_host = gateway_http_host(&g.host, g.port);
    let rdg_path = gateway_rpc_path(&g.host);
    let authorization = build_gateway_authorization(g)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let rts_cookies = rpch::RtsCookies::new_random();
    let conn_a1_pdu = rpch::build_conn_a1_pdu(&rts_cookies, rpch::DEFAULT_RECEIVE_WINDOW);
    let conn_b1_pdu = rpch::build_conn_b1_pdu(
        &rts_cookies,
        rpch::DEFAULT_CHANNEL_LIFETIME,
        rpch::DEFAULT_CLIENT_KEEPALIVE_MS,
    );
    let rpc_in_headers = build_rpc_in_request_with_auth(
        &http_host,
        &rdg_path,
        RPC_HTTP_CONTENT_LENGTH,
        None,
        Some(&authorization),
        Some(&session_id),
    );
    let rpc_out_headers = build_rpc_out_request_with_auth(
        &http_host,
        &rdg_path,
        conn_a1_pdu.len() as u64,
        None,
        Some(&authorization),
        Some(&session_id),
    );
    Ok(GatewayInitialPackets {
        http_host,
        rdg_path,
        session_id,
        rts_cookies,
        rpc_in_headers,
        rpc_out_headers,
        conn_a1_pdu,
        conn_b1_pdu,
        bind_pdu: build_tsproxy_bind_pdu(1),
        create_tunnel_pdu: ndr::build_create_tunnel_request(2),
    })
}

pub(super) fn gateway_http_host(host: &str, port: u16) -> String {
    if port == 443 {
        host.trim().to_string()
    } else {
        format!("{}:{}", host.trim(), port)
    }
}

pub(super) fn build_gateway_authorization(g: &GatewayOpt) -> Result<String, String> {
    match g.auth.as_str() {
        "basic" => Ok(build_basic_authorization(
            &g.username,
            g.password.as_deref().unwrap_or_default(),
        )),
        "ntlm" => Ok(build_ntlm_negotiate_authorization(&g.username)),
        other => Err(format!(
            "rdg: auth '{}' not supported (basic | ntlm)",
            other
        )),
    }
}
