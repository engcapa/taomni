use super::ndr;
use super::rpc::PFC_LAST_FRAG;
use super::rpc::ResponsePdu;
use super::rpc::build_request_pdu;
// ── RDG data-phase packet helpers (MS-TSGU §2.2.9.3 / §2.2.9.4) ───────

pub const RDG_CONTEXT_HANDLE_SIZE: usize = 20;
pub const TSPROXY_OPNUM_SETUP_RECEIVE_PIPE: u16 = ndr::TSPROXY_OPNUM_SETUP_RECEIVE_PIPE;
pub const TSPROXY_OPNUM_SEND_TO_SERVER: u16 = ndr::TSPROXY_OPNUM_SEND_TO_SERVER;

pub fn build_receive_pipe_message(channel_context: &[u8; RDG_CONTEXT_HANDLE_SIZE]) -> Vec<u8> {
    channel_context.to_vec()
}

pub fn build_send_data_message(
    channel_context: &[u8; RDG_CONTEXT_HANDLE_SIZE],
    buffers: &[&[u8]],
) -> Result<Vec<u8>, String> {
    if buffers.is_empty() || buffers.len() > 3 {
        return Err("rdg send: expected 1..=3 data buffers".into());
    }
    if buffers[0].is_empty() {
        return Err("rdg send: first data buffer must not be empty".into());
    }
    let mut total_data_bytes = 4usize * buffers.len();
    for b in buffers {
        if b.len() > u32::MAX as usize {
            return Err("rdg send: buffer is too large".into());
        }
        total_data_bytes = total_data_bytes
            .checked_add(b.len())
            .ok_or_else(|| "rdg send: data length overflow".to_string())?;
    }
    let message_len = RDG_CONTEXT_HANDLE_SIZE + 8 + total_data_bytes;
    if message_len > 32767 {
        return Err(format!(
            "rdg send: RPC message is {} bytes; maximum is 32767",
            message_len
        ));
    }

    let mut out = Vec::with_capacity(message_len);
    out.extend_from_slice(channel_context);
    out.extend_from_slice(&(total_data_bytes as u32).to_be_bytes());
    out.extend_from_slice(&(buffers.len() as u32).to_be_bytes());
    for b in buffers {
        out.extend_from_slice(&(b.len() as u32).to_be_bytes());
    }
    for b in buffers {
        out.extend_from_slice(b);
    }
    Ok(out)
}

pub fn build_setup_receive_pipe_request(
    call_id: u32,
    channel_context: &[u8; RDG_CONTEXT_HANDLE_SIZE],
) -> Vec<u8> {
    build_request_pdu(
        call_id,
        TSPROXY_OPNUM_SETUP_RECEIVE_PIPE,
        &build_receive_pipe_message(channel_context),
    )
}

pub fn build_send_to_server_request(
    call_id: u32,
    channel_context: &[u8; RDG_CONTEXT_HANDLE_SIZE],
    data: &[u8],
) -> Result<Vec<u8>, String> {
    let stub = build_send_data_message(channel_context, &[data])?;
    Ok(build_request_pdu(
        call_id,
        TSPROXY_OPNUM_SEND_TO_SERVER,
        &stub,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceivePipePayload {
    Data(Vec<u8>),
    FinalReturn(u32),
}

pub fn decode_receive_pipe_response(resp: &ResponsePdu<'_>) -> Result<ReceivePipePayload, String> {
    if resp.header.pfc_flags & PFC_LAST_FRAG != 0 {
        if resp.stub.len() != 4 {
            return Err(format!(
                "rdg receive: final response should contain 4-byte return code, got {} bytes",
                resp.stub.len()
            ));
        }
        return Ok(ReceivePipePayload::FinalReturn(u32::from_le_bytes([
            resp.stub[0],
            resp.stub[1],
            resp.stub[2],
            resp.stub[3],
        ])));
    }
    Ok(ReceivePipePayload::Data(resp.stub.to_vec()))
}
