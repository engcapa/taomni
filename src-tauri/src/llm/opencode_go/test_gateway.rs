//! Disposable loopback-only fake gateway for unit tests, never a live provider.
use std::sync::{Arc,Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub async fn start(
    count: usize,
    respond: impl Fn(&str) -> (u16,String,&'static str) + Send + Sync + 'static,
) -> (String,Arc<Mutex<Vec<String>>>,tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}",listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let task = tokio::spawn(async move {
        for _ in 0..count {
            let (mut socket,_) = tokio::time::timeout(std::time::Duration::from_secs(5),listener.accept()).await.unwrap().unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8;4096];
                let len = socket.read(&mut chunk).await.unwrap();
                if len == 0 { break; }
                bytes.extend_from_slice(&chunk[..len]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length = header.lines().find_map(|line| line.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0);
                    if bytes.len() >= end + 4 + length { break; }
                }
            }
            let raw = String::from_utf8(bytes).unwrap();
            let (status,body,content_type) = respond(&raw);
            captured.lock().unwrap().push(raw);
            socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    (base,requests,task)
}
