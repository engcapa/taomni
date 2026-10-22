use super::authentication::build_ntlm_authenticate_authorization;
use super::authentication::build_ntlm_negotiate_message;
use super::authentication::ntlm_filetime_from_unix_duration;
use super::authentication::split_ntlm_domain_user;
use super::bootstrap::build_gateway_initial_packets;
use super::http::build_basic_authorization;
use super::http::build_rpc_in_request;
use super::http::build_rpc_in_request_with_auth;
use super::http::build_rpc_out_request;
use super::http::parse_http_response_head;
use super::http::www_authenticate_token;
use super::ndr;
use super::ntlm;
use super::payload::RDG_CONTEXT_HANDLE_SIZE;
use super::payload::ReceivePipePayload;
use super::payload::TSPROXY_OPNUM_SEND_TO_SERVER;
use super::payload::TSPROXY_OPNUM_SETUP_RECEIVE_PIPE;
use super::payload::build_receive_pipe_message;
use super::payload::build_send_data_message;
use super::payload::build_send_to_server_request;
use super::payload::build_setup_receive_pipe_request;
use super::payload::decode_receive_pipe_response;
use super::rpc::BindParams;
use super::rpc::NDR_TRANSFER_SYNTAX_UUID;
use super::rpc::NDR_TRANSFER_SYNTAX_VERSION;
use super::rpc::PFC_FIRST_FRAG;
use super::rpc::PFC_LAST_FRAG;
use super::rpc::RPC_PT_BIND;
use super::rpc::RPC_PT_BIND_ACK;
use super::rpc::RPC_PT_FAULT;
use super::rpc::RPC_PT_REQUEST;
use super::rpc::RPC_PT_RESPONSE;
use super::rpc::RpcPduHeader;
use super::rpc::TSPROXY_RPC_INTERFACE_UUID;
use super::rpc::TSPROXY_RPC_INTERFACE_VERSION;
use super::rpc::build_bind_pdu;
use super::rpc::build_request_pdu;
use super::rpc::build_tsproxy_bind_pdu;
use super::rpc::parse_bind_ack_pdu;
use super::rpc::parse_fault_pdu;
use super::rpc::parse_response_pdu;
use super::rpch;
use super::stream::close_gateway_contexts;
use super::tunnel::open_tunnel;
use crate::rdp::GatewayOpt;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use std::io;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::time::Duration;
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
fn tsproxy_bind_uses_official_interface_and_ndr_syntax() {
    let buf = build_tsproxy_bind_pdu(1);
    let h = RpcPduHeader::parse(&buf).unwrap();
    assert_eq!(h.pdu_type, RPC_PT_BIND);
    assert_eq!(h.call_id, 1);
    assert_eq!(&buf[32..48], &TSPROXY_RPC_INTERFACE_UUID);
    assert_eq!(
        u32::from_le_bytes([buf[48], buf[49], buf[50], buf[51]]),
        TSPROXY_RPC_INTERFACE_VERSION
    );
    assert_eq!(&buf[52..68], &NDR_TRANSFER_SYNTAX_UUID);
    assert_eq!(
        u32::from_le_bytes([buf[68], buf[69], buf[70], buf[71]]),
        NDR_TRANSFER_SYNTAX_VERSION
    );
}

#[test]
fn parses_bind_ack_result_list() {
    let mut body = Vec::new();
    body.extend_from_slice(&4280u16.to_le_bytes());
    body.extend_from_slice(&4280u16.to_le_bytes());
    body.extend_from_slice(&0x1234u32.to_le_bytes());
    body.extend_from_slice(&5u16.to_le_bytes());
    body.extend_from_slice(b"3388\0");
    while (RpcPduHeader::SIZE + body.len()) % 4 != 0 {
        body.push(0);
    }
    body.push(1); // n_results
    body.push(0);
    body.extend_from_slice(&0u16.to_le_bytes());
    body.extend_from_slice(&0u16.to_le_bytes()); // acceptance
    body.extend_from_slice(&0u16.to_le_bytes());
    body.extend_from_slice(&NDR_TRANSFER_SYNTAX_UUID);
    body.extend_from_slice(&NDR_TRANSFER_SYNTAX_VERSION.to_le_bytes());

    let mut pdu = RpcPduHeader {
        pdu_type: RPC_PT_BIND_ACK,
        pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
        frag_length: (RpcPduHeader::SIZE + body.len()) as u16,
        auth_length: 0,
        call_id: 1,
    }
    .encode()
    .to_vec();
    pdu.extend_from_slice(&body);

    let parsed = parse_bind_ack_pdu(&pdu).unwrap();
    assert_eq!(parsed.max_xmit_frag, 4280);
    assert_eq!(parsed.max_recv_frag, 4280);
    assert_eq!(parsed.assoc_group_id, 0x1234);
    assert_eq!(parsed.secondary_address, "3388");
    assert_eq!(parsed.results.len(), 1);
    assert_eq!(parsed.results[0].result, 0);
    assert_eq!(
        parsed.results[0].transfer_syntax_uuid,
        NDR_TRANSFER_SYNTAX_UUID
    );
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
fn parses_fault_pdu_status() {
    let mut fault = RpcPduHeader {
        pdu_type: RPC_PT_FAULT,
        pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
        frag_length: 16 + 16,
        auth_length: 0,
        call_id: 99,
    }
    .encode()
    .to_vec();
    fault.extend_from_slice(&4u32.to_le_bytes());
    fault.extend_from_slice(&0u16.to_le_bytes());
    fault.push(0);
    fault.push(0);
    fault.extend_from_slice(&0x0000_59ddu32.to_le_bytes());
    fault.extend_from_slice(&0u32.to_le_bytes());

    let parsed = parse_fault_pdu(&fault).unwrap();
    assert_eq!(parsed.header.call_id, 99);
    assert_eq!(parsed.status, 0x0000_59dd);
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

#[test]
fn http_request_can_include_authorization() {
    let auth = build_basic_authorization("alice", "secret");
    assert_eq!(auth, "Basic YWxpY2U6c2VjcmV0");
    let bytes = build_rpc_in_request_with_auth(
        "rdg.example.com",
        "/rpc/rpcproxy.dll",
        1,
        None,
        Some(&auth),
        None,
    );
    let s = std::str::from_utf8(&bytes).unwrap();
    assert!(s.contains("Authorization: Basic YWxpY2U6c2VjcmV0\r\n"));
}

#[test]
fn gateway_initial_packets_include_http_auth_and_rpc_seed_pdus() {
    let g = GatewayOpt {
        host: "rdg.example.com".into(),
        port: 443,
        username: "alice".into(),
        password: Some("secret".into()),
        auth: "basic".into(),
        use_session_creds: false,
        certificate_fingerprint: None,
    };
    let packets = build_gateway_initial_packets(&g).unwrap();
    assert_eq!(packets.http_host, "rdg.example.com");
    assert_eq!(packets.rdg_path, "/rpc/rpcproxy.dll?rdg.example.com:3388");
    let in_headers = std::str::from_utf8(&packets.rpc_in_headers).unwrap();
    assert!(in_headers.starts_with("RPC_IN_DATA /rpc/rpcproxy.dll?rdg.example.com:3388 HTTP/1.1"));
    assert!(in_headers.contains("Authorization: Basic YWxpY2U6c2VjcmV0\r\n"));
    assert!(
        in_headers
            .contains("Pragma: ResourceTypeUuid=44e265dd-7daf-42cd-8560-3cdb6e7a2729, SessionId=")
    );
    assert!(in_headers.contains("Content-Length: 1073741824\r\n"));
    let out_headers = std::str::from_utf8(&packets.rpc_out_headers).unwrap();
    assert!(out_headers.contains("Content-Length: 76\r\n"));
    assert_eq!(
        rpch::RtsPduHeader::parse(&packets.conn_a1_pdu)
            .unwrap()
            .number_of_commands,
        4
    );
    assert_eq!(
        rpch::RtsPduHeader::parse(&packets.conn_b1_pdu)
            .unwrap()
            .number_of_commands,
        6
    );
    assert_eq!(
        RpcPduHeader::parse(&packets.bind_pdu).unwrap().pdu_type,
        RPC_PT_BIND
    );
    assert_eq!(
        u16::from_le_bytes([packets.create_tunnel_pdu[22], packets.create_tunnel_pdu[23]]),
        ndr::TSPROXY_OPNUM_CREATE_TUNNEL
    );
}

#[test]
fn gateway_initial_packets_support_ntlm_type1_seed() {
    let g = GatewayOpt {
        host: "rdg.example.com".into(),
        port: 8443,
        username: "CORP\\alice".into(),
        password: Some("secret".into()),
        auth: "ntlm".into(),
        use_session_creds: false,
        certificate_fingerprint: None,
    };
    let packets = build_gateway_initial_packets(&g).unwrap();
    assert_eq!(packets.http_host, "rdg.example.com:8443");
    let in_headers = std::str::from_utf8(&packets.rpc_in_headers).unwrap();
    assert!(in_headers.contains("Host: rdg.example.com:8443\r\n"));
    assert!(in_headers.contains("Authorization: NTLM "));
    assert_eq!(split_ntlm_domain_user("CORP\\alice"), ("CORP", "alice"));
    assert_eq!(split_ntlm_domain_user("alice"), ("", "alice"));
}

#[test]
fn ntlm_filetime_uses_windows_epoch() {
    assert_eq!(
        ntlm_filetime_from_unix_duration(Duration::ZERO),
        116_444_736_000_000_000
    );
    assert_eq!(
        ntlm_filetime_from_unix_duration(Duration::from_millis(1)),
        116_444_736_000_010_000
    );
}

#[test]
fn ntlm_authenticate_header_decodes_as_type3() {
    let g = GatewayOpt {
        host: "rdg.example.com".into(),
        port: 443,
        username: "CORP\\alice".into(),
        password: Some("secret".into()),
        auth: "ntlm".into(),
        use_session_creds: false,
        certificate_fingerprint: None,
    };
    let challenge = ntlm::ChallengeMessage {
        target_name: b"CORP".to_vec(),
        flags: ntlm::NEG_UNICODE
            | ntlm::NEG_NTLM
            | ntlm::NEG_EXTENDED_SESSION_SECURITY
            | ntlm::NEG_TARGET_INFO
            | ntlm::NEG_KEY_EXCHANGE,
        server_challenge: [1, 2, 3, 4, 5, 6, 7, 8],
        target_info: vec![0, 0, 0, 0],
    };
    let type1 = build_ntlm_negotiate_message(&g.username);
    let type2 = b"synthetic-type2-for-mic";
    let header = build_ntlm_authenticate_authorization(
        &g,
        &type1,
        type2,
        &challenge,
        [9, 9, 9, 9, 9, 9, 9, 9],
        116_444_736_000_000_000,
    )
    .unwrap();
    let token = header.strip_prefix("NTLM ").unwrap();
    let bytes = B64.decode(token).unwrap();
    assert_eq!(&bytes[0..8], ntlm::NTLM_SIGNATURE);
    assert_eq!(
        u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
        ntlm::TYPE_AUTHENTICATE
    );
    let flags = u32::from_le_bytes([bytes[60], bytes[61], bytes[62], bytes[63]]);
    assert_eq!(flags & ntlm::NEG_KEY_EXCHANGE, 0);
    assert_ne!(
        &bytes[ntlm::AUTHENTICATE_MIC_OFFSET..ntlm::AUTHENTICATE_FIXED_HEADER_LEN],
        &[0u8; ntlm::AUTHENTICATE_MIC_LEN]
    );
}

#[test]
fn parses_http_response_head_and_authenticate_headers() {
    let raw = b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nWWW-Authenticate: NTLM TlRMTVNTUAAC\r\nContent-Length: 0\r\n\r\nignored";
    let (head, used) = parse_http_response_head(raw).unwrap();
    assert_eq!(used, raw.len() - b"ignored".len());
    assert_eq!(head.status_code, 401);
    assert_eq!(head.reason, "Unauthorized");
    assert_eq!(head.header("content-length"), Some("0"));
    assert_eq!(
        www_authenticate_token(&head, "Negotiate"),
        Some(String::new())
    );
    assert_eq!(
        www_authenticate_token(&head, "NTLM"),
        Some("TlRMTVNTUAAC".into())
    );
}

#[test]
fn builds_receive_pipe_message_from_context() {
    let ctx = [0x11u8; RDG_CONTEXT_HANDLE_SIZE];
    let msg = build_receive_pipe_message(&ctx);
    assert_eq!(msg, ctx);
    let req = build_setup_receive_pipe_request(10, &ctx);
    let h = RpcPduHeader::parse(&req).unwrap();
    assert_eq!(h.pdu_type, RPC_PT_REQUEST);
    assert_eq!(h.call_id, 10);
    assert_eq!(
        u16::from_le_bytes([req[22], req[23]]),
        TSPROXY_OPNUM_SETUP_RECEIVE_PIPE
    );
}

#[test]
fn builds_generic_send_data_message() {
    let mut ctx = [0u8; RDG_CONTEXT_HANDLE_SIZE];
    ctx[4] = 0x36;
    let msg = build_send_data_message(&ctx, &[&[0x04, 0x00, 0x00, 0x03]]).unwrap();
    assert_eq!(&msg[..RDG_CONTEXT_HANDLE_SIZE], &ctx);
    assert_eq!(
        u32::from_be_bytes([
            msg[RDG_CONTEXT_HANDLE_SIZE],
            msg[RDG_CONTEXT_HANDLE_SIZE + 1],
            msg[RDG_CONTEXT_HANDLE_SIZE + 2],
            msg[RDG_CONTEXT_HANDLE_SIZE + 3],
        ]),
        8
    );
    assert_eq!(
        u32::from_be_bytes([
            msg[RDG_CONTEXT_HANDLE_SIZE + 4],
            msg[RDG_CONTEXT_HANDLE_SIZE + 5],
            msg[RDG_CONTEXT_HANDLE_SIZE + 6],
            msg[RDG_CONTEXT_HANDLE_SIZE + 7],
        ]),
        1
    );
    assert_eq!(
        u32::from_be_bytes([
            msg[RDG_CONTEXT_HANDLE_SIZE + 8],
            msg[RDG_CONTEXT_HANDLE_SIZE + 9],
            msg[RDG_CONTEXT_HANDLE_SIZE + 10],
            msg[RDG_CONTEXT_HANDLE_SIZE + 11],
        ]),
        4
    );
    assert_eq!(
        &msg[RDG_CONTEXT_HANDLE_SIZE + 12..],
        &[0x04, 0x00, 0x00, 0x03]
    );
}

#[test]
fn send_data_message_enforces_rpc_message_limit() {
    let ctx = [0u8; RDG_CONTEXT_HANDLE_SIZE];
    let too_large = vec![0u8; 32767 - RDG_CONTEXT_HANDLE_SIZE - 8 - 4 + 1];
    let err = build_send_data_message(&ctx, &[&too_large]).unwrap_err();
    assert!(err.contains("maximum is 32767"));
}

#[test]
fn builds_send_to_server_request() {
    let ctx = [0x22u8; RDG_CONTEXT_HANDLE_SIZE];
    let req = build_send_to_server_request(11, &ctx, b"rdp").unwrap();
    let h = RpcPduHeader::parse(&req).unwrap();
    assert_eq!(h.pdu_type, RPC_PT_REQUEST);
    assert_eq!(h.call_id, 11);
    assert_eq!(
        u16::from_le_bytes([req[22], req[23]]),
        TSPROXY_OPNUM_SEND_TO_SERVER
    );
    assert!(req.ends_with(b"rdp"));
}

#[tokio::test]
async fn close_gateway_contexts_writes_channel_then_tunnel_close() {
    let (mut client, mut server) = tokio::io::duplex(1024);
    let channel_context = [0x22u8; RDG_CONTEXT_HANDLE_SIZE];
    let tunnel_context = [0x33u8; RDG_CONTEXT_HANDLE_SIZE];
    let next_call_id = AtomicU32::new(200);

    close_gateway_contexts(
        &mut client,
        &channel_context,
        &tunnel_context,
        &next_call_id,
    )
    .await;

    let mut written = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut server, &mut written)
        .await
        .unwrap();
    let first = RpcPduHeader::parse(&written).unwrap();
    assert_eq!(first.call_id, 200);
    assert_eq!(
        u16::from_le_bytes([written[22], written[23]]),
        ndr::TSPROXY_OPNUM_CLOSE_CHANNEL
    );

    let second_offset = first.frag_length as usize;
    let second = RpcPduHeader::parse(&written[second_offset..]).unwrap();
    assert_eq!(second.call_id, 201);
    assert_eq!(
        u16::from_le_bytes([written[second_offset + 22], written[second_offset + 23]]),
        ndr::TSPROXY_OPNUM_CLOSE_TUNNEL
    );
    assert_eq!(next_call_id.load(Ordering::Relaxed), 202);
}

#[test]
fn decode_receive_pipe_response_distinguishes_data_and_final_return() {
    let mut data_resp = RpcPduHeader {
        pdu_type: RPC_PT_RESPONSE,
        pfc_flags: PFC_FIRST_FRAG,
        frag_length: 16 + 8 + 3,
        auth_length: 0,
        call_id: 12,
    }
    .encode()
    .to_vec();
    data_resp.extend_from_slice(&3u32.to_le_bytes());
    data_resp.extend_from_slice(&0u16.to_le_bytes());
    data_resp.extend_from_slice(&[0, 0]);
    data_resp.extend_from_slice(b"abc");
    let parsed = parse_response_pdu(&data_resp).unwrap();
    assert_eq!(
        decode_receive_pipe_response(&parsed).unwrap(),
        ReceivePipePayload::Data(b"abc".to_vec())
    );

    let mut final_resp = RpcPduHeader {
        pdu_type: RPC_PT_RESPONSE,
        pfc_flags: PFC_FIRST_FRAG | PFC_LAST_FRAG,
        frag_length: 16 + 8 + 4,
        auth_length: 0,
        call_id: 12,
    }
    .encode()
    .to_vec();
    final_resp.extend_from_slice(&4u32.to_le_bytes());
    final_resp.extend_from_slice(&0u16.to_le_bytes());
    final_resp.extend_from_slice(&[0, 0]);
    final_resp.extend_from_slice(&0x000004CAu32.to_le_bytes());
    let parsed = parse_response_pdu(&final_resp).unwrap();
    assert_eq!(
        decode_receive_pipe_response(&parsed).unwrap(),
        ReceivePipePayload::FinalReturn(0x000004CA)
    );
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
        certificate_fingerprint: None,
    };
    assert!(open_tunnel(&g, "host", 3389).await.is_err());
}

#[tokio::test]
async fn open_tunnel_rejects_unsupported_auth() {
    let g = GatewayOpt {
        host: "rdg".into(),
        port: 443,
        username: "u".into(),
        password: Some("p".into()),
        auth: "kerberos".into(),
        use_session_creds: true,
        certificate_fingerprint: None,
    };
    let err = match open_tunnel(&g, "host", 3389).await {
        Ok(_) => panic!("should reject"),
        Err(e) => e,
    };
    assert!(err.contains("auth"));
}

#[tokio::test]
async fn open_tunnel_rejects_missing_credentials() {
    let g = GatewayOpt {
        host: "rdg".into(),
        port: 443,
        username: "".into(),
        password: Some("p".into()),
        auth: "ntlm".into(),
        use_session_creds: true,
        certificate_fingerprint: None,
    };
    let err = match open_tunnel(&g, "host", 3389).await {
        Ok(_) => panic!("should reject missing username"),
        Err(e) => e,
    };
    assert!(err.contains("username"));

    let g = GatewayOpt {
        username: "u".into(),
        password: None,
        ..g
    };
    let err = match open_tunnel(&g, "host", 3389).await {
        Ok(_) => panic!("should reject missing password"),
        Err(e) => e,
    };
    assert!(err.contains("password"));
}

#[tokio::test]
#[ignore = "requires TAOMNI_RDP_GATEWAY_LIVE_* env vars and a reachable Windows RD Gateway"]
async fn live_rdg_tunnel_opens() {
    let Some(host) = env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_HOST") else {
        eprintln!("skipping live RDG test: TAOMNI_RDP_GATEWAY_LIVE_HOST is not set");
        return;
    };
    let Some(username) = env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_USER") else {
        eprintln!("skipping live RDG test: TAOMNI_RDP_GATEWAY_LIVE_USER is not set");
        return;
    };
    let Some(password) = env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_PASS") else {
        eprintln!("skipping live RDG test: TAOMNI_RDP_GATEWAY_LIVE_PASS is not set");
        return;
    };
    let Some(target_host) = env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_TARGET_HOST") else {
        eprintln!("skipping live RDG test: TAOMNI_RDP_GATEWAY_LIVE_TARGET_HOST is not set");
        return;
    };
    let gateway = GatewayOpt {
        host,
        port: env_u16("TAOMNI_RDP_GATEWAY_LIVE_PORT", 443),
        username,
        password: Some(password),
        auth: env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_AUTH").unwrap_or_else(|| "ntlm".into()),
        use_session_creds: false,
        certificate_fingerprint: env_nonempty("TAOMNI_RDP_GATEWAY_LIVE_CERTIFICATE_FINGERPRINT"),
    };
    let target_port = env_u16("TAOMNI_RDP_GATEWAY_LIVE_TARGET_PORT", 3389);

    let _stream = open_tunnel(&gateway, &target_host, target_port)
        .await
        .unwrap();
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn env_u16(name: &str, default: u16) -> u16 {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => value.parse().unwrap(),
        _ => default,
    }
}
