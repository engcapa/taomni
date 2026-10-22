use super::model::OrigMapping;
use super::model::REQ_ID;
use super::original_destination::lookup_orig;
use super::original_destination::lookup_orig_body;
use super::original_destination::parse_orig_mapping;
use super::registry::HelperSession;
use super::requests::expect_ok;
use serde_json::json;
use std::io::BufReader;
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

/* ------------------------- async control channel ------------------------- */

/// Queue depth before callers start waiting. Requests are tiny and serviced in
/// microseconds; this only has to absorb a burst of simultaneous connections.
pub(super) const CLIENT_QUEUE: usize = 512;
pub(super) const CLIENT_CALL_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const CLIENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// After a failed connect, fail fast for a moment rather than having every
/// queued request pay the connect timeout in turn.
pub(super) const CLIENT_RECONNECT_DEBOUNCE: Duration = Duration::from_millis(200);

pub(super) struct Job {
    pub(super) body: serde_json::Value,
    pub(super) reply: tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>,
}

/// Long-lived async control channel to the elevated helper.
///
/// The relay asks the helper to resolve the original destination once per
/// captured connection. Doing that with the synchronous [`send_json`] path
/// opened a fresh TCP connection, wrote, and blocked on the read — on a tokio
/// worker thread, while holding the `HelperRegistry` mutex and a `RelayContext`
/// read lock. Every captured connection therefore serialised behind every
/// other, a worker was parked for the duration, and each lookup burned an
/// ephemeral port of its own — accelerating the very port exhaustion that made
/// long runs fail.
///
/// One task owns one connection and services requests in order; callers await a
/// oneshot. A broken connection is dropped and re-established on the next
/// request.
pub struct HelperClient {
    pub(super) tx: tokio::sync::mpsc::Sender<Job>,
}

impl HelperClient {
    /// Start the control task. It ends when the returned client is dropped.
    pub fn spawn(sess: HelperSession) -> Self {
        let (tx, rx) = tokio::sync::mpsc::channel(CLIENT_QUEUE);
        tokio::spawn(client_loop(sess, rx));
        Self { tx }
    }

    pub async fn call(&self, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.tx
            .send(Job { body, reply })
            .await
            .map_err(|_| "helper control channel closed".to_string())?;
        wait.await
            .map_err(|_| "helper control channel dropped the request".to_string())?
    }

    pub async fn lookup_orig(&self, src_ip: &str, src_port: u16) -> Result<OrigMapping, String> {
        let result = expect_ok(self.call(lookup_orig_body(src_ip, src_port)).await?)?;
        Ok(parse_orig_mapping(&result))
    }
}

pub(super) async fn client_loop(sess: HelperSession, mut rx: tokio::sync::mpsc::Receiver<Job>) {
    use tokio::io::BufReader;
    use tokio::net::TcpStream;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], sess.port));
    let mut conn: Option<BufReader<TcpStream>> = None;
    let mut last_connect_failure: Option<Instant> = None;

    while let Some(job) = rx.recv().await {
        if conn.is_none() {
            if last_connect_failure.is_some_and(|at| at.elapsed() < CLIENT_RECONNECT_DEBOUNCE) {
                let _ = job
                    .reply
                    .send(Err("helper control connection unavailable".into()));
                continue;
            }
            match tokio::time::timeout(CLIENT_CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
                Ok(Ok(s)) => {
                    let _ = s.set_nodelay(true);
                    conn = Some(BufReader::new(s));
                    last_connect_failure = None;
                }
                Ok(Err(e)) => {
                    last_connect_failure = Some(Instant::now());
                    let _ = job.reply.send(Err(format!("connect helper: {e}")));
                    continue;
                }
                Err(_) => {
                    last_connect_failure = Some(Instant::now());
                    let _ = job.reply.send(Err("connect helper: timed out".into()));
                    continue;
                }
            }
        }

        let stream = conn.as_mut().expect("connection established above");
        let res = client_call(stream, &sess, job.body).await;
        if res.is_err() {
            // Any failure may have left a partial response in the buffer, so
            // the connection is discarded rather than resynchronised.
            conn = None;
        }
        let _ = job.reply.send(res);
    }
}

pub(super) async fn client_call(
    stream: &mut tokio::io::BufReader<tokio::net::TcpStream>,
    sess: &HelperSession,
    mut body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    let id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("id".into(), json!(id));
        obj.insert("token".into(), json!(&sess.token));
    }
    let line = format!("{body}\n");

    tokio::time::timeout(CLIENT_CALL_TIMEOUT, async {
        stream
            .get_mut()
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write helper: {e}"))?;
        stream
            .get_mut()
            .flush()
            .await
            .map_err(|e| format!("flush helper: {e}"))?;
        let mut resp = String::new();
        let n = stream
            .read_line(&mut resp)
            .await
            .map_err(|e| format!("read helper: {e}"))?;
        if n == 0 {
            return Err("helper closed the control connection".to_string());
        }
        serde_json::from_str(resp.trim()).map_err(|e| format!("helper json: {e}"))
    })
    .await
    .map_err(|_| {
        format!(
            "helper call timed out after {}s",
            CLIENT_CALL_TIMEOUT.as_secs()
        )
    })?
}
