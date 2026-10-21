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

pub const TSPROXY_RPC_INTERFACE_UUID: [u8; 16] = [
    0xdd, 0x65, 0xe2, 0x44, 0xaf, 0x7d, 0xcd, 0x42, 0x85, 0x60, 0x3c, 0xdb, 0x6e, 0x7a, 0x27, 0x29,
];
pub const TSPROXY_RPC_INTERFACE_VERSION: u32 = 0x0003_0001;
pub const NDR_TRANSFER_SYNTAX_UUID: [u8; 16] = [
    0x04, 0x5d, 0x88, 0x8a, 0xeb, 0x1c, 0xc9, 0x11, 0x9f, 0xe8, 0x08, 0x00, 0x2b, 0x10, 0x48, 0x60,
];
pub const NDR_TRANSFER_SYNTAX_VERSION: u32 = 2;

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

pub const DEFAULT_RPC_FRAG_SIZE: u16 = 4280;

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

pub fn build_tsproxy_bind_pdu(call_id: u32) -> Vec<u8> {
    build_bind_pdu(
        BindParams {
            max_xmit_frag: DEFAULT_RPC_FRAG_SIZE,
            max_recv_frag: DEFAULT_RPC_FRAG_SIZE,
            assoc_group_id: 0,
            call_id,
        },
        TSPROXY_RPC_INTERFACE_UUID,
        TSPROXY_RPC_INTERFACE_VERSION,
        NDR_TRANSFER_SYNTAX_UUID,
        NDR_TRANSFER_SYNTAX_VERSION,
        &[],
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindAckResult {
    pub result: u16,
    pub reason: u16,
    pub transfer_syntax_uuid: [u8; 16],
    pub transfer_syntax_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindAckPdu {
    pub header: RpcPduHeader,
    pub max_xmit_frag: u16,
    pub max_recv_frag: u16,
    pub assoc_group_id: u32,
    pub secondary_address: String,
    pub results: Vec<BindAckResult>,
}

pub fn parse_bind_ack_pdu(buf: &[u8]) -> Result<BindAckPdu, String> {
    let header = RpcPduHeader::parse(buf)?;
    if header.pdu_type != RPC_PT_BIND_ACK {
        return Err(format!(
            "RPC: expected BIND_ACK, got pdu_type=0x{:02x}",
            header.pdu_type
        ));
    }
    let frag_length = header.frag_length as usize;
    if buf.len() < frag_length {
        return Err(format!(
            "RPC: bind_ack truncated, expected {} bytes, got {}",
            frag_length,
            buf.len()
        ));
    }
    let body = &buf[RpcPduHeader::SIZE..frag_length];
    if body.len() < 10 {
        return Err("RPC: bind_ack body too small".into());
    }
    let max_xmit_frag = u16::from_le_bytes([body[0], body[1]]);
    let max_recv_frag = u16::from_le_bytes([body[2], body[3]]);
    let assoc_group_id = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
    let sec_len = u16::from_le_bytes([body[8], body[9]]) as usize;
    if body.len() < 10 + sec_len {
        return Err("RPC: bind_ack secondary address truncated".into());
    }
    let sec_addr_bytes = &body[10..10 + sec_len];
    let secondary_address = String::from_utf8_lossy(sec_addr_bytes)
        .trim_end_matches('\0')
        .to_string();
    let mut pos = 10 + sec_len;
    pos += (4 - ((RpcPduHeader::SIZE + pos) % 4)) % 4;
    if body.len() < pos + 4 {
        return Err("RPC: bind_ack result list truncated".into());
    }
    let n_results = body[pos] as usize;
    pos += 4; // n_results, reserved, reserved2
    let mut results = Vec::with_capacity(n_results);
    for _ in 0..n_results {
        if body.len() < pos + 24 {
            return Err("RPC: bind_ack context result truncated".into());
        }
        let result = u16::from_le_bytes([body[pos], body[pos + 1]]);
        let reason = u16::from_le_bytes([body[pos + 2], body[pos + 3]]);
        let mut transfer_syntax_uuid = [0u8; 16];
        transfer_syntax_uuid.copy_from_slice(&body[pos + 4..pos + 20]);
        let transfer_syntax_version = u32::from_le_bytes([
            body[pos + 20],
            body[pos + 21],
            body[pos + 22],
            body[pos + 23],
        ]);
        results.push(BindAckResult {
            result,
            reason,
            transfer_syntax_uuid,
            transfer_syntax_version,
        });
        pos += 24;
    }
    Ok(BindAckPdu {
        header,
        max_xmit_frag,
        max_recv_frag,
        assoc_group_id,
        secondary_address,
        results,
    })
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaultPdu {
    pub header: RpcPduHeader,
    pub alloc_hint: u32,
    pub p_cont_id: u16,
    pub cancel_count: u8,
    pub status: u32,
}

pub fn parse_fault_pdu(buf: &[u8]) -> Result<FaultPdu, String> {
    let header = RpcPduHeader::parse(buf)?;
    if header.pdu_type != RPC_PT_FAULT {
        return Err(format!(
            "RPC: expected FAULT, got pdu_type=0x{:02x}",
            header.pdu_type
        ));
    }
    let frag_length = header.frag_length as usize;
    if buf.len() < frag_length {
        return Err(format!(
            "RPC: fault truncated, expected {} bytes, got {}",
            frag_length,
            buf.len()
        ));
    }
    let body = &buf[RpcPduHeader::SIZE..frag_length];
    if body.len() < 12 {
        return Err("RPC: fault body too small".into());
    }
    Ok(FaultPdu {
        header,
        alloc_hint: u32::from_le_bytes([body[0], body[1], body[2], body[3]]),
        p_cont_id: u16::from_le_bytes([body[4], body[5]]),
        cancel_count: body[6],
        status: u32::from_le_bytes([body[8], body[9], body[10], body[11]]),
    })
}
