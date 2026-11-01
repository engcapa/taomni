use super::*;
#[test]
fn single_use_expiry_revocation_and_origin_bound_tickets() {
    let mut auth = Auth::default();
    let code = auth.pairing_code();
    let pair = auth
        .pair("phone", &code, Some("https://phone.example".into()), "ip")
        .unwrap();
    assert!(auth.pair("again", &code, None, "ip").is_err());
    let token = pair["token"].as_str().unwrap();
    let id = auth.authenticate(token).unwrap();
    assert!(auth.authenticate("wrong").is_none());
    assert!(
        !serde_json::to_string(&auth.devices)
            .unwrap()
            .contains(token)
    );
    let ticket = auth
        .ticket(id.clone(), Some("https://phone.example".into()))
        .unwrap();
    assert!(
        auth.consume_ticket(&ticket, Some("https://evil.example"))
            .is_none()
    );
    assert!(
        auth.consume_ticket(&ticket, Some("https://phone.example"))
            .is_none()
    );
    let ticket = auth.ticket(id.clone(), None).unwrap();
    assert_eq!(auth.consume_ticket(&ticket, None), Some(id.clone()));
    assert!(auth.consume_ticket(&ticket, None).is_none());
    auth.revoke(&id).unwrap();
    assert!(auth.authenticate(token).is_none());
    assert!(!auth.paired_origin("https://phone.example"));
    let code = auth.pairing_code();
    auth.code.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(1);
    assert!(auth.pair("expired", &code, None, "ip2").is_err());
    for _ in 0..5 {
        let _ = auth.pair("bad", "bad", None, "bad-ip");
    }
    assert_eq!(
        auth.pair("bad", "bad", None, "bad-ip").unwrap_err(),
        "rate_limited"
    );
}
#[test]
fn persistence_contains_only_hashes_and_deletion_revokes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mobile-devices.json");
    let mut a = Auth::default();
    a.load(path.clone()).unwrap();
    let code = a.pairing_code();
    let pair = a.pair("phone", &code, None, "ip").unwrap();
    let token = pair["token"].as_str().unwrap();
    assert!(!std::fs::read_to_string(&path).unwrap().contains(token));
    let mut b = Auth::default();
    b.load(path.clone()).unwrap();
    assert!(b.authenticate(token).is_some());
    std::fs::remove_file(&path).unwrap();
    // Shutdown must never resurrect a deleted device store.
    b.flush().unwrap();
    b.load(path).unwrap();
    assert!(b.authenticate(token).is_none());
}

#[test]
fn success_is_not_a_failure_and_full_source_table_does_not_deny_new_sources() {
    let mut auth = Auth::default();
    for _ in 0..8 {
        let code = auth.pairing_code();
        assert!(auth.pair("phone", &code, None, "same-source").is_ok());
    }
    for n in 0..1025 {
        let _ = auth.pair("bad", "wrong", None, &format!("source-{n}"));
    }
    let code = auth.pairing_code();
    assert!(auth.pair("phone", &code, None, "new-source").is_ok());
    assert!(auth.failures.len() <= 1024);
    for _ in 0..5 {
        let _ = auth.pair("bad", "wrong", None, "127.0.0.1");
    }
    let code = auth.pairing_code();
    assert!(
        auth.pair("valid via shared proxy", &code, None, "127.0.0.1")
            .is_ok()
    );
}
#[test]
fn absolute_idle_expiry_and_stopping_invalidate_credentials() {
    for absolute in [true, false] {
        let mut auth = Auth::default();
        let code = auth.pairing_code();
        let pair = auth.pair("phone", &code, None, "source").unwrap();
        let id = pair["device_id"].as_str().unwrap();
        let ticket = auth.ticket(id.into(), None).unwrap();
        if absolute {
            auth.devices[0].created_at -= TOKEN_LIFETIME + 1;
        } else {
            auth.devices[0].last_used_at -= TOKEN_IDLE + 1;
        }
        assert!(auth.authenticate(pair["token"].as_str().unwrap()).is_none());
        assert!(!auth.exists(id));
        assert!(auth.consume_ticket(&ticket, None).is_none());
    }
    let mut auth = Auth::default();
    let code = auth.pairing_code();
    auth.clear_ephemeral();
    assert!(auth.pair("phone", &code, None, "source").is_err());
}
