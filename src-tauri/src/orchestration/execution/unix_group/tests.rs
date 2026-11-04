use std::{collections::VecDeque, io, time::Duration};

use super::state::*;
use super::{checked_group_id, classify_result};

#[derive(Default)]
struct Fake {
    signals: Vec<Signal>,
    observations: VecDeque<GroupState>,
    signal_results: VecDeque<Result<SignalResult, String>>,
    query_error: Option<String>,
}

impl Operations for Fake {
    fn signal(&mut self, signal: Signal) -> Result<SignalResult, String> {
        self.signals.push(signal);
        self.signal_results
            .pop_front()
            .unwrap_or(Ok(SignalResult::Delivered))
    }

    fn observe(&mut self) -> Result<GroupState, String> {
        if let Some(error) = &self.query_error {
            return Err(error.clone());
        }
        Ok(self.observations.pop_front().unwrap_or(GroupState::Live))
    }
}

fn cleanup() -> Cleanup {
    Cleanup::new(Duration::from_secs(3), Duration::from_secs(5))
}

fn zombie(pid: u32, start_ticks: u64) -> GroupState {
    GroupState::Zombies(vec![Member { pid, start_ticks }])
}

#[test]
fn esrch_is_positive_absence_but_eperm_and_other_signal_errors_are_unknown() {
    assert_eq!(classify_result(Ok(())).unwrap(), SignalResult::Delivered);
    assert_eq!(
        classify_result(Err(io::Error::from_raw_os_error(libc::ESRCH))).unwrap(),
        SignalResult::Gone
    );
    for code in [libc::EPERM, libc::EINVAL, libc::EIO] {
        let error = classify_result(Err(io::Error::from_raw_os_error(code))).unwrap_err();
        assert!(error.starts_with("WORKER_STOP_UNKNOWN:"));
    }
}

#[test]
fn invalid_group_ids_cannot_signal_every_process_or_overflow() {
    assert!(checked_group_id(0).is_err());
    assert!(checked_group_id(u32::MAX).is_err());
    assert!(checked_group_id(i32::MAX as u32 + 1).is_err());
    assert_eq!(checked_group_id(42).unwrap(), 42);
}

#[test]
fn missing_group_during_term_is_verified_without_observing_leader() {
    let mut fake = Fake {
        signal_results: [Ok(SignalResult::Gone)].into(),
        ..Default::default()
    };
    assert_eq!(
        cleanup().poll(&mut fake, Duration::ZERO).unwrap(),
        Progress::Complete
    );
    assert_eq!(fake.signals, [Signal::Terminate]);
}

#[test]
fn delivered_signal_is_not_proof_and_live_group_requires_sigkill_then_fresh_absence() {
    let mut fake = Fake {
        observations: [GroupState::Live, GroupState::Live, GroupState::Gone].into(),
        ..Default::default()
    };
    let mut cleanup = cleanup();
    assert_eq!(
        cleanup.poll(&mut fake, Duration::ZERO).unwrap(),
        Progress::Pending
    );
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(3)).unwrap(),
        Progress::Pending
    );
    assert_eq!(fake.signals, [Signal::Terminate, Signal::Kill]);
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(4)).unwrap(),
        Progress::Complete
    );
}

#[test]
fn cached_leader_exit_cannot_turn_persistently_live_members_into_success() {
    let mut fake = Fake::default();
    let mut cleanup = cleanup();
    assert_eq!(
        cleanup.poll(&mut fake, Duration::ZERO).unwrap(),
        Progress::Pending
    );
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(3)).unwrap(),
        Progress::Pending
    );
    let error = cleanup.poll(&mut fake, Duration::from_secs(8)).unwrap_err();
    assert!(error.starts_with("WORKER_STOP_UNKNOWN:"));
    assert_eq!(fake.signals, [Signal::Terminate, Signal::Kill]);
}

#[test]
fn failed_term_or_kill_is_unknown_even_if_leader_is_already_exited() {
    for results in [
        vec![Err("WORKER_STOP_UNKNOWN: EPERM".into())],
        vec![
            Ok(SignalResult::Delivered),
            Err("WORKER_STOP_UNKNOWN: EPERM".into()),
        ],
    ] {
        let mut fake = Fake {
            signal_results: results.into(),
            ..Default::default()
        };
        let mut cleanup = cleanup();
        let first = cleanup.poll(&mut fake, Duration::ZERO);
        let error = if first.is_err() {
            first.unwrap_err()
        } else {
            cleanup.poll(&mut fake, Duration::from_secs(3)).unwrap_err()
        };
        assert!(error.contains("EPERM"));
    }
}

#[test]
fn failed_membership_query_is_unknown_instead_of_empty() {
    let mut fake = Fake {
        query_error: Some("WORKER_STOP_UNKNOWN: membership unavailable".into()),
        ..Default::default()
    };
    assert!(
        cleanup()
            .poll(&mut fake, Duration::ZERO)
            .unwrap_err()
            .contains("membership unavailable")
    );
}

#[test]
fn zombie_only_group_requires_sigkill_and_two_matching_current_identity_scans() {
    let mut fake = Fake {
        observations: [
            zombie(7, 123),
            zombie(7, 123),
            zombie(7, 123),
            zombie(7, 123),
        ]
        .into(),
        ..Default::default()
    };
    let mut cleanup = cleanup();
    assert_eq!(
        cleanup.poll(&mut fake, Duration::ZERO).unwrap(),
        Progress::Pending
    );
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(3)).unwrap(),
        Progress::Pending
    );
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(4)).unwrap(),
        Progress::Pending
    );
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(5)).unwrap(),
        Progress::Complete
    );
    assert_eq!(fake.signals, [Signal::Terminate, Signal::Kill]);
}

#[test]
fn reused_pid_changed_start_time_and_empty_scan_are_not_stable_zombie_proof() {
    let mut fake = Fake {
        observations: [
            GroupState::Live,
            zombie(7, 123),
            zombie(7, 456),
            GroupState::Zombies(vec![]),
        ]
        .into(),
        ..Default::default()
    };
    let mut cleanup = cleanup();
    assert_eq!(
        cleanup.poll(&mut fake, Duration::ZERO).unwrap(),
        Progress::Pending
    );
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(3)).unwrap(),
        Progress::Pending
    );
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(4)).unwrap(),
        Progress::Pending
    );
    assert!(cleanup.poll(&mut fake, Duration::from_secs(8)).is_err());
}

#[test]
fn live_member_between_zombie_scans_resets_positive_dead_evidence() {
    let mut fake = Fake {
        observations: [
            GroupState::Live,
            zombie(7, 123),
            GroupState::Live,
            zombie(7, 123),
            zombie(7, 123),
        ]
        .into(),
        ..Default::default()
    };
    let mut cleanup = cleanup();
    for elapsed in [0, 3, 4, 5] {
        assert_eq!(
            cleanup
                .poll(&mut fake, Duration::from_secs(elapsed))
                .unwrap(),
            Progress::Pending
        );
    }
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(6)).unwrap(),
        Progress::Complete
    );
}

#[test]
fn deadline_still_observes_group_gone_without_inventing_timeout() {
    let mut fake = Fake {
        observations: [GroupState::Live, GroupState::Gone].into(),
        ..Default::default()
    };
    let mut cleanup = cleanup();
    assert_eq!(
        cleanup.poll(&mut fake, Duration::ZERO).unwrap(),
        Progress::Pending
    );
    assert_eq!(
        cleanup.poll(&mut fake, Duration::from_secs(20)).unwrap(),
        Progress::Complete
    );
}
