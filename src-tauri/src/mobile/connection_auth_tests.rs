use super::*;
use serde_json::json;

fn pending(requests: &OpenRequests) -> String {
    requests
        .allowed
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let id = requests.insert("phone-a", false).unwrap();
    assert!(requests.claim(&id, |_| true));
    id
}
fn prompts() -> Vec<Prompt> {
    vec![Prompt {
        prompt: "OTP".into(),
        echo: false,
        initial: String::new(),
    }]
}
fn publish(requests: &OpenRequests, id: &str) -> (String, oneshot::Receiver<Option<Vec<String>>>) {
    let (tx, rx) = oneshot::channel();
    let challenge = requests
        .publish(
            id,
            "SSH".into(),
            "One-time code".into(),
            prompts(),
            Reply::Direct(Some(tx)),
        )
        .unwrap();
    (challenge, rx)
}

#[tokio::test]
async fn answers_are_private_single_use_and_absent_from_poll_responses() {
    let requests = OpenRequests::default();
    let id = pending(&requests);
    let (challenge, rx) = publish(&requests, &id);
    assert_eq!(
        requests
            .answer("phone-b", &id, &challenge, Some(vec!["stolen".into()]))
            .unwrap_err(),
        "open_request_not_found"
    );
    assert_eq!(
        requests
            .answer("phone-a", &id, "old-round", Some(vec!["stale".into()]))
            .unwrap_err(),
        "already_resolved"
    );
    requests
        .answer("phone-a", &id, &challenge, Some(vec!["123456".into()]))
        .unwrap();
    assert_eq!(rx.await.unwrap(), Some(vec!["123456".into()]));
    assert!(requests.poll("phone-a", &id).unwrap()["auth"].is_null());
    assert!(
        !requests
            .poll("phone-a", &id)
            .unwrap()
            .to_string()
            .contains("123456")
    );
    assert_eq!(
        requests
            .answer("phone-a", &id, &challenge, Some(vec!["duplicate".into()]))
            .unwrap_err(),
        "already_resolved"
    );
}

#[tokio::test]
async fn invalid_answers_preserve_the_round_for_retry() {
    let requests = OpenRequests::default();
    let id = pending(&requests);
    let (challenge, rx) = publish(&requests, &id);
    assert_eq!(
        requests
            .answer("phone-a", &id, &challenge, Some(vec![]))
            .unwrap_err(),
        "invalid_auth_response"
    );
    assert_eq!(
        requests
            .answer("phone-a", &id, &challenge, Some(vec!["x".repeat(8193)]))
            .unwrap_err(),
        "invalid_auth_response"
    );
    requests
        .answer("phone-a", &id, &challenge, Some(vec!["ok".into()]))
        .unwrap();
    assert_eq!(rx.await.unwrap(), Some(vec!["ok".into()]));
}

#[tokio::test]
async fn phone_and_desktop_compete_for_the_same_ssh_responder() {
    for desktop_first in [false, true] {
        let requests = OpenRequests::default();
        let id = pending(&requests);
        requests.bind_terminal(&id, "ssh-1").unwrap();
        assert!(requests.bind_terminal(&id, "unrelated-ssh-2").is_err());
        let responders = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel();
        responders
            .lock()
            .unwrap()
            .insert("ssh-1:round-1".into(), tx);
        let challenge = requests
            .publish_ssh(
                &id,
                "OTP".into(),
                "".into(),
                prompts(),
                responders.clone(),
                "ssh-1:round-1".into(),
            )
            .unwrap();
        if desktop_first {
            responders
                .lock()
                .unwrap()
                .remove("ssh-1:round-1")
                .unwrap()
                .send(Some(vec!["desktop".into()]))
                .unwrap();
            assert_eq!(
                requests
                    .answer("phone-a", &id, &challenge, Some(vec!["phone".into()]))
                    .unwrap_err(),
                "already_resolved"
            );
        } else {
            requests
                .answer("phone-a", &id, &challenge, Some(vec!["phone".into()]))
                .unwrap();
            assert!(responders.lock().unwrap().remove("ssh-1:round-1").is_none());
        }
        assert_eq!(
            rx.await.unwrap(),
            Some(vec![if desktop_first { "desktop" } else { "phone" }.into()])
        );
        assert!(responders.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn cancellation_revocation_timeout_and_failed_open_drop_pending_answers() {
    for reason in ["cancel", "revoke", "timeout", "failure", "stop"] {
        let requests = OpenRequests::default();
        let id = pending(&requests);
        let (_, rx) = publish(&requests, &id);
        let (cancel, _) = requests.cancellation(&id).unwrap();
        match reason {
            "cancel" => requests.cancel("phone-a", &id).unwrap(),
            "revoke" => requests.cancel_pending(Some("phone-a")),
            "stop" => requests.cancel_pending(None),
            "failure" => {
                requests.resolve(&id, Err("open_failed".into()));
            }
            _ => {
                requests
                    .requests
                    .lock()
                    .unwrap()
                    .get_mut(&id)
                    .unwrap()
                    .created = Instant::now() - PENDING_TIMEOUT;
                assert_eq!(
                    requests.poll("phone-a", &id).unwrap()["error"],
                    "open_timeout"
                );
            }
        }
        assert_eq!(rx.await.unwrap(), None, "{reason}");
        assert!(cancel.is_cancelled(), "{reason}");
        assert!(requests.cancellation(&id).is_err());
        assert!(requests.poll("phone-a", &id).unwrap()["auth"].is_null());
    }
}

#[tokio::test]
async fn cancelling_one_device_does_not_cancel_another_or_an_opened_terminal() {
    let requests = OpenRequests::default();
    let id = pending(&requests);
    requests.resolve(&id, Ok("working-terminal".into()));
    requests.cancel_pending(None);
    assert_eq!(
        requests.poll("phone-a", &id).unwrap()["session_id"],
        "term:working-terminal"
    );
    let id = pending(&requests);
    let (challenge, rx) = publish(&requests, &id);
    requests.cancel_pending(Some("phone-b"));
    requests
        .answer(
            "phone-a",
            &id,
            &challenge,
            Some(vec!["still-active".into()]),
        )
        .unwrap();
    assert_eq!(rx.await.unwrap(), Some(vec!["still-active".into()]));
}

#[tokio::test]
async fn real_http_challenges_require_authentication_and_the_requesting_device() {
    let fixture = crate::mobile::service_tests::Fixture::new().await;
    let (device, token) = fixture.pair().await;
    let (_, other_token) = fixture.pair().await;
    let requests = &fixture.state.mobile.open_requests;
    requests
        .allowed
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let id = requests.insert(&device, false).unwrap();
    assert!(requests.claim(&id, |_| true));
    let (challenge, rx) = publish(requests, &id);
    let url = format!("{}/api/v1/open-requests/{id}/auth", fixture.endpoint);
    let body = json!({"challenge_id":challenge, "responses":["654321"]});
    assert_eq!(
        fixture
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        fixture
            .client
            .post(&url)
            .bearer_auth(&other_token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    assert_eq!(
        fixture
            .client
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    assert_eq!(rx.await.unwrap(), Some(vec!["654321".into()]));
    assert_eq!(
        fixture
            .client
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::CONFLICT
    );
    fixture.finish().await;
}

#[test]
fn final_launch_guard_never_runs_after_cancel_revoke_stop_or_expiry() {
    for reason in ["cancel", "revoke", "stop", "timeout"] {
        let requests = OpenRequests::default();
        let id = pending(&requests);
        match reason {
            "cancel" => requests.cancel("phone-a", &id).unwrap(),
            "revoke" => requests.cancel_pending(Some("phone-a")),
            "stop" => requests.cancel_pending(None),
            _ => {
                requests
                    .requests
                    .lock()
                    .unwrap()
                    .get_mut(&id)
                    .unwrap()
                    .created = Instant::now() - PENDING_TIMEOUT
            }
        }
        let mut launched = false;
        assert!(
            requests
                .while_pending(&id, || {
                    launched = true;
                    Ok(())
                })
                .is_err(),
            "{reason}"
        );
        assert!(!launched, "{reason}");
    }
}

#[tokio::test]
async fn whole_connection_preparation_is_dropped_on_mobile_cancellation() {
    let fixture = crate::mobile::service_tests::Fixture::new().await;
    let id = pending(&fixture.state.mobile.open_requests);
    let context = MobileAuthContext {
        runtime: fixture.state.mobile.clone(),
        request_id: id.clone(),
    };
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    struct Owner(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Owner {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let owner = Owner(dropped.clone());
    let operation = during_connection(Some(&context), async move {
        let _owner = owner;
        std::future::pending::<()>().await;
        Ok(())
    });
    let cancel = async {
        tokio::task::yield_now().await;
        fixture
            .state
            .mobile
            .open_requests
            .cancel("phone-a", &id)
            .unwrap();
    };
    let (result, _) = tokio::join!(operation, cancel);
    assert_eq!(result.unwrap_err(), "open_cancelled");
    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    fixture.finish().await;
}
