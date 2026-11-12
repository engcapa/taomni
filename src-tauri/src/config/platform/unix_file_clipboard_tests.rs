//! Main-loop ownership/cancellation tests: no GTK initialization or clipboard IO.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn file_clipboard_foreign_owner_targets_are_not_skipped_without_a_gdk_window() {
    // A foreign file-manager selection can have no GDK-wrapped owner window.
    // File availability depends on TARGETS, not on that local wrapper lookup.
    let targets = vec!["UTF8_STRING".to_string(), "text/uri-list".to_string()];
    assert_eq!(
        file_format_from_targets(&targets),
        Some(FileListFormat::UriList)
    );
    let targets = vec![
        "x-special/gnome-copied-files".to_string(),
        "text/uri-list".to_string(),
    ];
    assert_eq!(
        file_format_from_targets(&targets),
        Some(FileListFormat::GnomeCopiedFiles)
    );
    assert_eq!(file_format_from_targets(&["UTF8_STRING".to_string()]), None);
    assert_eq!(file_format_from_targets(&[]), None);
}

#[test]
fn file_clipboard_failed_targets_are_empty_only_for_raw_x11_none_owner() {
    assert!(failed_targets_result(Some(x11rb::NONE)).unwrap().is_empty());
    // An unwrapped foreign owner is still nonzero on the X11 protocol wire.
    assert!(
        failed_targets_result(Some(0x123456))
            .unwrap_err()
            .starts_with("clipboard_files:unavailable:")
    );
    // Unknown/query failure or Wayland ambiguity must not become false empty.
    assert!(
        failed_targets_result(None)
            .unwrap_err()
            .starts_with("clipboard_files:unavailable:")
    );
}

#[test]
fn file_clipboard_reader_requests_targets_without_gdk_owner_short_circuit() {
    // Boundary regression: pure policy tests alone cannot detect a future early
    // native return inserted before they run. Inspect the production boundary
    // without initializing GTK or opening any user's display/clipboard.
    let source = include_str!("unix_file_clipboard.rs");
    assert!(source.contains("clipboard.request_contents(&gdk::Atom::intern(\"TARGETS\")"));
    assert!(!source.contains("gdk::selection_owner_get("));
}

#[test]
fn file_clipboard_cancelled_main_loop_write_never_publishes_later() {
    let gate = WriteGate::new();
    let called = AtomicBool::new(false);
    gate.cancel();
    gate.run(Instant::now() + REQUEST_TIMEOUT, || {
        called.store(true, Ordering::SeqCst)
    });
    assert!(!called.load(Ordering::SeqCst));
}

#[test]
fn file_clipboard_expired_main_loop_write_never_publishes_later() {
    let gate = WriteGate::new();
    let called = AtomicBool::new(false);
    gate.run(Instant::now() - Duration::from_secs(1), || {
        called.store(true, Ordering::SeqCst)
    });
    assert!(!called.load(Ordering::SeqCst));
    gate.run(Instant::now() + REQUEST_TIMEOUT, || {
        called.store(true, Ordering::SeqCst)
    });
    assert!(!called.load(Ordering::SeqCst));
}

#[test]
fn file_clipboard_ownership_handoff_runs_exactly_once() {
    let gate = WriteGate::new();
    let called = AtomicBool::new(false);
    gate.run(Instant::now() + REQUEST_TIMEOUT, || {
        called.store(true, Ordering::SeqCst)
    });
    assert!(called.load(Ordering::SeqCst));
    gate.run(Instant::now() + REQUEST_TIMEOUT, || {
        panic!("duplicate ownership handoff")
    });
    gate.cancel();
}

#[test]
fn file_clipboard_in_flight_handoff_publishes_result_before_timeout_can_cancel() {
    let gate = Arc::new(WriteGate::new());
    let in_flight = gate.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let (result_tx, mut result_rx) = oneshot::channel();
    let owner = std::thread::spawn(move || {
        in_flight.run(Instant::now() + REQUEST_TIMEOUT, || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            result_tx.send(Ok::<_, String>(())).unwrap();
        });
    });
    started_rx.recv().unwrap();
    let cancellation = std::thread::spawn(move || {
        gate.cancel();
        assert!(matches!(result_rx.try_recv(), Ok(Ok(()))));
    });
    finish_tx.send(()).unwrap();
    owner.join().unwrap();
    cancellation.join().unwrap();
}
