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
    manager.forget(&request.id).await;
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
    manager.forget(&request.id).await;
    assert!(manager.snapshot(&request.id).await.is_none());
    manager.state.lock().await.reserve(&request).unwrap();
}
