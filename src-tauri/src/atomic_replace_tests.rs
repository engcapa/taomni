use super::*;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

struct Files(PathBuf);

impl Files {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "taomni-backup-atomic-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("job.json"), br#"{"phase":"packing"}"#).unwrap();
        fs::write(path.join("pending.json"), br#"{"phase":"completed"}"#).unwrap();
        Self(path)
    }
}

impl Drop for Files {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn successful_replacement_publishes_a_complete_record() {
    let files = Files::new();
    retry(|| fs::rename(files.0.join("pending.json"), files.0.join("job.json"))).unwrap();
    assert_eq!(
        fs::read(files.0.join("job.json")).unwrap(),
        br#"{"phase":"completed"}"#
    );
    assert!(!files.0.join("pending.json").exists());
}

#[test]
fn unrelated_errors_fail_immediately() {
    for code in [2, 13, 112] {
        let mut attempts = 0;
        let error = retry(|| {
            attempts += 1;
            Err::<(), _>(io::Error::from_raw_os_error(code))
        })
        .unwrap_err();
        assert_eq!(attempts, 1);
        assert_eq!(error.raw_os_error(), Some(code));
    }
}

#[cfg(not(windows))]
#[test]
fn posix_errors_with_windows_numeric_codes_are_not_retried() {
    for code in [5, 32, 33] {
        let mut attempts = 0;
        assert!(
            retry(|| {
                attempts += 1;
                Err::<(), _>(io::Error::from_raw_os_error(code))
            })
            .is_err()
        );
        assert_eq!(attempts, 1);
    }
}

#[cfg(windows)]
fn reader_without_delete_sharing(path: &std::path::Path) -> fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2) // FILE_SHARE_READ | FILE_SHARE_WRITE, without DELETE.
        .open(path)
        .unwrap()
}

#[cfg(windows)]
#[test]
fn reader_lock_released_after_a_failed_attempt_allows_atomic_publication() {
    let files = Files::new();
    let destination = files.0.join("job.json");
    let source = files.0.join("pending.json");
    let reader = reader_without_delete_sharing(&destination);
    let (release, released) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        released.recv_timeout(Duration::from_secs(5)).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        drop(reader);
    });
    let mut attempts = 0;
    let result = retry(|| {
        attempts += 1;
        let result = fs::rename(&source, &destination);
        if attempts == 1 {
            assert!(transient_denial(result.as_ref().unwrap_err()));
            assert_eq!(fs::read(&destination).unwrap(), br#"{"phase":"packing"}"#);
            assert_eq!(fs::read(&source).unwrap(), br#"{"phase":"completed"}"#);
            release.send(()).unwrap();
        }
        result
    });
    worker.join().unwrap();
    result.unwrap();
    assert!(attempts > 1);
    assert_eq!(fs::read(destination).unwrap(), br#"{"phase":"completed"}"#);
}

#[cfg(windows)]
#[test]
fn permanent_reader_lock_reports_error_and_preserves_both_complete_files() {
    let files = Files::new();
    let destination = files.0.join("job.json");
    let source = files.0.join("pending.json");
    let _reader = reader_without_delete_sharing(&destination);
    let start = Instant::now();
    let mut attempts = 0;
    let error = retry_until(
        || {
            attempts += 1;
            fs::rename(&source, &destination)
        },
        start + Duration::from_millis(60),
    )
    .unwrap_err();
    assert!(transient_denial(&error));
    assert!(attempts > 1);
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(fs::read(destination).unwrap(), br#"{"phase":"packing"}"#);
    assert_eq!(fs::read(source).unwrap(), br#"{"phase":"completed"}"#);
}
