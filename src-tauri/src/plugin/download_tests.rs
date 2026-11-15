
use super::*;
use std::sync::Arc;
use tempfile::tempdir;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

fn endpoint() -> ProxyEndpoint {
    ProxyEndpoint {
        kind: ProxyKind::Http,
        host: "proxy.example".into(),
        port: 8080,
    }
}

#[test]
fn proxy_modes_are_explicit_and_do_not_fallback() {
    assert_eq!(parse_proxy_mode("app").unwrap(), ProxyMode::Application);
    assert_eq!(parse_proxy_mode("CUSTOM").unwrap(), ProxyMode::Feature);
    assert_eq!(parse_proxy_mode("none").unwrap(), ProxyMode::NoProxy);
    assert_eq!(parse_proxy_kind("HTTP").unwrap(), ProxyKind::Http);
    assert_eq!(parse_proxy_kind("socks5h").unwrap(), ProxyKind::Socks5);
    assert!(matches!(
        parse_proxy_kind("ftp"),
        Err(DownloadError::InvalidProxyKind)
    ));
    assert!(matches!(
        parse_proxy_mode("unexpected"),
        Err(DownloadError::UnknownProxyMode(_))
    ));
    assert_eq!(
        resolve_proxy_route(ProxyMode::NoProxy, None, None).unwrap(),
        ProxyRoute::NoProxy
    );
    assert_eq!(
        resolve_proxy_route(ProxyMode::Application, Some(endpoint()), None).unwrap(),
        ProxyRoute::Application(endpoint())
    );
    assert!(matches!(
        resolve_proxy_route(ProxyMode::Feature, None, None),
        Err(DownloadError::ProxyNotConfigured)
    ));
    assert!(matches!(
        resolve_proxy_route(ProxyMode::Application, None, Some(endpoint())),
        Err(DownloadError::ProxyNotConfigured)
    ));
    let mut invalid = endpoint();
    invalid.host = "  ".into();
    assert!(matches!(
        resolve_proxy_route(ProxyMode::Application, Some(invalid), None),
        Err(DownloadError::EmptyProxyHost)
    ));
    let mut invalid = endpoint();
    invalid.port = 0;
    assert!(matches!(
        resolve_proxy_route(ProxyMode::Feature, None, Some(invalid)),
        Err(DownloadError::InvalidProxyPort)
    ));
}

#[test]
fn content_range_requires_exact_resume_offset_and_length() {
    assert_eq!(parse_content_range("bytes 3-5/9").unwrap().len(), 3);
    assert_eq!(
        validate_resume_response(3, Some(9), 206, Some("bytes 3-5/9"), Some(3)).unwrap(),
        ResumeDecision::Append { offset: 3 }
    );
    assert!(matches!(
        validate_resume_response(2, Some(9), 206, Some("bytes 3-5/9"), Some(3)),
        Err(DownloadError::RangeStartMismatch { .. })
    ));
    assert!(matches!(
        validate_resume_response(3, Some(9), 206, Some("bytes 3-5/9"), Some(2)),
        Err(DownloadError::RangeLengthMismatch { .. })
    ));
}

#[test]
fn ignored_range_restarts_instead_of_appending() {
    assert_eq!(
        validate_resume_response(3, Some(9), 200, None, Some(9)).unwrap(),
        ResumeDecision::Restart
    );
    assert_eq!(
        validate_resume_response(0, Some(9), 200, None, Some(9)).unwrap(),
        ResumeDecision::Fresh
    );
    assert!(matches!(
        validate_resume_response(3, Some(9), 206, None, None),
        Err(DownloadError::MissingContentRange)
    ));
    assert!(matches!(
        validate_resume_response(3, Some(9), 200, None, Some(8)),
        Err(DownloadError::RangeLengthMismatch { .. })
    ));
}

#[test]
fn progress_is_retained_after_cancel_and_rejects_future_writes() {
    let mut task = DownloadTask::new("module-1", Some(10));
    task.update(DownloadPhase::Downloading, 4, None).unwrap();
    task.cancel();
    assert_eq!(task.snapshot().phase, DownloadPhase::Cancelled);
    assert!(task.is_cancelled());
    assert!(matches!(
        task.update(DownloadPhase::Verifying, 4, None),
        Err(DownloadError::Cancelled)
    ));
}

#[test]
fn failed_and_incomplete_tasks_are_terminal() {
    let mut task = DownloadTask::new("module-1", Some(10));
    assert!(matches!(
        task.update(DownloadPhase::Completed, 9, None),
        Err(DownloadError::IncompleteCompletion { .. })
    ));
    task.update(DownloadPhase::Failed, 9, Some("network".into()))
        .unwrap();
    assert!(matches!(
        task.update(DownloadPhase::Downloading, 9, None),
        Err(DownloadError::AlreadyFailed)
    ));
}

#[test]
fn task_snapshot_can_be_persisted_for_background_resume() {
    let mut task = DownloadTask::new("module-1", None);
    task.update(DownloadPhase::Downloading, 128, None).unwrap();
    let restored: DownloadTask =
        serde_json::from_str(&serde_json::to_string(&task).expect("download task serializes"))
            .expect("download task restores");
    assert_eq!(restored.id(), "module-1");
    assert_eq!(restored.snapshot(), task.snapshot());
}

async fn serve_download(listener: tokio::net::TcpListener, body: Vec<u8>) {
    use tokio::io::AsyncReadExt;
    let (mut socket, _) = listener.accept().await.expect("download client connects");
    let mut request = vec![0_u8; 4096];
    let length = socket.read(&mut request).await.expect("request reads");
    let request = String::from_utf8_lossy(&request[..length]);
    let range = request.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        lower
            .strip_prefix("range: bytes=")
            .and_then(|value| value.trim().trim_end_matches('\r').strip_suffix('-'))
            .and_then(|value| value.parse::<usize>().ok())
    });
    let (status, payload, extra) = if let Some(start) = range {
        let payload = body[start..].to_vec();
        (
            "206 Partial Content",
            payload.clone(),
            format!(
                "Content-Range: bytes {start}-{end}/{total}\r\n",
                end = body.len().saturating_sub(1),
                total = body.len()
            ),
        )
    } else {
        ("200 OK", body.clone(), String::new())
    };
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}\r\n",
        payload.len()
    );
    use tokio::io::AsyncWriteExt;
    socket
        .write_all(headers.as_bytes())
        .await
        .expect("response headers write");
    socket
        .write_all(&payload)
        .await
        .expect("response body write");
}

#[tokio::test]
async fn native_http_service_writes_completed_file_and_reports_progress() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/module.pkg", listener.local_addr().unwrap());
    let body = b"module-package".to_vec();
    let server = tokio::spawn(serve_download(listener, body.clone()));
    let dir = tempdir().unwrap();
    let request = DownloadRequest {
        id: "module-fresh".into(),
        url,
        partial_path: dir.path().join("module.pkg.part"),
        completed_path: dir.path().join("module.pkg"),
        expected_total: Some(body.len() as u64),
        proxy: ProxyRoute::NoProxy,
    };
    let task = Arc::new(Mutex::new(DownloadTask::new(
        request.id.clone(),
        request.expected_total,
    )));
    let service = HttpDownloadService::new(&request.proxy).unwrap();
    let result = service
        .download(request.clone(), task.clone(), CancellationToken::new())
        .await
        .unwrap();
    server.await.unwrap();
    assert!(!result.resumed);
    assert_eq!(result.bytes, body.len() as u64);
    assert_eq!(std::fs::read(&result.path).unwrap(), body);
    assert_eq!(task.lock().await.snapshot().phase, DownloadPhase::Completed);
    assert!(!request.partial_path.exists());
}

#[tokio::test]
async fn native_http_service_resumes_partial_file_only_after_range_validation() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/module.pkg", listener.local_addr().unwrap());
    let body = b"module-package".to_vec();
    let dir = tempdir().unwrap();
    let partial = dir.path().join("module.pkg.part");
    std::fs::write(&partial, &body[..6]).unwrap();
    let server = tokio::spawn(serve_download(listener, body.clone()));
    let request = DownloadRequest {
        id: "module-resume".into(),
        url,
        partial_path: partial.clone(),
        completed_path: dir.path().join("module.pkg"),
        expected_total: Some(body.len() as u64),
        proxy: ProxyRoute::NoProxy,
    };
    let task = Arc::new(Mutex::new(DownloadTask::new(
        request.id.clone(),
        request.expected_total,
    )));
    let service = HttpDownloadService::new(&request.proxy).unwrap();
    let result = service
        .download(request, task, CancellationToken::new())
        .await
        .unwrap();
    server.await.unwrap();
    assert!(result.resumed);
    assert_eq!(std::fs::read(result.path).unwrap(), body);
}
