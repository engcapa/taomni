use super::*;

const HOST: &str = "a1234567-1234-1234-1234-123456789abc";

fn ledger(direction: &str) -> RequestReplay {
    RequestReplay::new(
        RequestIdMode::MonotonicV1,
        direction,
        Some(&HostInstanceId::parse(HOST).unwrap()),
    )
    .unwrap()
}

#[test]
fn monotonic_requests_pass_the_old_lifetime_limit_without_retaining_ids() {
    let mut replay = ledger("host");
    for sequence in 1..=70_000 {
        replay
            .accept(&format!("host/{HOST}/{sequence}").into())
            .unwrap();
    }
    assert_eq!(replay.last, 70_000);
    assert!(replay.seen.is_empty());
    for sequence in [1, 32_000, 69_999, 70_000] {
        assert_eq!(
            replay.accept(&format!("host/{HOST}/{sequence}").into()),
            Err(ReplayError::Duplicate)
        );
    }
    replay.accept(&format!("host/{HOST}/70001").into()).unwrap();
}

#[test]
fn wrong_transport_direction_noncanonical_and_overflow_never_advance_watermark() {
    let mut replay = ledger("core");
    for id in [
        format!("host/{HOST}/1"),
        "core/other/1".into(),
        format!("core/{HOST}/0"),
        format!("core/{HOST}/01"),
        format!("core/{HOST}/+1"),
        format!("core/{HOST}/1.0"),
        format!("core/{HOST}/18446744073709551616"),
        format!("core/{HOST}/operation"),
    ] {
        assert_eq!(replay.accept(&id.into()), Err(ReplayError::Invalid));
        assert_eq!(replay.last, 0);
    }
    assert_eq!(
        replay.accept(&RequestId::Number(1)),
        Err(ReplayError::Invalid)
    );
    replay
        .accept(&format!("core/{HOST}/{}", u64::MAX).into())
        .unwrap();
    assert_eq!(
        replay.accept(&format!("core/{HOST}/1").into()),
        Err(ReplayError::Duplicate)
    );
    assert!(RequestReplay::new(RequestIdMode::MonotonicV1, "core", None).is_err());
}

#[test]
fn legacy_handshakes_remain_omitted_and_keep_duplicate_and_capacity_rejection() {
    let request = crate::HandshakeRequest::new("hello", "0.1.0", "token", vec![], vec![]);
    let raw = serde_json::to_value(&request).unwrap();
    assert!(raw.get("requestIdMode").is_none());
    assert_eq!(
        serde_json::from_value::<crate::HandshakeRequest>(raw)
            .unwrap()
            .request_id_mode,
        RequestIdMode::Legacy
    );
    let mut replay = RequestReplay::new(RequestIdMode::Legacy, "core", None).unwrap();
    for id in 0..65_536 {
        replay.accept(&RequestId::Number(id)).unwrap();
    }
    assert_eq!(
        replay.accept(&RequestId::Number(0)),
        Err(ReplayError::Duplicate)
    );
    assert_eq!(
        replay.accept(&RequestId::Number(65_536)),
        Err(ReplayError::Full)
    );
    assert_eq!(replay.seen.len(), 65_536);
}

#[test]
fn an_echoed_mode_is_explicit_and_rejected_sequences_are_not_retryable() {
    let mut request = crate::HandshakeRequest::new("hello", "0.1.0", "token", vec![], vec![]);
    request.request_id_mode = RequestIdMode::MonotonicV1;
    assert_eq!(
        serde_json::to_value(&request).unwrap()["requestIdMode"],
        "monotonic-v1"
    );
    let mut replay = ledger("core");
    replay.accept(&format!("core/{HOST}/8").into()).unwrap();
    // The caller can reject a busy/invalid command after acceptance. A retry
    // still needs a new sequence; skipped values may never arrive later.
    assert_eq!(
        replay.accept(&format!("core/{HOST}/7").into()),
        Err(ReplayError::Duplicate)
    );
    assert_eq!(
        replay.accept(&format!("core/{HOST}/8").into()),
        Err(ReplayError::Duplicate)
    );
    replay.accept(&format!("core/{HOST}/10").into()).unwrap();
}
