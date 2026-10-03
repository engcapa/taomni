use super::engine;
use super::policy::{BackupPolicy, load_policy};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, ExitRequestApi, Manager};

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
pub fn start(app: &AppHandle) {
    app.manage(BackupCoordinator::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            run_backup(app.clone(), BackupTrigger::Periodic).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn run_backup(app: AppHandle, trigger: BackupTrigger) {
    let result = tauri::async_runtime::spawn_blocking(move || {
        engine::create_scheduled_backup(&app, trigger)
    })
    .await;
    match result {
        Ok(Ok(Some(result))) => {
            tracing::info!(target: "backup", ?trigger, path = %result.file_path, "Automatic backup completed");
        }
        Ok(Ok(None)) => {}
        Ok(Err(error)) => {
            tracing::error!(target: "backup", ?trigger, %error, "Automatic backup failed");
        }
        Err(error) => {
            tracing::error!(target: "backup", ?trigger, %error, "Automatic backup task failed");
        }
    }
}

/// Finish an on-exit backup on the blocking pool before allowing normal quit.
/// Tauri restarts cannot be prevented; they may be applying a staged restore.
pub fn handle_exit_request(app: &AppHandle, code: Option<i32>, api: &ExitRequestApi) {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        return;
    }
    let coordinator = app.state::<BackupCoordinator>();
    if coordinator.exit_finished.load(Ordering::SeqCst) {
        return;
    }
    if !is_backup_due(&load_policy(app), 0, BackupTrigger::Exit) {
        return;
    }
    api.prevent_exit();
    if coordinator.exit_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_backup(app.clone(), BackupTrigger::Exit).await;
        app.state::<BackupCoordinator>()
            .exit_finished
            .store(true, Ordering::SeqCst);
        app.exit(code.unwrap_or(0));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
