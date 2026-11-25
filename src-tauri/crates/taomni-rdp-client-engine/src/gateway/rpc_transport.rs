use super::rpc::RPC_PT_FAULT;
use super::rpc::RpcPduHeader;
use super::rpc::parse_fault_pdu;
use super::rpc::parse_response_pdu;
use super::rpch;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt as _;
pub(super) async fn read_rpc_pdu<S>(stream: &mut S) -> Result<Vec<u8>, String>
where
    S: AsyncRead + Unpin,
{
    let mut header = [0u8; RpcPduHeader::SIZE];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| format!("rdg rpc: read PDU header: {}", e))?;
    let parsed = RpcPduHeader::parse(&header)?;
    let frag_length = parsed.frag_length as usize;
    if frag_length < RpcPduHeader::SIZE {
        return Err(format!("rdg rpc: invalid frag_length {}", frag_length));
    }
    let mut pdu = Vec::with_capacity(frag_length);
    pdu.extend_from_slice(&header);
    pdu.resize(frag_length, 0);
    stream
        .read_exact(&mut pdu[RpcPduHeader::SIZE..])
        .await
        .map_err(|e| format!("rdg rpc: read PDU body: {}", e))?;
    Ok(pdu)
}

pub(super) async fn read_non_rts_pdu<S>(stream: &mut S) -> Result<Vec<u8>, String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let pdu = read_rpc_pdu(stream).await?;
        let header = RpcPduHeader::parse(&pdu)?;
        if header.pdu_type != rpch::RPC_PT_RTS {
            return Ok(pdu);
        }
    }
}

pub(super) async fn read_response_for_call<S>(
    stream: &mut S,
    call_id: u32,
    label: &str,
) -> Result<Vec<u8>, String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let pdu = read_non_rts_pdu(stream).await?;
        let header = RpcPduHeader::parse(&pdu)?;
        if header.pdu_type == RPC_PT_FAULT {
            let fault = parse_fault_pdu(&pdu)?;
            return Err(format!(
                "rdg rpc: {} fault status=0x{:08x}",
                label, fault.status
            ));
        }
        let resp = parse_response_pdu(&pdu)?;
        if resp.header.call_id == call_id {
            return Ok(resp.stub.to_vec());
        }
    }
}

pub(super) fn ensure_rpc_return_zero(return_value: i32, label: &str) -> Result<(), String> {
    if return_value == 0 {
        Ok(())
    } else {
        Err(format!(
            "rdg rpc: {} returned 0x{:08x}",
            label, return_value as u32
        ))
    }
}
