use super::*;
use std::sync::Arc;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("taomni-open-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn opt_in_persists_and_defaults_to_off() {
    let dir = temp_dir("persist");
    let fresh = OpenRequests::default();
    fresh.ensure_loaded(&dir);
    assert!(!fresh.allowed(), "missing settings file must mean disabled");
    fresh.set_allowed(&dir, true).unwrap();
    let reloaded = OpenRequests::default();
    reloaded.ensure_loaded(&dir);
    assert!(reloaded.allowed());
    reloaded.set_allowed(&dir, false).unwrap();
    let again = OpenRequests::default();
    again.ensure_loaded(&dir);
    assert!(!again.allowed());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn requests_resolve_once_and_stay_private_to_their_device() {
    let requests = OpenRequests::default();
    let id = requests.insert("phone-a").unwrap();
    assert_eq!(requests.poll("phone-a", &id).unwrap()["status"], "pending");
    assert_eq!(
        requests.poll("phone-b", &id).unwrap_err(),
        "open_request_not_found"
    );
    assert!(requests.resolve(&id, Ok("local-1".into())));
    assert!(
        !requests.resolve(&id, Err("late".into())),
        "a second desktop answer must not overwrite the first"
    );
    let opened = requests.poll("phone-a", &id).unwrap();
    assert_eq!(opened["status"], "opened");
    assert_eq!(opened["session_id"], "term:local-1");
}

#[test]
fn desktop_failures_are_reduced_to_short_codes() {
    let requests = OpenRequests::default();
    let id = requests.insert("phone").unwrap();
    requests.resolve(&id, Err("vault_locked".into()));
    assert_eq!(
        requests.poll("phone", &id).unwrap()["error"],
        "vault_locked"
    );
    let id = requests.insert("phone").unwrap();
    requests.resolve(&id, Err("Error: <script>connect failed</script>".into()));
    assert_eq!(requests.poll("phone", &id).unwrap()["error"], "open_failed");
}

#[test]
fn pending_requests_are_bounded_per_device_and_cancelled_by_withdrawal() {
    let dir = temp_dir("bounded");
    let requests = OpenRequests::default();
    requests.set_allowed(&dir, true).unwrap();
    let ids: Vec<_> = (0..MAX_PENDING_PER_DEVICE)
        .map(|_| requests.insert("phone").unwrap())
        .collect();
    assert_eq!(
        requests.insert("phone").unwrap_err(),
        "too_many_open_requests"
    );
    assert!(
        requests.insert("other-phone").is_ok(),
        "limit is per device"
    );
    requests.set_allowed(&dir, false).unwrap();
    assert_eq!(
        requests.poll("phone", &ids[0]).unwrap()["error"],
        "open_sessions_disabled"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn pending_requests_time_out() {
    let requests = OpenRequests::default();
    let id = requests.insert("phone").unwrap();
    requests
        .requests
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .created = Instant::now() - PENDING_TIMEOUT - Duration::from_secs(1);
    assert_eq!(
        requests.poll("phone", &id).unwrap()["error"],
        "open_timeout"
    );
    assert!(!requests.resolve(&id, Ok("late".into())));
}

#[test]
fn headless_and_disabled_instances_refuse_to_open() {
    let data = temp_dir("headless-state");
    let state = Arc::new(
        crate::mobile::headless::initialize_with_config(
            &data,
            crate::ai::config::AiConfig::default(),
        )
        .unwrap(),
    );
    let core = Core::Headless(state.clone());
    let body = json!({"kind":"local"});
    assert_eq!(
        start(&core, &state.mobile, "phone", &body).unwrap_err(),
        "open_sessions_disabled"
    );
    let dir = temp_dir("headless");
    state.mobile.open_requests.set_allowed(&dir, true).unwrap();
    assert_eq!(
        start(&core, &state.mobile, "phone", &body).unwrap_err(),
        "desktop_required"
    );
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn expired_desktop_reports_are_ignored_even_without_a_phone_poll() {
    let requests = OpenRequests::default();
    let id = requests.insert("phone").unwrap();
    requests
        .requests
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .created = Instant::now() - PENDING_TIMEOUT - Duration::from_secs(1);
    assert!(!requests.resolve(&id, Ok("late-terminal".into())));
    assert_eq!(
        requests.poll("phone", &id).unwrap()["error"],
        "open_timeout"
    );
}

#[test]
fn a_desktop_claim_is_single_use_and_rechecks_authorization() {
    let dir = temp_dir("claim");
    let requests = OpenRequests::default();
    requests.set_allowed(&dir, true).unwrap();
    let id = requests.insert("phone").unwrap();
    assert!(requests.claim(&id, |device| device == "phone"));
    assert!(!requests.claim(&id, |_| true));
    // Once accepted, this is a normal desktop connection; closing the phone or
    // disabling future opens must not destroy it or lose its result.
    requests.set_allowed(&dir, false).unwrap();
    assert!(requests.resolve(&id, Ok("accepted-terminal".into())));
    assert_eq!(requests.poll("phone", &id).unwrap()["status"], "opened");
    requests.set_allowed(&dir, true).unwrap();
    let revoked = requests.insert("revoked-phone").unwrap();
    assert!(!requests.claim(&revoked, |_| false));
    assert_eq!(
        requests.poll("revoked-phone", &revoked).unwrap()["error"],
        "open_cancelled"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn completed_requests_cannot_grow_the_registry_without_bound() {
    let requests = OpenRequests::default();
    for _ in 0..MAX_RETAINED_REQUESTS {
        let id = requests.insert("phone").unwrap();
        requests.resolve(&id, Err("open_failed".into()));
    }
    assert_eq!(
        requests.insert("phone").unwrap_err(),
        "too_many_open_requests"
    );
}

#[test]
fn broker_titles_replace_opaque_keys_in_the_session_list() {
    let broker =
        crate::mobile::pty_broker::Broker::new(Arc::new(crate::mobile::events::Events::default()));
    broker.register("ws:abc:local:x9");
    assert!(broker.set_title("ws:abc:local:x9", "  Build host  "));
    assert!(!broker.set_title("ws:abc:local:x9", "Build host"));
    assert!(!broker.set_title("missing", "ignored"));
    let title = broker.terminals.lock().unwrap()["ws:abc:local:x9"]
        .title
        .clone();
    assert_eq!(title.as_deref(), Some("Build host"));
}
