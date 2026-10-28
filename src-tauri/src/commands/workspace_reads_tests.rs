use super::*;
use std::time::Duration;

#[tokio::test(flavor = "current_thread")]
async fn blocked_read_releases_executor_and_other_read_workers() {
    let executor = std::thread::current().id();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let blocked = on_worker("blocked read", move || {
        started_tx.send(std::thread::current().id()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        42
    });
    let control = async move {
        let worker = started_rx.await.unwrap();
        assert_ne!(worker, executor, "file I/O ran on the calling executor");
        // If reads shared a serial queue, this cannot complete until the
        // blocked operation's safety timeout, and join below fails.
        let other = on_worker("independent read", || 7).await.unwrap();
        assert_eq!(other, 7);
        release_tx.send(()).unwrap();
    };
    let (value, ()) = tokio::join!(blocked, control);
    assert_eq!(value.unwrap(), 42);
}

#[tokio::test]
async fn root_and_loose_reads_preserve_bytes_metadata_and_error_contracts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.json");
    std::fs::write(&path, b"{\"ordinary\":true}\n").unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let absolute = path.to_string_lossy().into_owned();
    let expected =
        crate::workspace::workspace_read_file(root.clone(), "records.json".into(), None).unwrap();
    let result = workspace_read_file(root.clone(), "records.json".into(), None)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(expected).unwrap(),
        serde_json::to_value(result).unwrap()
    );
    let expected = crate::workspace::workspace_read_loose_file(absolute.clone(), None).unwrap();
    let result = workspace_read_loose_file(absolute.clone(), None)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(expected).unwrap(),
        serde_json::to_value(result).unwrap()
    );
    for (relative, limit) in [
        ("missing.json", None),
        ("records.json", Some(1)),
        ("../escape", None),
    ] {
        let expected = crate::workspace::workspace_read_file(root.clone(), relative.into(), limit)
            .unwrap_err();
        assert_eq!(
            workspace_read_file(root.clone(), relative.into(), limit)
                .await
                .unwrap_err(),
            expected
        );
    }
    let expected =
        crate::workspace::workspace_read_loose_file(absolute.clone(), Some(1)).unwrap_err();
    assert_eq!(
        workspace_read_loose_file(absolute, Some(1))
            .await
            .unwrap_err(),
        expected
    );
}

#[tokio::test]
async fn explicit_and_detected_encoding_and_bom_are_retained() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("utf16.json");
    let mut bytes = vec![0xff, 0xfe];
    for unit in "{\"name\":\"文档\"}\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(&path, &bytes).unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let absolute = path.to_string_lossy().into_owned();
    let detected = workspace_read_file(root.clone(), "utf16.json".into(), None)
        .await
        .unwrap();
    let relative =
        workspace_read_file_with_encoding(root, "utf16.json".into(), None, "UTF-16LE".into())
            .await
            .unwrap();
    let loose = workspace_read_loose_file_with_encoding(absolute.clone(), None, "UTF-16LE".into())
        .await
        .unwrap();
    assert_eq!(relative.text, "{\"name\":\"文档\"}\n");
    assert_eq!(detected.hash, relative.hash);
    assert_eq!(loose.hash, relative.hash);
    assert_eq!(loose.text, relative.text);
    assert!(relative.bom && loose.bom && detected.bom);
    let error = workspace_read_loose_file_with_encoding(absolute, None, "missing-encoding".into())
        .await
        .unwrap_err();
    assert!(error.starts_with("Unsupported text encoding:"));
}

#[tokio::test]
async fn worker_failure_is_reported_without_hanging_the_reader() {
    let result: Result<(), String> = on_worker("read test", || panic!("worker fault")).await;
    assert!(
        result
            .unwrap_err()
            .contains("read test: file read worker failed:")
    );
}
