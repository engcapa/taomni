use super::model::REQ_ID;
use super::registry::HelperSession;
use serde_json::json;
use std::io::BufRead as _;
use std::io::BufReader;
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::Ordering;
use std::time::Duration;

pub(super) fn send_cmd(
    sess: &HelperSession,
    cmd: &str,
    filter: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut body = json!({
        "cmd": cmd,
    });
    if let Some(f) = filter {
        body["filter"] = json!(f);
    }
    send_json(sess, body)
}

/// Low-level helper RPC with a free-form JSON body (`cmd` required).
pub fn send_json(
    sess: &HelperSession,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    send_json_timeout(sess, body, Duration::from_secs(15))
}

/// Same as [`send_json`] with an explicit read timeout (used by capture_stop).
pub fn send_json_timeout(
    sess: &HelperSession,
    mut body: serde_json::Value,
    read_timeout: Duration,
) -> Result<serde_json::Value, String> {
    let id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("id".into(), json!(id));
        obj.insert("token".into(), json!(&sess.token));
    }
    let mut stream = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], sess.port)),
        Duration::from_secs(2),
    )
    .map_err(|e| format!("connect helper: {e}"))?;
    stream.set_read_timeout(Some(read_timeout)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();

    let line = format!("{}\n", body);
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("write helper: {e}"))?;
    stream.flush().ok();

    let mut reader = BufReader::new(stream);
    let mut resp_line = String::new();
    reader
        .read_line(&mut resp_line)
        .map_err(|e| format!("read helper: {e}"))?;
    serde_json::from_str(resp_line.trim()).map_err(|e| format!("helper json: {e}"))
}

pub(super) fn expect_ok(resp: serde_json::Value) -> Result<serde_json::Value, String> {
    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(resp.get("result").cloned().unwrap_or(json!({})))
    } else {
        Err(resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("helper error")
            .to_string())
    }
}
