//! Real TCP and native filesystem gates. Never execute these tests locally.

mod support;

use std::sync::Arc;
use std::time::Duration;

use support::*;
use taomni_download_gates::download::*;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn resume_validates_range_and_checksum_before_publication() {
    let fixture = fixture(Reply::resumed(6)).await;
    let directory = tempfile::tempdir().unwrap();
    let request = request(directory.path(), fixture.url);
    std::fs::write(&request.partial_path, &BODY[..6]).unwrap();
    let (result, snapshot) = transfer(request.clone()).await;
    let headers = fixture.request.await.unwrap().to_ascii_lowercase();
    assert!(headers.contains("range: bytes=6-\r\n"));
    assert!(headers.contains("accept-encoding: identity\r\n"));
    fixture.join.await.unwrap();
    assert!(result.unwrap().resumed);
    assert_eq!(snapshot.phase, DownloadPhase::Completed);
    assert_eq!(snapshot.downloaded, BODY.len() as u64);
    assert_eq!(std::fs::read(request.completed_path).unwrap(), BODY);
    assert!(!request.partial_path.exists());
}

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn ignored_range_resets_prefix_and_stale_inferred_total() {
    let fixture = fixture(Reply::full(BODY)).await;
    let directory = tempfile::tempdir().unwrap();
    let mut request = request(directory.path(), fixture.url);
    request.expected_total = None;
    std::fs::write(&request.partial_path, b"obsolete prefix").unwrap();
    let task = Arc::new(Mutex::new(DownloadTask::new("package", Some(999))));
    let service = HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap();
    let result = service
        .download(request.clone(), task.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert!(!result.resumed);
    assert_eq!(task.lock().await.snapshot().total, Some(BODY.len() as u64));
    assert_eq!(std::fs::read(request.completed_path).unwrap(), BODY);
    fixture.request.await.unwrap();
    fixture.join.await.unwrap();
}

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn bad_hash_and_bad_ranges_fail_without_publishing_or_losing_partial() {
    for range in [None, Some("bytes 5-28/29".to_owned())] {
        let mut reply = if range.is_some() {
            Reply::resumed(6)
        } else {
            Reply::full(BODY)
        };
        reply.range = range.clone();
        let fixture = fixture(reply).await;
        let directory = tempfile::tempdir().unwrap();
        let mut request = request(directory.path(), fixture.url);
        request.expected_sha256 = Some("00".repeat(32));
        if range.is_some() {
            std::fs::write(&request.partial_path, &BODY[..6]).unwrap();
        }
        let (result, snapshot) = transfer(request.clone()).await;
        assert!(result.is_err());
        assert_eq!(snapshot.phase, DownloadPhase::Failed);
        assert!(snapshot.error.is_some());
        assert!(!request.completed_path.exists());
        assert_eq!(
            std::fs::read(request.partial_path).unwrap(),
            if range.is_some() { &BODY[..6] } else { BODY }
        );
        fixture.request.await.unwrap();
        fixture.join.await.unwrap();
    }
}

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn unknown_total_partial_stays_indeterminate_and_requires_whole_file_hash() {
    for verified in [true, false] {
        let mut reply = Reply::resumed(6);
        reply.range = Some(format!("bytes 6-{}/*", BODY.len() - 1));
        let fixture = fixture(reply).await;
        let directory = tempfile::tempdir().unwrap();
        let mut request = request(directory.path(), fixture.url);
        request.expected_total = None;
        if !verified {
            request.expected_sha256 = None;
        }
        std::fs::write(&request.partial_path, &BODY[..6]).unwrap();
        let (result, snapshot) = transfer(request.clone()).await;
        assert_eq!(
            snapshot.total, None,
            "segment Content-Length cannot establish whole size"
        );
        assert_eq!(request.completed_path.exists(), verified);
        if verified {
            assert!(result.unwrap().resumed);
        } else {
            assert!(matches!(result, Err(DownloadError::Integrity(_))));
        }
        fixture.request.await.unwrap();
        fixture.join.await.unwrap();
    }
}

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn connection_failure_records_actionable_terminal_state_and_keeps_prefix() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/module.pkg", listener.local_addr().unwrap());
    drop(listener);
    let directory = tempfile::tempdir().unwrap();
    let request = request(directory.path(), url);
    std::fs::write(&request.partial_path, &BODY[..6]).unwrap();
    let (result, snapshot) = transfer(request.clone()).await;
    assert!(matches!(result, Err(DownloadError::Http(_))));
    assert_eq!(snapshot.phase, DownloadPhase::Failed);
    assert!(snapshot.error.unwrap().contains("HTTP request failed"));
    assert_eq!(snapshot.downloaded, 6);
    assert_eq!(std::fs::read(request.partial_path).unwrap(), &BODY[..6]);
    assert!(!request.completed_path.exists());
}

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn cancellation_stops_connection_forget_waits_for_worker_and_retry_resumes() {
    let fixture = fixture(Reply {
        stall_after: Some(6),
        ..Reply::full(BODY)
    })
    .await;
    let directory = tempfile::tempdir().unwrap();
    let mut request = request(directory.path(), fixture.url);
    let manager = DownloadManager::new(HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap());
    let handle = manager.start(request.clone()).await.unwrap();
    fixture.prefix_sent.await.unwrap();
    wait_for_bytes(&manager, &request.id, 6).await;
    assert_eq!(
        manager.cancel(&request.id).await.unwrap().phase,
        DownloadPhase::Cancelled
    );
    manager.forget(&request.id).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), handle.wait())
        .await
        .unwrap();
    assert!(matches!(result, Err(DownloadError::Cancelled)));
    fixture.request.await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), fixture.join)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(&request.partial_path).unwrap(), &BODY[..6]);
    assert!(!request.completed_path.exists());
    manager.forget(&request.id).await.unwrap();
    assert!(manager.snapshot(&request.id).await.is_none());
    let retry = support::fixture(Reply::resumed(6)).await;
    request.url = retry.url;
    assert!(
        manager
            .start(request.clone())
            .await
            .unwrap()
            .wait()
            .await
            .unwrap()
            .resumed
    );
    retry.request.await.unwrap();
    retry.join.await.unwrap();
    assert_eq!(std::fs::read(request.completed_path).unwrap(), BODY);
}

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn background_handle_drop_and_duplicate_paths_or_content_do_not_duplicate_transfer() {
    let fixture = fixture(Reply {
        stall_after: Some(6),
        ..Reply::full(BODY)
    })
    .await;
    let directory = tempfile::tempdir().unwrap();
    let first = request(directory.path(), fixture.url);
    let manager = DownloadManager::new(HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap());
    drop(manager.start(first.clone()).await.unwrap());
    fixture.prefix_sent.await.unwrap();
    wait_for_bytes(&manager, &first.id, 6).await;
    for content_collision in [false, true] {
        let mut second = first.clone();
        second.id = "duplicate".into();
        second.url = "http://127.0.0.1:1/other".into();
        if content_collision {
            second.partial_path = directory.path().join("other.part");
            second.completed_path = directory.path().join("other.pkg");
        } else {
            second.partial_path = directory.path().join("./module.part");
            second.expected_sha256 = None;
        }
        assert!(matches!(
            manager.start(second).await,
            Err(DownloadError::AlreadyActive(_))
        ));
    }
    fixture.release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager.snapshot(&first.id).await.unwrap().phase == DownloadPhase::Completed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture.request.await.unwrap();
    fixture.join.await.unwrap();
    assert_eq!(std::fs::read(first.completed_path).unwrap(), BODY);
}

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn no_proxy_bypasses_poisoned_environment_and_configured_proxy_fails_closed() {
    assert_eq!(std::env::var("HTTP_PROXY").unwrap(), "http://127.0.0.1:9");
    let fixture = fixture(Reply::full(BODY)).await;
    let directory = tempfile::tempdir().unwrap();
    let request = request(directory.path(), fixture.url);
    assert!(transfer(request).await.0.is_ok());
    fixture.request.await.unwrap();
    fixture.join.await.unwrap();

    for feature in [false, true] {
        let destination = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let proxy = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let endpoint = ProxyEndpoint {
            kind: ProxyKind::Http,
            host: "127.0.0.1".into(),
            port: proxy.local_addr().unwrap().port(),
        };
        drop(proxy);
        let directory = tempfile::tempdir().unwrap();
        let mut request = support::request(
            directory.path(),
            format!("http://{}/module.pkg", destination.local_addr().unwrap()),
        );
        request.proxy = if feature {
            ProxyRoute::Feature(endpoint)
        } else {
            ProxyRoute::Application(endpoint)
        };
        let (result, snapshot) = transfer(request.clone()).await;
        assert!(matches!(result, Err(DownloadError::Http(_))));
        assert_eq!(snapshot.phase, DownloadPhase::Failed);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), destination.accept())
                .await
                .is_err(),
            "configured proxy failure must never retry directly"
        );
        assert!(!request.completed_path.exists());
    }
}

#[tokio::test]
#[ignore = "real networking: GitHub runners only"]
async fn transformed_responses_and_oversized_headers_fail_before_writing() {
    for oversized in [false, true] {
        let mut reply = Reply::full(BODY);
        if oversized {
            reply.length = Some(4 * 1024 * 1024 * 1024 + 1);
        } else {
            reply.encoding = Some("gzip".into());
        }
        let fixture = fixture(reply).await;
        let directory = tempfile::tempdir().unwrap();
        let mut request = request(directory.path(), fixture.url);
        request.expected_total = None;
        let (result, snapshot) = transfer(request.clone()).await;
        assert!(matches!(result, Err(DownloadError::Integrity(_))));
        assert_eq!(snapshot.phase, DownloadPhase::Failed);
        assert!(!request.partial_path.exists());
        assert!(!request.completed_path.exists());
        fixture.request.await.unwrap();
        fixture.join.await.unwrap();
    }
}
