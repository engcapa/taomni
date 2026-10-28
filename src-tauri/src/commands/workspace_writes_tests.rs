use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

#[tokio::test(flavor = "current_thread")]
async fn blocked_publication_keeps_the_executor_responsive_and_other_writes_queued() {
    let (release, released) = std::sync::mpsc::channel();
    let (start, started) = tokio::sync::oneshot::channel();
    let first = tokio::spawn(on_worker(move || {
        start.send(()).unwrap();
        released.recv_timeout(Duration::from_secs(5)).unwrap();
        "first complete write"
    }));
    started.await.unwrap();
    let second_ran = Arc::new(AtomicBool::new(false));
    let ran = second_ran.clone();
    let second = tokio::spawn(on_worker(move || {
        ran.store(true, Ordering::SeqCst);
        "second complete write"
    }));
    // This timer shares the single async worker with both saves. A synchronous
    // filesystem wait or mutex would prevent this observation until release.
    tokio::time::timeout(
        Duration::from_millis(500),
        tokio::time::sleep(Duration::from_millis(20)),
    )
    .await
    .unwrap();
    assert!(!second_ran.load(Ordering::SeqCst));
    release.send(()).unwrap();
    assert_eq!(first.await.unwrap().unwrap(), "first complete write");
    assert_eq!(second.await.unwrap().unwrap(), "second complete write");
    assert!(second_ran.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "current_thread")]
async fn failed_worker_reports_unknown_effect_and_releases_the_write_queue() {
    let error = on_worker(|| panic!("controlled file worker failure"))
        .await
        .unwrap_err();
    let failure = worker_error(error);
    assert_eq!(failure.effect, Some(WorkspaceWriteEffect::Unknown));
    assert!(failure.message.contains("controlled file worker failure"));
    assert_eq!(
        on_worker(|| Ok::<_, String>("next write"))
            .await
            .unwrap()
            .unwrap(),
        "next write"
    );
}
