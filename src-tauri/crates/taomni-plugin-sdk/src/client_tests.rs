//! In-memory reader/writer channels; no sockets, subprocesses or app startup.
use super::*;
use std::{sync::Barrier, time::Instant};
use taomni_plugin_api::services::*;

const HOST: &str = "a1234567-1234-1234-1234-123456789abc";

fn operation(client: &Arc<ServiceClient>) -> Arc<Operation> {
    Arc::new(Operation::new(
        Some(OperationContext {
            host_instance: HostInstanceId::parse(HOST).unwrap(),
            operation: OperationId::parse(HOST).unwrap(),
            profile_generation: ProfileGeneration::parse(HOST).unwrap(),
            vault_epoch: VaultEpoch::new(1).unwrap(),
        }),
        Instant::now() + Duration::from_secs(60),
        client.clone(),
    ))
}

fn take(receiver: &mpsc::Receiver<RpcMessage>) -> RpcRequest {
    let RpcMessage::Request(request) = receiver.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("expected a service request")
    };
    request
}

fn respond(client: &ServiceClient, id: RequestId) -> Result<(), RpcError> {
    let mut bytes = SensitiveRpcResponse::success(id, true)
        .encode_line()
        .unwrap();
    let result = client.deliver(&mut bytes);
    assert!(
        bytes.is_empty(),
        "raw reply must be cleared even on rejection"
    );
    result
}

fn request(client: &ServiceClient, operation: &Operation) -> Result<Reply, RpcError> {
    client.request(
        operation,
        EXPORT_GRANT_METHOD,
        serde_json::json!({}),
        ReplyKind::Export,
    )
}

#[test]
fn successful_requests_cross_the_old_limit_without_retaining_completed_or_cancelled_ids() {
    let (output, receiver) = mpsc::sync_channel(8);
    let client = ServiceClient::new(output);
    let worker = client.clone();
    let operation = operation(&client);
    let task = std::thread::spawn(move || {
        for _ in 0..70_000 {
            assert!(matches!(
                request(&worker, &operation).unwrap(),
                Reply::Export(true)
            ));
        }
    });
    let mut last = None;
    for sequence in 1..=70_000 {
        let request = take(&receiver);
        assert_eq!(request.id.to_string(), format!("host/{HOST}/{sequence}"));
        last = Some(request.id.clone());
        respond(&client, request.id).unwrap();
    }
    task.join().unwrap();
    let state = client.state.lock().unwrap();
    assert!(state.pending.is_empty());
    assert!(state.retired.is_empty());
    drop(state);
    assert!(
        respond(&client, last.unwrap()).is_err(),
        "completed response replay must fail"
    );
}

#[test]
fn concurrent_request_allocation_and_enqueue_preserve_strict_wire_order() {
    let (output, receiver) = mpsc::sync_channel(8);
    let client = ServiceClient::new(output);
    let start = Arc::new(Barrier::new(9));
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let worker = client.clone();
        let operation = operation(&client);
        let start = start.clone();
        tasks.push(std::thread::spawn(move || {
            start.wait();
            request(&worker, &operation).unwrap();
        }));
    }
    start.wait();
    for sequence in 1..=8 {
        let request = take(&receiver);
        assert_eq!(request.id.to_string(), format!("host/{HOST}/{sequence}"));
        respond(&client, request.id).unwrap();
    }
    for task in tasks {
        task.join().unwrap();
    }
}

#[test]
fn unanswered_cancellations_share_the_queue_bound_and_one_late_reply_restores_capacity() {
    let (output, receiver) = mpsc::sync_channel(8);
    let client = ServiceClient::new(output);
    let mut ids = Vec::new();
    for _ in 0..8 {
        let operation = operation(&client);
        let waiter = operation.clone();
        let worker = client.clone();
        let task = std::thread::spawn(move || request(&worker, &waiter).err().unwrap());
        ids.push(take(&receiver).id);
        operation.cancel();
        assert_eq!(task.join().unwrap().code, -32006);
    }
    let fresh = operation(&client);
    assert_eq!(
        request(&client, &fresh).err().unwrap().message,
        "CORE_SERVICE_BUSY"
    );
    assert_eq!(client.state.lock().unwrap().retired.len(), 8);
    assert!(receiver.try_recv().is_err());
    respond(&client, ids[0].clone()).unwrap();
    assert!(respond(&client, ids[0].clone()).is_err());
    let worker = client.clone();
    let task = std::thread::spawn(move || request(&worker, &fresh).unwrap());
    let next = take(&receiver);
    assert_eq!(next.id.to_string(), format!("host/{HOST}/9"));
    respond(&client, next.id).unwrap();
    task.join().unwrap();
    for id in ids.into_iter().skip(1) {
        respond(&client, id).unwrap();
    }
    assert!(client.state.lock().unwrap().retired.is_empty());
}

#[test]
fn cancellation_and_response_race_never_loses_the_one_late_reply_marker() {
    let (output, receiver) = mpsc::sync_channel(8);
    let client = ServiceClient::new(output);
    for _ in 0..128 {
        let operation = operation(&client);
        let waiter = operation.clone();
        let worker = client.clone();
        let task = std::thread::spawn(move || {
            let _ = request(&worker, &waiter);
        });
        let id = take(&receiver).id;
        operation.cancel();
        // Delivery competes with the waiter's PendingGuard destructor.
        respond(&client, id.clone()).unwrap();
        task.join().unwrap();
        assert!(respond(&client, id).is_err());
        let state = client.state.lock().unwrap();
        assert!(state.pending.is_empty());
        assert!(state.retired.is_empty());
    }
}

#[test]
fn exhausted_send_sequence_fails_closed_without_wrap_or_reusing_a_request_id() {
    let (output, receiver) = mpsc::sync_channel(8);
    let client = ServiceClient::new(output);
    client.state.lock().unwrap().last_id = u64::MAX - 1;
    let fresh = operation(&client);
    let waiter = fresh.clone();
    let worker = client.clone();
    let task = std::thread::spawn(move || request(&worker, &waiter).unwrap());
    let last = take(&receiver);
    assert_eq!(last.id.to_string(), format!("host/{HOST}/{}", u64::MAX));
    respond(&client, last.id).unwrap();
    task.join().unwrap();
    assert_eq!(
        request(&client, &fresh).err().unwrap().message,
        "CORE_SERVICE_BUSY"
    );
    assert!(receiver.try_recv().is_err());
    assert_eq!(client.state.lock().unwrap().last_id, u64::MAX);
}
