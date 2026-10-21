use super::model::OrigMapping;
use super::registry::HelperSession;
use super::requests::expect_ok;
use super::requests::send_json;
use serde_json::json;

pub fn lookup_orig(sess: &HelperSession, src_port: u16) -> Result<OrigMapping, String> {
    lookup_orig_key(sess, "", src_port)
}

pub fn lookup_orig_key(
    sess: &HelperSession,
    src_ip: &str,
    src_port: u16,
) -> Result<OrigMapping, String> {
    let result = expect_ok(send_json(sess, lookup_orig_body(src_ip, src_port))?)?;
    Ok(parse_orig_mapping(&result))
}

pub(super) fn lookup_orig_body(src_ip: &str, src_port: u16) -> serde_json::Value {
    let mut body = json!({
        "cmd": "lookup_orig",
        "srcPort": src_port,
    });
    if !src_ip.is_empty() {
        body["srcIp"] = json!(src_ip);
    }
    body
}

pub(super) fn parse_orig_mapping(result: &serde_json::Value) -> OrigMapping {
    OrigMapping {
        dst_ip: result
            .get("dstIp")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0.0")
            .to_string(),
        dst_port: result.get("dstPort").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
        pid: result.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        path: result
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }
}
