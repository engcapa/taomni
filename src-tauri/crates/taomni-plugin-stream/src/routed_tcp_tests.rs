use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::test]
async fn reconnects_to_the_approved_route_after_the_previous_stream_closes() {
    let (upstreams, mut accepted) = tokio::sync::mpsc::unbounded_channel();
    let local_address = "[::1]:33890".parse::<SocketAddr>().unwrap();
    let (_owner, endpoint) = Route::bind(move || {
        let (proxy, service) = tokio::io::duplex(1024);
        upstreams.send(service).unwrap();
        std::future::ready(Ok((proxy, local_address)))
    })
    .await
    .unwrap();

    timeout(TEST_TIMEOUT, async {
        for value in [b'a', b'b'] {
            let (mut local, observed_address) = endpoint.connect().await.unwrap();
            let mut upstream = accepted.recv().await.unwrap();
            assert_eq!(observed_address, local_address);
            local.write_u8(value).await.unwrap();
            assert_eq!(upstream.read_u8().await.unwrap(), value);
            upstream.write_u8(value + 1).await.unwrap();
            assert_eq!(local.read_u8().await.unwrap(), value + 1);
            drop(local);
            assert_eq!(upstream.read(&mut [0]).await.unwrap(), 0);
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn rejects_wrong_key_before_the_core_dials() {
    let dials = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&dials);
    let (_owner, mut endpoint) = Route::bind(move || {
        dials.fetch_add(1, Ordering::Relaxed);
        std::future::ready(Err::<(tokio::io::DuplexStream, SocketAddr), _>(
            "DNS failure".into(),
        ))
    })
    .await
    .unwrap();

    let correct_key = endpoint.clone();
    endpoint.key[0] ^= 1;
    assert!(
        endpoint
            .connect()
            .await
            .unwrap_err()
            .contains("route proof")
    );
    assert_eq!(observed.load(Ordering::Relaxed), 0);
    assert_eq!(correct_key.connect().await.unwrap_err(), "DNS failure");
    assert_eq!(observed.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn closing_the_owner_closes_both_sides_of_an_active_stream() {
    let (upstreams, mut accepted) = tokio::sync::mpsc::unbounded_channel();
    let (owner, endpoint) = Route::bind(move || {
        let (proxy, service) = tokio::io::duplex(1024);
        upstreams.send(service).unwrap();
        std::future::ready(Ok((proxy, "127.0.0.1:4321".parse().unwrap())))
    })
    .await
    .unwrap();
    timeout(TEST_TIMEOUT, async {
        let (mut local, _) = endpoint.connect().await.unwrap();
        let mut upstream = accepted.recv().await.unwrap();
        drop(owner);
        assert_eq!(local.read(&mut [0]).await.unwrap(), 0);
        assert_eq!(upstream.read(&mut [0]).await.unwrap(), 0);
    })
    .await
    .unwrap();
}
