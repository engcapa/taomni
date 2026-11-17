//! Real loopback sockets and OS leases; execute only on GitHub runners.
#[path = "support/binary.rs"]
mod support;

use std::time::{Duration, Instant};

use taomni_plugin_api::{
    ErrorCode,
    services::{CoreServiceError, RevokedKeys},
};
use taomni_plugin_stream::{CancellationToken, TransferUsage, receive};
use tokio::{io::AsyncReadExt, net::TcpStream, time::timeout};

use support::*;

#[tokio::test]
#[ignore = "real loopback and OS lease: GitHub only"]
async fn request_lease_and_reserved_memory_cover_a_multichunk_transfer() {
    let fixture = Fixture::new();
    let outer = fixture.admit(Duration::from_secs(5));
    let bytes = vec![0xa5; 131_079];
    let pending = fixture.offer(&outer, "first", bytes.clone()).await;
    assert_eq!(
        fixture.pool.usage(),
        TransferUsage {
            transfers: 1,
            bytes: bytes.len()
        }
    );
    fixture.assert_writer_blocked();
    let received = receive(pending.descriptor(), limits(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(received, bytes);
    assert_eq!(pending.finish().await.unwrap(), bytes.len() as u64);
    assert_eq!(fixture.pool.usage(), TransferUsage::default());
    assert!(outer.check_current().is_ok());
    fixture.assert_writer_blocked();
    drop(outer);
    fixture.assert_drained();
}

#[tokio::test]
#[ignore = "real loopback and OS lease: GitHub only"]
async fn retiring_outer_operation_cancels_offer_before_releasing_its_os_lease() {
    let fixture = Fixture::new();
    let outer = fixture.admit(Duration::from_secs(5));
    let pending = fixture
        .offer(&outer, "first", b"private frame".to_vec())
        .await;
    let endpoint = address(pending.descriptor());
    drop(outer);
    // The current-thread executor has not polled the network task yet. The
    // task still owns the request, even though the outer operation has ended.
    assert_eq!(fixture.admission.in_flight_count(), 1);
    fixture.assert_writer_blocked();
    assert_eq!(
        pending.finish().await.unwrap_err().code,
        ErrorCode::RequestCancelled as i32
    );
    fixture.assert_drained();
    assert_port_released(endpoint);
}

#[tokio::test]
#[ignore = "real loopback and OS lease: GitHub only"]
async fn disconnect_cancels_a_stalled_connected_peer_and_reclaims_its_budget() {
    let fixture = Fixture::new();
    let outer = fixture.admit(Duration::from_secs(5));
    let pending = fixture
        .offer(&outer, "first", b"private frame".to_vec())
        .await;
    let mut peer = TcpStream::connect(address(pending.descriptor()))
        .await
        .unwrap();
    fixture.admission.cancel_host(&fixture.host);
    assert!(!fixture.host.termination_confirmed());
    assert_eq!(
        pending.finish().await.unwrap_err().code,
        ErrorCode::RequestCancelled as i32
    );
    // No handshake or payload was published; the actual connected socket dies.
    assert!(
        timeout(Duration::from_secs(5), peer.read_u8())
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(fixture.pool.usage(), TransferUsage::default());
    assert!(outer.check_current().is_err());
    fixture.assert_writer_blocked();
    drop(outer);
    fixture.assert_drained();
}

#[tokio::test]
#[ignore = "real loopback and OS lease: GitHub only"]
async fn revoke_ack_cannot_drain_a_request_ahead_of_its_binary_task_cleanup() {
    let fixture = Fixture::new();
    let outer = fixture.admit(Duration::from_secs(5));
    let pending = fixture
        .offer(&outer, "first", b"private frame".to_vec())
        .await;
    let endpoint = address(pending.descriptor());
    let revocation = fixture
        .admission
        .begin_revoke(std::slice::from_ref(&fixture.host))
        .unwrap();
    fixture
        .admission
        .acknowledge_revoke(
            &fixture.host,
            &RevokedKeys {
                host_instance: fixture.host.instance().clone(),
                profile_generation: revocation.generation.clone(),
                vault_epoch: revocation.epoch,
            },
        )
        .unwrap();
    drop(outer);
    assert_eq!(
        fixture.admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    fixture.assert_writer_blocked();
    assert_eq!(
        pending.finish().await.unwrap_err().code,
        ErrorCode::RequestCancelled as i32
    );
    fixture.admission.finish_revoke(&revocation).unwrap();
    fixture.assert_drained();
    assert_port_released(endpoint);
}

#[tokio::test]
#[ignore = "real loopback and OS lease: GitHub only"]
async fn absolute_operation_deadline_caps_a_longer_transfer_budget() {
    let fixture = Fixture::new();
    let started = Instant::now();
    let outer = fixture.admit(Duration::from_millis(250));
    let pending = fixture
        .offer(&outer, "first", b"private frame".to_vec())
        .await;
    let endpoint = address(pending.descriptor());
    let result = timeout(Duration::from_secs(2), pending.finish())
        .await
        .expect("outer deadline must override the five-second stream budget");
    assert_eq!(result.unwrap_err().code, ErrorCode::RequestTimeout as i32);
    println!(
        "absolute operation deadline reclaimed the offer after {:?}",
        started.elapsed()
    );
    drop(outer);
    fixture.assert_drained();
    assert_port_released(endpoint);
}

#[tokio::test]
#[ignore = "real loopback and OS lease: GitHub only"]
async fn aborting_an_unpolled_task_reclaims_network_before_its_request_lease() {
    let fixture = Fixture::new();
    let outer = fixture.admit(Duration::from_secs(5));
    let pending = fixture
        .offer(&outer, "first", b"private frame".to_vec())
        .await;
    let endpoint = address(pending.descriptor());
    drop(outer);
    drop(pending);
    assert_eq!(fixture.admission.in_flight_count(), 1);
    fixture.assert_writer_blocked();
    assert_eq!(fixture.pool.usage().transfers, 1);
    timeout(Duration::from_secs(5), async {
        while fixture.pool.usage().transfers != 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("aborted task must be reaped");
    fixture.assert_drained();
    assert_port_released(endpoint);
}

#[tokio::test]
#[ignore = "real loopback and OS lease: GitHub only"]
async fn explicit_transfer_cancellation_preserves_the_outer_operation_and_sibling() {
    let fixture = Fixture::new();
    let outer = fixture.admit(Duration::from_secs(5));
    let first = fixture.offer(&outer, "first", b"first".to_vec()).await;
    let sibling = fixture.offer(&outer, "second", b"second".to_vec()).await;
    assert_eq!(fixture.pool.usage().transfers, 2);
    assert_eq!(
        first.cancel_and_wait().await.unwrap_err().code,
        ErrorCode::RequestCancelled as i32
    );
    assert!(outer.check_current().is_ok());
    assert_eq!(fixture.pool.usage().transfers, 1);
    assert_eq!(
        receive(sibling.descriptor(), limits(), &CancellationToken::new())
            .await
            .unwrap(),
        b"second"
    );
    assert_eq!(sibling.finish().await.unwrap(), 6);
    drop(outer);
    fixture.assert_drained();
}
