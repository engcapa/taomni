use super::admission::acquire_relay_flow_permit;
use super::admission::new_relay_flow_limiter;
use super::bridge::bridge_any_until;
use super::limits::MAX_ACTIVE_RELAY_FLOWS;
use super::limits::RELAY_PERMIT_WAIT;
use std::io;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

#[test]
fn relay_flow_limiter_reserves_fd_headroom() {
    let limiter = new_relay_flow_limiter();
    assert_eq!(limiter.available_permits(), MAX_ACTIVE_RELAY_FLOWS);
    // Global capture funnels every TCP connection on the machine through
    // here, so the ceiling has to be well above a single browser's usage.
    assert!(MAX_ACTIVE_RELAY_FLOWS >= 512);
}

#[tokio::test]
async fn relay_flow_permit_is_released_when_flow_finishes() {
    let limiter = Arc::new(Semaphore::new(1));
    let stop = AtomicBool::new(false);

    let permit = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT)
        .await
        .expect("capacity should be available");
    assert_eq!(limiter.available_permits(), 0);

    drop(permit);
    assert_eq!(limiter.available_permits(), 1);
}

#[tokio::test]
async fn stopped_relay_does_not_wait_for_capacity() {
    let limiter = Arc::new(Semaphore::new(0));
    let stop = AtomicBool::new(true);

    let result = tokio::time::timeout(
        Duration::from_millis(50),
        acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT),
    )
    .await
    .expect("stop should be observed promptly");

    assert!(result.is_none());
}

#[tokio::test]
async fn saturated_relay_gives_up_instead_of_waiting_forever() {
    // The accept loop relies on this returning: it has already accepted the
    // connection and must get back to `accept()` rather than parking here
    // while the kernel backlog fills and clients hang.
    let limiter = Arc::new(Semaphore::new(0));
    let stop = AtomicBool::new(false);

    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        acquire_relay_flow_permit(&limiter, &stop, Duration::from_millis(250)),
    )
    .await
    .expect("must not block past its own deadline");

    assert!(result.is_none());
    assert!(started.elapsed() >= Duration::from_millis(200));
}

#[tokio::test]
async fn capacity_freed_while_waiting_is_picked_up() {
    let limiter = Arc::new(Semaphore::new(1));
    let stop = AtomicBool::new(false);
    let held = acquire_relay_flow_permit(&limiter, &stop, RELAY_PERMIT_WAIT)
        .await
        .expect("first permit");

    let l2 = Arc::clone(&limiter);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        drop(held);
        let _ = &l2;
    });

    let permit = acquire_relay_flow_permit(&limiter, &stop, Duration::from_secs(3)).await;
    assert!(permit.is_some(), "should acquire once the holder releases");
}

const TEST_FIRST_BYTE: Duration = Duration::from_millis(150);

#[tokio::test]
async fn bridge_abandons_a_flow_that_never_moves_a_byte() {
    // A flow that connects and then says nothing used to hold its slot for
    // the lifetime of the process.
    let (mut a, _a_peer) = tokio::io::duplex(64);
    let (mut b, _b_peer) = tokio::io::duplex(64);

    let err = bridge_any_until(&mut a, &mut b, TEST_FIRST_BYTE)
        .await
        .expect_err("should abandon");
    assert!(err.contains("no data"), "unexpected error: {err}");
}

#[tokio::test]
async fn bridge_leaves_an_active_flow_alone_after_it_goes_quiet() {
    // Once data has flowed the connection is legitimate; quiet periods are
    // normal for SSH sessions and websockets and must not be torn down.
    let (mut a, mut a_peer) = tokio::io::duplex(64);
    let (mut b, mut b_peer) = tokio::io::duplex(64);

    let task = tokio::spawn(async move { bridge_any_until(&mut a, &mut b, TEST_FIRST_BYTE).await });

    a_peer.write_all(b"hello").await.expect("write");
    let mut buf = [0u8; 5];
    b_peer.read_exact(&mut buf).await.expect("read through");
    assert_eq!(&buf, b"hello");

    // Well past the first-byte window, with no further traffic.
    tokio::time::sleep(TEST_FIRST_BYTE * 4).await;
    assert!(!task.is_finished(), "active flow must not be abandoned");

    // Closing both ends completes the copy normally.
    drop(a_peer);
    drop(b_peer);
    let (up, _down) = task.await.expect("task").expect("clean finish");
    assert_eq!(up, 5);
}
