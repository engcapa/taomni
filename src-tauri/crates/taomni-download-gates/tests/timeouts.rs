//! These wall-clock/native socket tests are hosted-only, like the TCP suite.

use std::sync::Arc;
use std::time::Duration;

use taomni_download_gates::download::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "real networking and wall clock: GitHub runners only"]
async fn active_stream_can_exceed_thirty_seconds_but_idle_read_times_out() {
    for idle in [false, true] {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}/module.pkg", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
                assert!(request.len() < 16 * 1024);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\na")
                .await
                .unwrap();
            if idle {
                let mut next = [0_u8; 1];
                assert_eq!(
                    tokio::time::timeout(Duration::from_secs(38), stream.read(&mut next))
                        .await
                        .unwrap()
                        .unwrap(),
                    0
                );
            } else {
                // Each read remains active within 30 seconds, while the
                // whole request takes more than 30 seconds.
                for byte in [b'b', b'c', b'd'] {
                    tokio::time::sleep(Duration::from_secs(11)).await;
                    stream.write_all(&[byte]).await.unwrap();
                }
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let request = DownloadRequest {
            id: "timeout".into(),
            url,
            partial_path: directory.path().join("timeout.part"),
            completed_path: directory.path().join("timeout.pkg"),
            expected_total: Some(4),
            expected_sha256: None,
            proxy: ProxyRoute::NoProxy,
        };
        let task = Arc::new(Mutex::new(DownloadTask::new(&request.id, Some(4))));
        let service = HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap();
        let started = tokio::time::Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(42),
            service.download(request.clone(), task.clone(), CancellationToken::new()),
        )
        .await
        .unwrap();
        server.await.unwrap();
        if idle {
            assert!(matches!(result, Err(DownloadError::Http(_))));
            assert_eq!(task.lock().await.snapshot().phase, DownloadPhase::Failed);
            assert!(!request.completed_path.exists());
            assert_eq!(std::fs::read(request.partial_path).unwrap(), b"a");
        } else {
            assert!(started.elapsed() >= Duration::from_secs(30));
            assert_eq!(result.unwrap().bytes, 4);
            assert_eq!(std::fs::read(request.completed_path).unwrap(), b"abcd");
        }
    }
}
