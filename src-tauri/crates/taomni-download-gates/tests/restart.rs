//! Real process death, socket closure and restarted native downloader. Hosted
//! execution only; a manager handle being dropped is not a process restart.

mod support;

use std::process::{Child, Command, Stdio};
use std::time::Duration;

use support::{BODY, request};
use taomni_download_gates::download::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Worker(Child);

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn headers(stream: &mut tokio::net::TcpStream) -> String {
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
            assert!(bytes.len() < 16 * 1024);
        }
        String::from_utf8(bytes).unwrap().to_ascii_lowercase()
    })
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "real process crash and networking: GitHub runners only"]
async fn killed_process_releases_reservations_and_next_process_discovers_and_resumes_bytes() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/module.pkg", listener.local_addr().unwrap());
    let directory = tempfile::tempdir().unwrap();
    let request = request(directory.path(), url.clone());
    let mut worker = Worker(
        Command::new(env!("CARGO_BIN_EXE_download-worker"))
            .arg(directory.path())
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let (mut first, _) = tokio::time::timeout(Duration::from_secs(8), listener.accept())
        .await
        .unwrap()
        .unwrap();
    assert!(!headers(&mut first).await.contains("range:"));
    first
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                BODY.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    first.write_all(&BODY[..6]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        while !directory.path().join("worker-ready").exists() {
            assert!(
                worker.0.try_wait().unwrap().is_none(),
                "worker exited before owning partial bytes"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    let other = DownloadManager::persistent(
        HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap(),
        directory.path().into(),
    );
    assert!(
        matches!(
            other.start(request.clone()).await,
            Err(DownloadError::AlreadyActive(_))
        ),
        "a second app instance must not write a live worker's paths or journal"
    );
    assert_eq!(std::fs::read(&request.partial_path).unwrap(), &BODY[..6]);
    assert!(!request.completed_path.exists());

    worker.0.kill().unwrap();
    assert!(!worker.0.wait().unwrap().success());
    let mut next = [0_u8; 1];
    let closed = tokio::time::timeout(Duration::from_secs(5), first.read(&mut next))
        .await
        .expect("the killed worker's socket must close within five seconds");
    // TerminateProcess closes Winsock with WSAECONNRESET (10054), while Unix
    // reports EOF. Both prove actual peer closure; other errors/bytes fail.
    assert!(
        matches!(&closed, Ok(0))
            || cfg!(windows)
                && matches!(&closed, Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset),
        "actual process death must close its active network connection: {closed:?}"
    );
    drop(first);
    drop(other);

    let restarted = DownloadManager::persistent(
        HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap(),
        directory.path().into(),
    );
    let listing = restarted.list().await;
    assert!(
        listing.recovery_errors.is_empty(),
        "{:?}",
        listing.recovery_errors
    );
    assert_eq!(listing.tasks.len(), 1);
    assert_eq!(listing.tasks[0].id, request.id);
    assert_eq!(listing.tasks[0].progress.downloaded, 6);
    assert_eq!(listing.tasks[0].progress.phase, DownloadPhase::Failed);
    assert!(
        listing.tasks[0]
            .progress
            .error
            .as_ref()
            .unwrap()
            .contains("interrupted")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(200), listener.accept())
            .await
            .is_err(),
        "discovering partial data must not silently start a connection"
    );

    let server = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let received = headers(&mut stream).await;
        assert!(received.contains("range: bytes=6-\r\n"), "{received}");
        stream.write_all(format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes 6-{}/{}\r\nConnection: close\r\n\r\n", BODY.len()-6, BODY.len()-1, BODY.len()).as_bytes()).await.unwrap();
        stream.write_all(&BODY[6..]).await.unwrap();
    });
    let handle = restarted
        .resume_with_service(
            "package",
            HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(8), handle.wait())
            .await
            .unwrap()
            .unwrap()
            .resumed
    );
    server.await.unwrap();
    assert_eq!(std::fs::read(&request.completed_path).unwrap(), BODY);
    assert!(!request.partial_path.exists());
    restarted.shutdown_and_wait().await;
    drop(restarted);

    let reopened = DownloadManager::persistent(
        HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap(),
        directory.path().into(),
    );
    let complete = reopened.list().await;
    assert!(complete.recovery_errors.is_empty());
    assert_eq!(complete.tasks[0].progress.phase, DownloadPhase::Completed);
    assert_eq!(complete.tasks[0].progress.downloaded, BODY.len() as u64);
    assert!(matches!(
        reopened
            .resume_with_service(
                "package",
                HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap()
            )
            .await,
        Err(DownloadError::AlreadyComplete)
    ));
}

#[tokio::test]
#[ignore = "real socket absence and native publication: GitHub runners only"]
async fn fully_saved_partial_is_verified_and_published_without_requesting_past_eof() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let request = request(
        directory.path(),
        format!("http://{}/module.pkg", listener.local_addr().unwrap()),
    );
    std::fs::write(&request.partial_path, BODY).unwrap();
    let manager = DownloadManager::persistent(
        HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap(),
        directory.path().into(),
    );
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        manager.start(request.clone()).await.unwrap().wait(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(result.resumed);
    assert_eq!(result.bytes, BODY.len() as u64);
    assert_eq!(std::fs::read(request.completed_path).unwrap(), BODY);
    assert!(!request.partial_path.exists());
    assert!(
        tokio::time::timeout(Duration::from_millis(200), listener.accept())
            .await
            .is_err()
    );
    assert_eq!(
        manager.list().await.tasks[0].progress.phase,
        DownloadPhase::Completed
    );
}
