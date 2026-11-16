use super::super::{DownloadManager, HttpDownloadService};
use super::*;

fn request(root: &Path, id: &str) -> DownloadRequest {
    DownloadRequest {
        id: id.into(),
        url: "https://example.invalid/module.pkg".into(),
        partial_path: root.join("module.part"),
        completed_path: root.join("module.pkg"),
        expected_total: Some(6),
        expected_sha256: Some(super::super::integrity::hex_digest(&Sha256::digest(
            b"module",
        ))),
        proxy: ProxyRoute::NoProxy,
    }
}

#[tokio::test]
async fn recovery_uses_disk_bytes_and_never_resumes_network_implicitly() {
    let directory = tempfile::tempdir().unwrap();
    let journal = DownloadJournal::new(directory.path().into());
    let request = request(directory.path(), "module/download");
    journal
        .save(
            &request,
            Some(DownloadProgress {
                revision: 8,
                downloaded: 999,
                total: Some(999),
                phase: DownloadPhase::Downloading,
                error: None,
            }),
        )
        .unwrap();
    fs::write(&request.partial_path, b"mod").unwrap();
    let (downloads, errors) = journal.recover().await;
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(downloads.len(), 1);
    assert_eq!(downloads[0].progress.downloaded, 3);
    assert_eq!(downloads[0].progress.total, Some(6));
    assert_eq!(downloads[0].progress.phase, DownloadPhase::Failed);
    assert!(
        downloads[0]
            .progress
            .error
            .as_ref()
            .unwrap()
            .contains("resume")
    );
    assert!(!request.completed_path.exists());
    assert_eq!(fs::read(request.partial_path).unwrap(), b"mod");
}

#[tokio::test]
async fn completed_content_is_reverified_instead_of_trusting_saved_success() {
    let directory = tempfile::tempdir().unwrap();
    let journal = DownloadJournal::new(directory.path().into());
    let request = request(directory.path(), "complete");
    journal.save(&request, None).unwrap();
    fs::write(&request.completed_path, b"module").unwrap();
    let (downloads, errors) = journal.recover().await;
    assert!(errors.is_empty());
    assert_eq!(downloads[0].progress.phase, DownloadPhase::Completed);
    fs::write(&request.completed_path, b"tamper").unwrap();
    let (downloads, errors) = journal.recover().await;
    assert!(errors.is_empty());
    assert_eq!(downloads[0].progress.phase, DownloadPhase::Failed);
    assert!(
        downloads[0]
            .progress
            .error
            .as_ref()
            .unwrap()
            .contains("SHA-256")
    );
    assert_eq!(fs::read(request.completed_path).unwrap(), b"tamper");
}

#[tokio::test]
async fn corrupt_and_unsafe_records_are_visible_without_discarding_valid_tasks() {
    let directory = tempfile::tempdir().unwrap();
    let journal = DownloadJournal::new(directory.path().into());
    let request = request(directory.path(), "valid");
    journal.save(&request, None).unwrap();
    fs::write(journal.directory().unwrap().join("broken.json"), "{").unwrap();
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(journal.path("valid").unwrap()).unwrap()).unwrap();
    value["id"] = "unsafe".into();
    value["partial"] = "../outside.part".into();
    fs::write(
        journal.path("unsafe").unwrap(),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let (downloads, errors) = journal.recover().await;
    assert_eq!(downloads.len(), 1);
    assert_eq!(downloads[0].request.id, "valid");
    assert_eq!(errors.len(), 2);
    assert!(
        errors
            .iter()
            .any(|error| error.contains("unsafe relative path"))
    );
    assert!(
        errors
            .iter()
            .any(|error| error.contains("invalid saved download"))
    );
}

#[test]
fn reservations_coordinate_separate_managers_by_path_content_and_id() {
    let directory = tempfile::tempdir().unwrap();
    let one = DownloadJournal::new(directory.path().into());
    let two = DownloadJournal::new(directory.path().into());
    let first = request(directory.path(), "one");
    let reservation = one.reserve(&first).unwrap();
    let mut second = first.clone();
    second.id = "two".into();
    second.url = "https://example.invalid/another.pkg".into();
    second.partial_path = directory.path().join("another.part");
    second.completed_path = directory.path().join("another.pkg");
    assert!(matches!(
        two.reserve(&second),
        Err(DownloadError::AlreadyActive(_))
    ));
    second.expected_sha256 = None;
    let other_reservation = two.reserve(&second).unwrap();
    drop(other_reservation);
    second.partial_path = first.completed_path.clone();
    assert!(matches!(
        two.reserve(&second),
        Err(DownloadError::AlreadyActive(_))
    ));
    drop(reservation);
    two.reserve(&second).unwrap();
}

#[tokio::test]
async fn forgotten_task_stays_forgotten_after_restart_and_retains_safe_partial() {
    let directory = tempfile::tempdir().unwrap();
    let journal = DownloadJournal::new(directory.path().into());
    let request = request(directory.path(), "forget");
    journal.save(&request, None).unwrap();
    fs::write(&request.partial_path, b"mod").unwrap();
    let manager = DownloadManager::persistent(
        HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap(),
        directory.path().into(),
    );
    assert_eq!(manager.list().await.tasks.len(), 1);
    manager.forget("forget").await.unwrap();
    drop(manager);
    let restarted = DownloadManager::persistent(
        HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap(),
        directory.path().into(),
    );
    assert!(restarted.list().await.tasks.is_empty());
    assert_eq!(fs::read(request.partial_path).unwrap(), b"mod");
}

#[cfg(unix)]
#[tokio::test]
async fn recovery_rejects_symlinked_records_and_artifacts_without_reading_them() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let journal = DownloadJournal::new(directory.path().into());
    let request = request(directory.path(), "linked");
    journal.save(&request, None).unwrap();
    let secret = outside.path().join("secret");
    fs::write(&secret, b"secret").unwrap();
    std::os::unix::fs::symlink(&secret, &request.partial_path).unwrap();
    let (downloads, errors) = journal.recover().await;
    assert!(downloads.is_empty());
    assert_eq!(errors.len(), 1);
    assert_eq!(fs::read(secret).unwrap(), b"secret");
}
