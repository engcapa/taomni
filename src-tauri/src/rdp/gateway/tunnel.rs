use super::bootstrap::build_gateway_initial_packets;
use super::ndr;
use super::payload::build_setup_receive_pipe_request;
use super::rpc::parse_bind_ack_pdu;
use super::rpc_transport::ensure_rpc_return_zero;
use super::rpc_transport::read_non_rts_pdu;
use super::rpc_transport::read_response_for_call;
use super::rpc_transport::read_rpc_pdu;
use super::rpch;
use super::stream::GatewayStream;
use super::stream::spawn_gateway_stream;
use super::transport::RpcHttpChannel;
use super::transport::connect_authenticated_rpc_channel;
use crate::rdp::GatewayOpt;
use tokio::io::AsyncWriteExt as _;
/// Open an RD Gateway tunnel to `target_host:target_port` through the
/// gateway described by `g`.
pub async fn open_tunnel(
    g: &GatewayOpt,
    target_host: &str,
    target_port: u16,
) -> Result<GatewayStream, String> {
    validate_gateway_base(g, target_host, target_port)?;
    let initial_packets = build_gateway_initial_packets(g)?;

    let mut in_stream =
        connect_authenticated_rpc_channel(g, &initial_packets, RpcHttpChannel::In).await?;
    in_stream
        .write_all(&initial_packets.conn_b1_pdu)
        .await
        .map_err(|e| format!("rdg: write CONN/B1: {}", e))?;

    let mut out_stream =
        connect_authenticated_rpc_channel(g, &initial_packets, RpcHttpChannel::Out).await?;
    out_stream
        .write_all(&initial_packets.conn_a1_pdu)
        .await
        .map_err(|e| format!("rdg: write CONN/A1: {}", e))?;

    let a3 = read_rpc_pdu(&mut out_stream).await?;
    let _a3 = rpch::parse_conn_a3_pdu(&a3)?;
    let c2 = read_rpc_pdu(&mut out_stream).await?;
    let _c2 = rpch::parse_conn_c2_pdu(&c2)?;

    in_stream
        .write_all(&initial_packets.bind_pdu)
        .await
        .map_err(|e| format!("rdg: write TsProxy bind PDU: {}", e))?;
    let bind_ack = read_non_rts_pdu(&mut out_stream).await?;
    let bind = parse_bind_ack_pdu(&bind_ack)?;
    if !bind.results.iter().any(|r| r.result == 0) {
        return Err(format!(
            "rdg: TsProxy bind was rejected: {:?}",
            bind.results
        ));
    }

    in_stream
        .write_all(&initial_packets.create_tunnel_pdu)
        .await
        .map_err(|e| format!("rdg: write TsProxyCreateTunnel: {}", e))?;
    let create_tunnel = read_response_for_call(&mut out_stream, 2, "TsProxyCreateTunnel").await?;
    let tunnel = ndr::parse_create_tunnel_response_stub(&create_tunnel)?;
    ensure_rpc_return_zero(tunnel.return_value, "TsProxyCreateTunnel")?;

    let authorize = ndr::build_authorize_tunnel_request(3, &tunnel.tunnel_context, "TAOMNI", &[])?;
    in_stream
        .write_all(&authorize)
        .await
        .map_err(|e| format!("rdg: write TsProxyAuthorizeTunnel: {}", e))?;
    let authorize = read_response_for_call(&mut out_stream, 3, "TsProxyAuthorizeTunnel").await?;
    let authorize = ndr::parse_authorize_tunnel_response_stub(&authorize)?;
    if let Some(rv) = authorize.return_value {
        ensure_rpc_return_zero(rv, "TsProxyAuthorizeTunnel")?;
    }

    let make_tunnel_call = ndr::build_make_tunnel_call_request(4, &tunnel.tunnel_context);
    in_stream
        .write_all(&make_tunnel_call)
        .await
        .map_err(|e| format!("rdg: write TsProxyMakeTunnelCall: {}", e))?;
    let create_channel =
        ndr::build_create_channel_request(5, &tunnel.tunnel_context, target_host, target_port)?;
    in_stream
        .write_all(&create_channel)
        .await
        .map_err(|e| format!("rdg: write TsProxyCreateChannel: {}", e))?;
    let create_channel = read_response_for_call(&mut out_stream, 5, "TsProxyCreateChannel").await?;
    let channel = ndr::parse_create_channel_response_stub(&create_channel)?;
    ensure_rpc_return_zero(channel.return_value, "TsProxyCreateChannel")?;

    let receive_call_id = 6;
    let setup_receive_pipe =
        build_setup_receive_pipe_request(receive_call_id, &channel.channel_context);
    in_stream
        .write_all(&setup_receive_pipe)
        .await
        .map_err(|e| format!("rdg: write TsProxySetupReceivePipe: {}", e))?;

    Ok(spawn_gateway_stream(
        in_stream,
        out_stream,
        tunnel.tunnel_context,
        channel.channel_context,
        receive_call_id,
    ))
}

pub(super) fn validate_gateway_base(
    g: &GatewayOpt,
    target_host: &str,
    target_port: u16,
) -> Result<(), String> {
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
            ));
        }
    }
    if g.username.trim().is_empty() {
        return Err("rdg: gateway username is empty".into());
    }
    if g.password.as_deref().unwrap_or("").is_empty() {
        return Err("rdg: gateway password is empty".into());
    }
    if target_host.trim().is_empty() {
        return Err("rdg: target host is empty".into());
    }
    if target_port == 0 {
        return Err("rdg: target port must be > 0".into());
    }
    Ok(())
}
