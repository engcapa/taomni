use super::policy::{BackupPolicy, load_policy};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const CHECK_INTERVAL: Duration = Duration::from_secs(60);
const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

#[derive(Default)]
pub struct BackupCoordinator {
    pub operation: Mutex<()>,
    exit_started: AtomicBool,
    exit_finished: AtomicBool,
}

#[derive(Clone, Copy, Debug)]
pub enum BackupTrigger {
    Periodic,
    Exit,
}

pub fn is_backup_due(policy: &BackupPolicy, now_ms: i64, trigger: BackupTrigger) -> bool {
    if !policy.auto_backup_enabled {
        return false;
    }
    let interval_ms = match (trigger, policy.frequency.as_str()) {
        (BackupTrigger::Exit, "on_exit") => return true,
        (BackupTrigger::Periodic, "daily") => DAY_MS,
        (BackupTrigger::Periodic, "weekly") => 7 * DAY_MS,
        _ => return false,
    };
    policy
        .last_backup_at
        .is_none_or(|last| now_ms.saturating_sub(last) >= interval_ms)
}

/// Check wall-clock time on every pass so a long-running or resumed app does
/// not depend on opening Settings, restarting, or an active renderer timer.
pub fn start(app: &AppHandle, cancel: tokio_util::sync::CancellationToken) {
    let app = app.clone();
    let owner = app.clone();
    app.state::<crate::runtime::ApplicationRuntime>()
        .tasks
        .spawn("backup-scheduler", async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = async {
                        run_backup(owner.clone(), BackupTrigger::Periodic).await;
                        super::jobs::scheduled(&owner, BackupTrigger::Periodic).await;
                        tokio::time::sleep(CHECK_INTERVAL).await;
                    } => {}
                }
            }
        });
}

async fn run_backup(app: AppHandle, trigger: BackupTrigger) {
    if let Err(error) = super::local_jobs::scheduled(&app, trigger).await {
        tracing::error!(target: "backup", ?trigger, %error, "Automatic backup failed");
    }
}

/// Called once by the shared graceful exit owner while stores still work.
/// Restart preserves the existing policy of not scheduling an on-exit backup.
pub(crate) async fn prepare_exit(app: &AppHandle, restarting: bool) {
    if restarting {
        return;
    }
    let coordinator = app.state::<BackupCoordinator>();
    if coordinator.exit_finished.load(Ordering::SeqCst)
        || !is_backup_due(&load_policy(app), 0, BackupTrigger::Exit)
    {
        return;
    }
    if coordinator.exit_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let attempt = ExitBackupAttempt(&coordinator);
    run_backup(app.clone(), BackupTrigger::Exit).await;
    super::jobs::scheduled(app, BackupTrigger::Exit).await;
    coordinator.exit_finished.store(true, Ordering::SeqCst);
    drop(attempt);
}

struct ExitBackupAttempt<'a>(&'a BackupCoordinator);
impl Drop for ExitBackupAttempt<'_> {
    fn drop(&mut self) {
        if !self.0.exit_finished.load(Ordering::SeqCst) {
            self.0.exit_started.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_exit_backup_can_retry_without_rerunning_a_completed_backup() {
        let coordinator = BackupCoordinator::default();
        coordinator.exit_started.store(true, Ordering::SeqCst);
        drop(ExitBackupAttempt(&coordinator));
        assert!(!coordinator.exit_started.load(Ordering::SeqCst));
        coordinator.exit_started.store(true, Ordering::SeqCst);
        coordinator.exit_finished.store(true, Ordering::SeqCst);
        drop(ExitBackupAttempt(&coordinator));
        assert!(coordinator.exit_started.load(Ordering::SeqCst));
    }

    #[test]
    fn daily_and_weekly_backups_become_due_without_restarting() {
        let last = 1_790_000_000_000;
        let mut policy = BackupPolicy {
            frequency: "daily".into(),
            last_backup_at: Some(last),
            ..BackupPolicy::default()
        };
        for (frequency, interval) in [("daily", DAY_MS), ("weekly", 7 * DAY_MS)] {
            policy.frequency = frequency.into();
            assert!(!is_backup_due(&policy, last, BackupTrigger::Periodic));
            assert!(!is_backup_due(
                &policy,
                last + interval - 1,
                BackupTrigger::Periodic
            ));
            assert!(is_backup_due(
                &policy,
                last + interval,
                BackupTrigger::Periodic
            ));
            // Resume after missed intervals creates one current snapshot.
            assert!(is_backup_due(
                &policy,
                last + 30 * DAY_MS,
                BackupTrigger::Periodic
            ));
            policy.last_backup_at = Some(last + 30 * DAY_MS);
            assert!(!is_backup_due(
                &policy,
                last + 30 * DAY_MS,
                BackupTrigger::Periodic
            ));
            policy.last_backup_at = Some(last);
        }
    }

    #[test]
    fn only_enabled_scheduled_frequencies_run_on_periodic_checks() {
        let mut policy = BackupPolicy::default();
        assert!(is_backup_due(&policy, DAY_MS, BackupTrigger::Periodic));
        policy.auto_backup_enabled = false;
        assert!(!is_backup_due(&policy, DAY_MS, BackupTrigger::Periodic));
        assert!(!is_backup_due(&policy, DAY_MS, BackupTrigger::Exit));
        policy.auto_backup_enabled = true;
        for frequency in ["on_exit", "unknown"] {
            policy.frequency = frequency.into();
            assert!(!is_backup_due(&policy, DAY_MS, BackupTrigger::Periodic));
        }
        assert!(!is_backup_due(&policy, DAY_MS, BackupTrigger::Exit));
        policy.frequency = "on_exit".into();
        policy.last_backup_at = Some(DAY_MS);
        assert!(is_backup_due(&policy, DAY_MS, BackupTrigger::Exit));
    }

    #[test]
    fn clock_rollback_does_not_trigger_repeated_backups() {
        let policy = BackupPolicy {
            frequency: "daily".into(),
            last_backup_at: Some(2 * DAY_MS),
            ..BackupPolicy::default()
        };
        assert!(!is_backup_due(&policy, DAY_MS, BackupTrigger::Periodic));
        assert!(is_backup_due(&policy, 3 * DAY_MS, BackupTrigger::Periodic));
    }
}
