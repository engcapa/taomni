use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use taomni_download_gates::download::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub const BODY: &[u8] = b"verified module package bytes";

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn request(directory: &std::path::Path, url: String) -> DownloadRequest {
    DownloadRequest {
        id: "package".into(),
        url,
        partial_path: directory.join("module.part"),
        completed_path: directory.join("module.pkg"),
        expected_total: Some(BODY.len() as u64),
        expected_sha256: Some(sha256(BODY)),
        proxy: ProxyRoute::NoProxy,
    }
}

pub struct Reply {
    pub status: u16,
    pub range: Option<String>,
    pub encoding: Option<String>,
    pub length: Option<u64>,
    pub body: Vec<u8>,
    pub stall_after: Option<usize>,
}

impl Reply {
    pub fn full(body: &[u8]) -> Self {
        Self {
            status: 200,
            range: None,
            encoding: None,
            length: Some(body.len() as u64),
            body: body.to_vec(),
            stall_after: None,
        }
    }

    pub fn resumed(offset: usize) -> Self {
        Self {
            status: 206,
            range: Some(format!("bytes {offset}-{}/{}", BODY.len() - 1, BODY.len())),
            ..Self::full(&BODY[offset..])
        }
    }
}

pub struct Fixture {
    pub url: String,
    pub request: oneshot::Receiver<String>,
    pub prefix_sent: oneshot::Receiver<()>,
    pub release: oneshot::Sender<()>,
    pub join: JoinHandle<()>,
}

pub async fn fixture(reply: Reply) -> Fixture {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/module.pkg", listener.local_addr().unwrap());
    let (request_tx, request) = oneshot::channel();
    let (prefix_tx, prefix_sent) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(8), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut received = Vec::new();
        loop {
            let byte = tokio::time::timeout(Duration::from_secs(5), stream.read_u8())
                .await
                .unwrap()
                .unwrap();
            received.push(byte);
            assert!(received.len() <= 16 * 1024);
            if received.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        request_tx
            .send(String::from_utf8(received).unwrap())
            .unwrap();
        let mut headers = format!("HTTP/1.1 {} Fixture\r\nConnection: close\r\n", reply.status);
        if let Some(length) = reply.length {
            headers.push_str(&format!("Content-Length: {length}\r\n"));
        }
        if let Some(range) = reply.range {
            headers.push_str(&format!("Content-Range: {range}\r\n"));
        }
        if let Some(encoding) = reply.encoding {
            headers.push_str(&format!("Content-Encoding: {encoding}\r\n"));
        }
        headers.push_str("\r\n");
        stream.write_all(headers.as_bytes()).await.unwrap();
        if let Some(count) = reply.stall_after {
            stream.write_all(&reply.body[..count]).await.unwrap();
            prefix_tx.send(()).ok();
            let mut next = [0_u8; 1];
            // Cancellation must drop the response connection. A completed
            // background transfer instead receives an explicit fixture release.
            tokio::select! {
                result = stream.read(&mut next) => { assert_eq!(result.unwrap(), 0); return; }
                _ = release_rx => {}
            }
            let _ = stream.write_all(&reply.body[count..]).await;
        } else {
            prefix_tx.send(()).ok();
            let _ = stream.write_all(&reply.body).await;
        }
    });
    Fixture {
        url,
        request,
        prefix_sent,
        release,
        join,
    }
}

pub async fn transfer(
    request: DownloadRequest,
) -> (Result<DownloadResult, DownloadError>, DownloadProgress) {
    let task = Arc::new(Mutex::new(DownloadTask::new(
        &request.id,
        request.expected_total,
    )));
    let service = HttpDownloadService::new(&request.proxy).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        service.download(request, task.clone(), CancellationToken::new()),
    )
    .await
    .unwrap();
    let snapshot = task.lock().await.snapshot().clone();
    (result, snapshot)
}

pub async fn wait_for_bytes(manager: &DownloadManager, id: &str, count: u64) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager.snapshot(id).await.unwrap().downloaded >= count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
