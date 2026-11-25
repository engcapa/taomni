use std::sync::{
    Arc, Barrier,
    atomic::{AtomicBool, Ordering},
};

use super::*;
use crate::{CancellationToken, TransferScope};

fn scope(cancelled: CancellationToken) -> TransferScope {
    TransferScope {
        cancelled,
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
    }
}

fn pool(slots: usize, bytes: usize) -> TransferPool {
    TransferPool::new(TransferPoolLimits {
        max_transfers: slots,
        max_bytes: bytes,
    })
    .unwrap()
}

struct Owner(Arc<AtomicBool>);

impl Drop for Owner {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[test]
fn reservations_bound_combined_bytes_and_share_one_budget_across_workers() {
    let pool = pool(4, 12);
    let first = pool.reserve(8).unwrap();
    let second = pool.clone().reserve(4).unwrap();
    assert_eq!(
        pool.usage(),
        TransferUsage {
            transfers: 2,
            bytes: 12
        }
    );
    assert_eq!(
        pool.reserve(1).err().unwrap().message,
        "BINARY_TRANSFER_BUSY"
    );
    drop(first);
    let resumed = pool.reserve(8).unwrap();
    assert_eq!(pool.usage().bytes, 12);
    drop((second, resumed));
    assert_eq!(pool.usage(), TransferUsage::default());
}

#[test]
fn empty_payloads_consume_listener_capacity() {
    let pool = pool(2, 1);
    let first = pool.reserve(0).unwrap();
    let second = pool.reserve(0).unwrap();
    assert_eq!(
        pool.usage(),
        TransferUsage {
            transfers: 2,
            bytes: 0
        }
    );
    assert_eq!(
        pool.reserve(0).err().unwrap().code,
        ErrorCode::InvalidState as i32
    );
    drop((first, second));
    assert!(pool.reserve(1).is_ok());
}

#[test]
fn concurrent_reservations_cannot_oversubscribe_memory() {
    let pool = pool(8, 24);
    let barrier = Arc::new(Barrier::new(33));
    let reservations = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..32)
            .map(|_| {
                let pool = pool.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    let reservation = pool.reserve(8).ok();
                    barrier.wait();
                    reservation
                })
            })
            .collect();
        barrier.wait();
        workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(reservations.len(), 3);
    assert_eq!(
        pool.usage(),
        TransferUsage {
            transfers: 3,
            bytes: 24
        }
    );
    drop(reservations);
    assert_eq!(pool.usage(), TransferUsage::default());
}

#[test]
fn invalid_limits_or_impossible_reservations_fail_without_consuming_capacity() {
    for (slots, bytes) in [(0, 1), (129, 1), (1, 0), (1, 8 * MAX_PAYLOAD_BYTES + 1)] {
        assert_eq!(
            TransferPool::new(TransferPoolLimits {
                max_transfers: slots,
                max_bytes: bytes
            })
            .err()
            .unwrap()
            .code,
            ErrorCode::InvalidParams as i32
        );
    }
    let pool = pool(1, 12);
    for bytes in [13, MAX_PAYLOAD_BYTES + 1, usize::MAX] {
        assert_eq!(
            pool.reserve(bytes).err().unwrap().code,
            ErrorCode::InvalidParams as i32
        );
        assert_eq!(pool.usage(), TransferUsage::default());
    }
}

#[tokio::test]
async fn payload_cannot_exceed_its_reservation_and_failure_releases_the_owner() {
    let pool = pool(1, 12);
    let dropped = Arc::new(AtomicBool::new(false));
    let result = pool
        .reserve(1)
        .unwrap()
        .offer_with_owner(
            b"too large".to_vec(),
            "application/octet-stream",
            TransferLimits::default(),
            scope(CancellationToken::new()),
            Owner(dropped.clone()),
        )
        .await;
    assert_eq!(result.err().unwrap().code, ErrorCode::InvalidParams as i32);
    assert!(dropped.load(Ordering::Acquire));
    assert_eq!(pool.usage(), TransferUsage::default());
}

#[tokio::test]
async fn already_cancelled_owner_fails_before_allocating_a_listener() {
    let pool = pool(1, 12);
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let dropped = Arc::new(AtomicBool::new(false));
    let result = pool
        .reserve(4)
        .unwrap()
        .offer_with_owner(
            b"safe".to_vec(),
            "application/octet-stream",
            TransferLimits::default(),
            scope(cancelled),
            Owner(dropped.clone()),
        )
        .await;
    assert_eq!(
        result.err().unwrap().code,
        ErrorCode::RequestCancelled as i32
    );
    assert!(dropped.load(Ordering::Acquire));
    assert_eq!(pool.usage(), TransferUsage::default());
}

#[tokio::test]
async fn excess_buffer_capacity_cannot_bypass_the_aggregate_memory_reservation() {
    let pool = pool(1, 4);
    let mut payload = Vec::with_capacity(32);
    payload.extend_from_slice(b"safe");
    let result = pool
        .reserve(4)
        .unwrap()
        .offer_with_owner(
            payload,
            "application/octet-stream",
            TransferLimits::default(),
            scope(CancellationToken::new()),
            (),
        )
        .await;
    assert_eq!(result.err().unwrap().code, ErrorCode::InvalidParams as i32);
    assert_eq!(pool.usage(), TransferUsage::default());
}

#[tokio::test]
async fn expired_scope_is_rejected_before_allocating_a_listener() {
    let pool = pool(1, 4);
    let result = pool
        .reserve(4)
        .unwrap()
        .offer_with_owner(
            b"safe".to_vec(),
            "application/octet-stream",
            TransferLimits::default(),
            TransferScope {
                cancelled: CancellationToken::new(),
                deadline: std::time::Instant::now(),
            },
            (),
        )
        .await;
    assert_eq!(result.err().unwrap().code, ErrorCode::RequestTimeout as i32);
    assert_eq!(pool.usage(), TransferUsage::default());
}
