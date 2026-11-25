use super::super::{DownloadPhase, DownloadTask, ProxyRoute};
use super::*;

#[test]
fn ignored_range_restarts_total_and_unknown_range_keeps_indeterminate_total() {
    assert_eq!(
        response_sizes(None, ResumeDecision::Restart, None, Some(14)).unwrap(),
        (0, Some(14), Some(14))
    );
    assert_eq!(
        response_sizes(
            None,
            ResumeDecision::Append { offset: 6 },
            Some("bytes 6-13/*"),
            None
        )
        .unwrap(),
        (6, None, Some(8))
    );
    assert_eq!(
        response_sizes(
            None,
            ResumeDecision::Append { offset: 6 },
            Some("bytes 6-13/*"),
            Some(8)
        )
        .unwrap(),
        (6, None, Some(8))
    );
    assert_eq!(
        response_sizes(
            Some(14),
            ResumeDecision::Append { offset: 6 },
            Some("bytes 6-13/14"),
            Some(8)
        )
        .unwrap(),
        (6, Some(14), Some(8))
    );
    assert_eq!(
        response_sizes(None, ResumeDecision::Fresh, None, None).unwrap(),
        (0, None, None)
    );
}

#[test]
fn invalid_integrity_and_unsafe_package_requests_are_rejected_before_connecting() {
    let mut request = DownloadRequest {
        id: "test".into(),
        url: "https://example.com/package".into(),
        partial_path: "/tmp/package.part".into(),
        completed_path: "/tmp/package".into(),
        expected_total: Some(4),
        expected_sha256: Some("00".repeat(32)),
        proxy: ProxyRoute::NoProxy,
    };
    assert!(validate_request(&request).is_ok());
    request.expected_sha256 = Some("invalid".into());
    assert!(matches!(
        validate_request(&request),
        Err(DownloadError::Integrity(_))
    ));
    request.expected_sha256 = None;
    request.expected_total = Some(MAX_PACKAGE_BYTES + 1);
    assert!(validate_request(&request).is_err());
    request.expected_total = None;
    for url in [
        "file:///tmp/package",
        "https://user:password@example.com/package",
        "https://example.com/package#fragment",
    ] {
        request.url = url.into();
        assert!(matches!(
            validate_request(&request),
            Err(DownloadError::InvalidUrl(_))
        ));
    }
}

#[tokio::test]
async fn checksums_and_cancellation_preserve_partial_and_working_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("package.part");
    let completed = directory.path().join("package");
    std::fs::write(&partial, b"new package").unwrap();
    std::fs::write(&completed, b"working package").unwrap();
    let token = CancellationToken::new();
    assert!(matches!(
        verify_file(&partial, Some(&"00".repeat(32)), &token).await,
        Err(DownloadError::Integrity(_))
    ));
    let expected = hex_digest(Sha256::digest(b"new package").as_slice());
    verify_file(&partial, Some(&expected), &token)
        .await
        .unwrap();
    assert!(matches!(
        publish(&partial, &completed).await,
        Err(DownloadError::OutputExists(_))
    ));
    assert_eq!(std::fs::read(&completed).unwrap(), b"working package");
    assert_eq!(std::fs::read(&partial).unwrap(), b"new package");
    token.cancel();
    assert!(matches!(
        verify_file(&partial, Some(&expected), &token).await,
        Err(DownloadError::Cancelled)
    ));
    assert!(matches!(
        verify_file(&partial, None, &token).await,
        Err(DownloadError::Cancelled)
    ));
}

#[tokio::test]
async fn verified_publication_moves_bytes_without_replacing_another_writer() {
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("package.part");
    let completed = directory.path().join("package");
    std::fs::write(&partial, b"verified bytes").unwrap();
    publish(&partial, &completed).await.unwrap();
    assert_eq!(std::fs::read(&completed).unwrap(), b"verified bytes");
    assert!(!partial.exists());
}

#[test]
fn completion_requires_exact_total_including_oversized_response() {
    let mut task = DownloadTask::new("test", Some(10));
    assert!(matches!(
        task.update(DownloadPhase::Completed, 11, None),
        Err(DownloadError::IncompleteCompletion { .. })
    ));
    assert!(
        response_sizes(
            Some(MAX_PACKAGE_BYTES + 1),
            ResumeDecision::Fresh,
            None,
            None
        )
        .is_err()
    );
}

#[tokio::test]
async fn validation_failures_are_terminal_before_any_network_request() {
    use super::super::HttpDownloadService;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let directory = tempfile::tempdir().unwrap();
    let partial_path = directory.path().join("package.part");
    let completed_path = directory.path().join("package.pkg");
    std::fs::write(&partial_path, b"partial bytes").unwrap();
    std::fs::write(&completed_path, b"working package").unwrap();
    let mut request = DownloadRequest {
        id: "validation".into(),
        url: "https://example.test/must-not-connect".into(),
        partial_path: partial_path.clone(),
        completed_path: completed_path.clone(),
        expected_total: None,
        expected_sha256: None,
        proxy: ProxyRoute::NoProxy,
    };
    let service = HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap();
    for output_exists in [true, false] {
        let task = Arc::new(Mutex::new(DownloadTask::new("validation", None)));
        if !output_exists {
            std::fs::remove_file(&completed_path).unwrap();
            request.expected_sha256 = Some("invalid digest".into());
        }
        let result = service
            .download(request.clone(), task.clone(), CancellationToken::new())
            .await;
        assert!(if output_exists {
            matches!(result, Err(DownloadError::OutputExists(_)))
        } else {
            matches!(result, Err(DownloadError::Integrity(_)))
        });
        let task = task.lock().await;
        assert_eq!(task.snapshot().phase, DownloadPhase::Failed);
        assert!(task.snapshot().error.is_some());
        assert_eq!(std::fs::read(&partial_path).unwrap(), b"partial bytes");
        if output_exists {
            assert_eq!(std::fs::read(&completed_path).unwrap(), b"working package");
        }
    }
}

#[tokio::test]
async fn terminal_snapshot_cannot_be_changed_by_later_phase_attempts() {
    use super::super::set_task_phase;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    let task = Arc::new(Mutex::new(DownloadTask::new("completed", Some(4))));
    task.lock()
        .await
        .update(DownloadPhase::Completed, 4, None)
        .unwrap();
    let before = task.lock().await.snapshot().clone();
    assert!(
        set_task_phase(&task, DownloadPhase::Downloading, 8, None, Some(20))
            .await
            .is_err()
    );
    assert_eq!(task.lock().await.snapshot(), &before);
}
