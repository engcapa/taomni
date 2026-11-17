//! Observe resource order from the lease destructor itself, before the rest of
//! an aborted, unpolled task could be destroyed. GitHub-only real socket test.
use std::{
    net::SocketAddrV4,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use taomni_plugin_stream::{
    CancellationToken, TransferLimits, TransferPool, TransferScope, TransferUsage,
};

struct LeaseWitness {
    endpoint: Arc<Mutex<Option<SocketAddrV4>>>,
    released_after_listener: Arc<AtomicBool>,
}

impl Drop for LeaseWitness {
    fn drop(&mut self) {
        if let Some(endpoint) = *self.endpoint.lock().unwrap() {
            // This listener never had a connection, so TIME_WAIT is irrelevant.
            // Record the independent kernel observation at lease release time.
            if let Ok(rebound) = std::net::TcpListener::bind(endpoint) {
                drop(rebound);
                self.released_after_listener.store(true, Ordering::Release);
            }
        }
    }
}

#[tokio::test]
#[ignore = "real kernel listener ownership: GitHub only"]
async fn unpolled_task_abort_releases_its_kernel_listener_before_the_owned_lease() {
    let pool = TransferPool::new(Default::default()).unwrap();
    let endpoint = Arc::new(Mutex::new(None));
    let released_after_listener = Arc::new(AtomicBool::new(false));
    let pending = pool
        .reserve(4)
        .unwrap()
        .offer_with_owner(
            b"safe".to_vec(),
            "application/octet-stream",
            TransferLimits::default(),
            TransferScope {
                cancelled: CancellationToken::new(),
                deadline: Instant::now() + Duration::from_secs(5),
            },
            LeaseWitness {
                endpoint: endpoint.clone(),
                released_after_listener: released_after_listener.clone(),
            },
        )
        .await
        .unwrap();
    *endpoint.lock().unwrap() = Some(
        pending
            .descriptor()
            .stream_url
            .strip_prefix("ws://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .parse()
            .unwrap(),
    );
    // No await since spawn: this current-thread executor has not entered the
    // transfer future, and must destroy its complete captured resource owner.
    drop(pending);
    assert!(!released_after_listener.load(Ordering::Acquire));
    assert_eq!(pool.usage().transfers, 1);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !released_after_listener.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("lease destructor observed a live kernel listener or was never run");
    assert_eq!(pool.usage(), TransferUsage::default());
}
