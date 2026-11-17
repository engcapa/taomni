//! Invalid service replies are rejected before constructing a network runtime.
use super::*;
use taomni_plugin_api::BinaryRef;

#[test]
fn a_stale_context_or_wrong_media_type_never_opens_the_capture_stream() {
    for stale in [false, true] {
        let (operation, client, receiver) = operation();
        let task = std::thread::spawn(move || operation.capture_still().err().unwrap().code);
        let request = take_request(&receiver);
        assert_eq!(request.method, CAPTURE_STILL_METHOD);
        assert_eq!(request.params, Some(serde_json::json!({})));
        let mut context = context();
        if stale {
            context.vault_epoch = VaultEpoch::new(2).unwrap();
        }
        let mut bytes = SensitiveRpcResponse::success(
            request.id,
            CaptureStillResult {
                context,
                binary: BinaryRef {
                    stream_url: "ws://127.0.0.1:1/binary/no-network-in-this-unit".into(),
                    token: "unit-token".into(),
                    byte_len: 17,
                    sha256: "ab".repeat(32),
                    content_type: if stale {
                        LUMA_FRAMES_CONTENT_TYPE
                    } else {
                        "image/png"
                    }
                    .into(),
                },
            },
        )
        .encode_line()
        .unwrap();
        client.deliver(&mut bytes).unwrap();
        assert!(bytes.is_empty());
        assert_eq!(task.join().unwrap(), if stale { -32009 } else { -32600 });
    }
}

#[test]
fn cancelling_a_capture_request_discards_its_late_descriptor() {
    let (operation, client, receiver) = operation();
    let worker = operation.clone();
    let task = std::thread::spawn(move || worker.capture_still().err().unwrap().code);
    let request = take_request(&receiver);
    operation.cancel();
    assert_eq!(task.join().unwrap(), -32006);
    let mut bytes = SensitiveRpcResponse::success(request.id.clone(), serde_json::json!({}))
        .encode_line()
        .unwrap();
    client.deliver(&mut bytes).unwrap();
    let mut replay = SensitiveRpcResponse::success(request.id, serde_json::json!({}))
        .encode_line()
        .unwrap();
    assert!(client.deliver(&mut replay).is_err());
}
