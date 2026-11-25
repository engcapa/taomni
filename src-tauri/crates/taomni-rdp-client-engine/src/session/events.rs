use super::*;

pub(super) fn parse_connected_event(text: &str) -> Result<Option<RdpConnectionTestResult>, String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(None);
    };
    match value.get("type").and_then(|v| v.as_str()) {
        Some("connected") => {
            let width = value
                .get("width")
                .and_then(|v| v.as_u64())
                .and_then(|v| u16::try_from(v).ok())
                .ok_or_else(|| "RDP connected event did not include a valid width".to_string())?;
            let height = value
                .get("height")
                .and_then(|v| v.as_u64())
                .and_then(|v| u16::try_from(v).ok())
                .ok_or_else(|| "RDP connected event did not include a valid height".to_string())?;
            let protocol = value
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_owned();
            let server_name = value
                .get("server_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            Ok(Some(RdpConnectionTestResult {
                width,
                height,
                protocol,
                server_name,
            }))
        }
        Some("error") => {
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("RDP connection test failed");
            Err(message.to_owned())
        }
        Some("disconnected") => {
            let reason = value
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("RDP session disconnected before it reached connected state");
            Err(reason.to_owned())
        }
        _ => Ok(None),
    }
}

pub(super) fn send_connected_event(
    out_tx: &SessionOutputSender,
    width: u16,
    height: u16,
    protocol: &str,
    server_name: &str,
) {
    send_text(
        out_tx,
        json!({
            "type": "connected",
            "width": width,
            "height": height,
            "protocol": protocol,
            "server_name": server_name,
        })
        .to_string(),
    );
}

pub(super) fn send_status(out_tx: &SessionOutputSender, stage: &str, detail: &str) {
    send_text(
        out_tx,
        json!({
            "type": "status",
            "stage": stage,
            "detail": detail,
        })
        .to_string(),
    );
}

pub(super) fn send_error(out_tx: &SessionOutputSender, code: &str, message: &str) {
    tracing::warn!(code, error = %message, "RDP session failed");
    let retryable = is_retryable_rdp_error(message);
    send_text(
        out_tx,
        json!({
            "type": "error",
            "code": code,
            "message": message,
            "retryable": retryable,
        })
        .to_string(),
    );
}

// IronRDP's Display omits its source ("custom error"). Preserve the chain and
// the transport error kind so a closed certificate-review connection can use
// the existing bounded reconnect path without retrying protocol/auth errors.
pub(super) fn negotiation_error(error: connector::ConnectorError) -> String {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    let mut transient = false;
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            transient |= matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::TimedOut
            );
        }
        source = cause.source();
    }
    format!(
        "rdp negotiation failed{}: {}",
        if transient {
            " (transient transport)"
        } else {
            ""
        },
        error.report()
    )
}

pub(super) fn is_retryable_rdp_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("timed out")
        || lower.starts_with("rdp read frame:")
        || lower.starts_with("rdp write frame:")
        || lower.contains("connection reset")
        || lower.contains("broken pipe")
        || lower.starts_with("rdp negotiation failed (transient transport):")
}

pub(super) fn send_text(out_tx: &SessionOutputSender, text: String) {
    let _ = out_tx.send(SessionOutput::Text(text));
}

/// `{"type":"network", ...}` for a server Network Characteristics Result
/// (MS-RDPBCGR 2.2.14.1.5); other auto-detect requests carry no result.
pub(super) fn network_characteristics_event(
    request: &ironrdp::pdu::rdp::autodetect::AutoDetectRequest,
) -> Option<String> {
    use ironrdp::pdu::rdp::autodetect::AutoDetectRequest;
    let AutoDetectRequest::NetworkCharacteristicsResult {
        base_rtt_ms,
        bandwidth_kbps,
        average_rtt_ms,
        ..
    } = request
    else {
        return None;
    };
    Some(
        json!({
            "type": "network",
            "baseRttMs": base_rtt_ms,
            "averageRttMs": average_rtt_ms,
            "bandwidthKbps": bandwidth_kbps,
        })
        .to_string(),
    )
}
