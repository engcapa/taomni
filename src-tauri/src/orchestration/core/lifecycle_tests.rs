use super::tests::{setup, submission};

#[test]
fn revoked_resource_after_preparation_cannot_enter_worker_dispatch() {
    let (_tmp, mut inner, project) = setup();
    let run = inner
        .create(submission(&project, "prepared-revocation", 2))
        .unwrap();
    let lease = inner.reserve(&run.id, run.revision, false).unwrap();
    inner.begin(&run.id).unwrap();
    let mut settings = inner.settings().unwrap();
    settings.resources.clear();
    settings.planning_resource_id.clear();
    settings.review_resource_id.clear();
    inner.save_settings(&settings, 2).unwrap();
    let mut spawned = false;
    let outcome = inner.dispatch_worker(&run.id, &lease.resource, &lease.request, || {
        spawned = true;
        Ok(())
    });
    assert!(outcome.unwrap_err().contains("RESOURCE_REVOKED"));
    assert!(!spawned);
    // An unsent reservation can still be dispatched exactly once after explicit
    // reauthorization. Revocation did not mark the old request as sent.
    inner.store.mark_sent(&lease.request).unwrap();
}

#[test]
fn cancelled_prepared_run_does_not_mark_sent_or_spawn() {
    let (_tmp, mut inner, project) = setup();
    let run = inner
        .create(submission(&project, "prepared-cancel", 2))
        .unwrap();
    let lease = inner.reserve(&run.id, run.revision, false).unwrap();
    inner.begin(&run.id).unwrap();
    inner.request_cancel(&run.id).unwrap();
    let mut spawned = false;
    assert_eq!(
        inner.dispatch_worker(&run.id, &lease.resource, &lease.request, || {
            spawned = true;
            Ok(())
        }),
        Err("CANCELLED".into())
    );
    assert!(!spawned);
    inner.store.mark_sent(&lease.request).unwrap();
}

#[test]
fn cancel_between_reservation_and_spawn_cannot_lose_the_owner_token() {
    let (_tmp, mut inner, project) = setup();
    let run = inner
        .create(submission(&project, "cancel-start", 2))
        .unwrap();
    let lease = inner.reserve(&run.id, run.revision, false).unwrap();
    assert_eq!(inner.store.active_count().unwrap(), 1);
    assert_eq!(inner.request_cancel(&run.id).unwrap().status, "stopping");
    assert!(lease.cancel.is_cancelled());
    assert!(inner.begin(&run.id).is_err());
    inner.finish(&lease, &Err("CANCELLED".into())).unwrap();
    assert_eq!(inner.store.active_count().unwrap(), 0);
    assert!(inner.active.is_empty());
    assert_eq!(inner.store.get(&run.id).unwrap().status, "cancelled");
}

#[test]
fn unknown_stop_retains_capacity_and_cannot_be_cleared_by_cancel() {
    let (_tmp, mut inner, project) = setup();
    let run = inner
        .create(submission(&project, "unknown-stop", 2))
        .unwrap();
    let lease = inner.reserve(&run.id, run.revision, false).unwrap();
    inner.begin(&run.id).unwrap();
    inner
        .finish(&lease, &Err("WORKER_STOP_UNKNOWN".into()))
        .unwrap();
    assert_eq!(inner.store.get(&run.id).unwrap().status, "interrupted");
    assert_eq!(inner.store.active_count().unwrap(), 1);
    assert_eq!(inner.active.len(), 1);
    assert!(inner.request_cancel(&run.id).is_err());
}

#[test]
fn completion_is_atomic_with_ledger_and_releases_no_unknown_reservation() {
    let (_tmp, mut inner, project) = setup();
    let run = inner
        .create(submission(&project, "atomic-finish", 2))
        .unwrap();
    let mut lease = inner.reserve(&run.id, run.revision, false).unwrap();
    inner.begin(&run.id).unwrap();
    let correct = lease.request.clone();
    lease.request = "not-a-real-request".into();
    assert!(inner.finish(&lease, &Err("fixture error".into())).is_err());
    assert_eq!(inner.store.get(&run.id).unwrap().status, "running");
    assert_eq!(inner.store.active_count().unwrap(), 1);
    lease.request = correct;
    inner.finish(&lease, &Err("fixture error".into())).unwrap();
    assert_eq!(inner.store.get(&run.id).unwrap().status, "failed");
    assert_eq!(inner.store.active_count().unwrap(), 0);
    assert!(inner.request_cancel(&run.id).is_err());
}

#[test]
fn current_global_limit_and_revocations_override_old_task_admission() {
    let (_tmp, mut inner, project) = setup();
    let first = inner.create(submission(&project, "first", 2)).unwrap();
    let second = inner.create(submission(&project, "second", 2)).unwrap();
    let mut settings = inner.settings().unwrap();
    settings.concurrency = 1;
    inner.save_settings(&settings, 2).unwrap();
    let lease = inner.reserve(&first.id, first.revision, false).unwrap();
    assert!(
        inner
            .reserve(&second.id, second.revision, false)
            .unwrap_err()
            .contains("CAPACITY_FULL")
    );
    inner.finish(&lease, &Err("CANCELLED".into())).unwrap();
    let mut settings = inner.settings().unwrap();
    settings.planning_resource_id.clear();
    settings.review_resource_id.clear();
    settings.resources.clear();
    inner.save_settings(&settings, 3).unwrap();
    assert!(
        inner
            .reserve(&second.id, second.revision, false)
            .unwrap_err()
            .contains("RESOURCE_REVOKED")
    );
}

#[test]
fn explicit_recovery_is_single_use_and_closing_blocks_new_dispatches() {
    let (_tmp, mut inner, project) = setup();
    let run = inner.create(submission(&project, "recovery", 2)).unwrap();
    let partial = inner
        .mutate(&run.id, "partial", "fixture partial result", |r| {
            r.status = "partial".into();
            Ok(())
        })
        .unwrap();
    let lease = inner.reserve(&run.id, partial.revision, true).unwrap();
    assert_eq!(lease.run.recovery_count, 1);
    inner
        .finish(&lease, &Err("truncated again".into()))
        .unwrap();
    let current = inner
        .mutate(&run.id, "partial", "fixture partial", |r| {
            r.status = "partial".into();
            Ok(())
        })
        .unwrap();
    assert!(inner.reserve(&run.id, current.revision, true).is_err());
    let other = inner.create(submission(&project, "exit", 2)).unwrap();
    inner.closing = true;
    assert!(
        inner
            .reserve(&other.id, other.revision, false)
            .unwrap_err()
            .contains("APPLICATION_CLOSING")
    );
}
