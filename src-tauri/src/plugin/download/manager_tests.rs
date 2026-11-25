use super::*;

fn request(directory: &Path, id: &str) -> DownloadRequest {
    DownloadRequest {
        id: id.into(),
        url: format!("https://example.test/{id}"),
        partial_path: directory.join(format!("{id}.part")),
        completed_path: directory.join(format!("{id}.pkg")),
        expected_total: None,
        expected_sha256: None,
        proxy: ProxyRoute::NoProxy,
    }
}

#[test]
fn reservations_cover_ids_both_paths_urls_and_hashes_until_release() {
    let directory = tempfile::tempdir().unwrap();
    let first = request(directory.path(), "one");
    let mut state = ManagerState::default();
    let (_, token) = state.reserve(&first).unwrap();
    assert!(state.reserve(&first).is_err());
    let mut second = request(directory.path(), "two");
    second.completed_path = first.partial_path.clone();
    assert!(state.reserve(&second).is_err());
    second = request(directory.path(), "two");
    second.url = "https://EXAMPLE.test/one".into();
    assert!(state.reserve(&second).is_err());
    token.cancel();
    assert!(
        state.reserve(&second).is_err(),
        "cancellation does not release live worker ownership"
    );
    state.release("one");
    second.expected_sha256 = Some("AB".repeat(32));
    state.reserve(&second).unwrap();
    let mut third = request(directory.path(), "three");
    third.expected_sha256 = Some("ab".repeat(32));
    assert!(
        state.reserve(&third).is_err(),
        "different URLs/paths cannot duplicate known content"
    );
    state.release("two");
    state.reserve(&third).unwrap();
}

#[tokio::test]
async fn panic_is_terminal_releases_reservations_and_allows_forget_and_retry() {
    let directory = tempfile::tempdir().unwrap();
    let request = request(directory.path(), "panic");
    let manager = DownloadManager::new(HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap());
    let (task, _) = manager.state.lock().await.reserve(&request).unwrap();
    manager.forget(&request.id).await.unwrap();
    assert!(manager.snapshot(&request.id).await.is_some());
    let result = manager
        .run_worker(&request.id, &task, async {
            panic!("synthetic transfer panic")
        })
        .await;
    assert!(matches!(result, Err(DownloadError::Http(_))));
    let snapshot = manager.snapshot(&request.id).await.unwrap();
    assert_eq!(snapshot.phase, DownloadPhase::Failed);
    assert!(snapshot.error.unwrap().contains("panicked"));
    manager.forget(&request.id).await.unwrap();
    assert!(manager.snapshot(&request.id).await.is_none());
    manager.state.lock().await.reserve(&request).unwrap();
}

#[tokio::test]
async fn shutdown_cancels_owned_tasks_waits_for_worker_exit_and_rejects_starts() {
    let directory = tempfile::tempdir().unwrap();
    let request = request(directory.path(), "shutdown");
    std::fs::write(&request.partial_path, b"safe prefix").unwrap();
    let manager = DownloadManager::new(HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap());
    let (task, cancellation) = manager.state.lock().await.reserve(&request).unwrap();
    let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let worker_manager = manager.clone();
    let id = request.id.clone();
    let worker = tokio::spawn(async move {
        worker_manager
            .run_worker(&id, &task, async {
                cancellation.cancelled().await;
                cancelled_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Err(DownloadError::Cancelled)
            })
            .await
    });
    let shutdown_manager = manager.clone();
    let shutdown = tokio::spawn(async move { shutdown_manager.shutdown_and_wait().await });
    let concurrent_manager = manager.clone();
    let concurrent = tokio::spawn(async move { concurrent_manager.shutdown_and_wait().await });
    cancelled_rx.await.unwrap();
    assert!(
        !shutdown.is_finished(),
        "profile cannot be released before worker exits"
    );
    assert!(!concurrent.is_finished());
    assert!(matches!(
        manager.start(request.clone()).await,
        Err(DownloadError::ShuttingDown)
    ));
    release_tx.send(()).unwrap();
    assert!(matches!(
        worker.await.unwrap(),
        Err(DownloadError::Cancelled)
    ));
    shutdown.await.unwrap();
    concurrent.await.unwrap();
    manager.shutdown_and_wait().await;
    assert_eq!(
        manager.snapshot(&request.id).await.unwrap().phase,
        DownloadPhase::Cancelled
    );
    assert!(manager.state.lock().await.paths.is_empty());
    assert!(manager.state.lock().await.artifacts.is_empty());
    assert_eq!(std::fs::read(request.partial_path).unwrap(), b"safe prefix");
    assert!(!request.completed_path.exists());
}
