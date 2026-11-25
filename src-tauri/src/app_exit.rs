//! One graceful exit at a time, shared by renderer and native recovery UI.
use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(crate) struct ExitGate {
    active: AtomicBool,
    committed: AtomicBool,
    exit_allowed: AtomicBool,
}

impl ExitGate {
    pub(crate) fn is_committed(&self) -> bool {
        self.committed.load(Ordering::Acquire)
    }
    pub(crate) fn allow_platform_exit(&self) {
        self.exit_allowed.store(true, Ordering::Release);
    }
    pub(crate) fn platform_exit_allowed(&self) -> bool {
        self.exit_allowed.load(Ordering::Acquire)
    }

    /// Plugin teardown can refuse before downloads/tasks/business owners stop.
    /// The committed worker calls this only while platform exit is still denied.
    pub(crate) fn refuse_teardown(&self) {
        assert!(
            !self.platform_exit_allowed(),
            "platform exit already allowed"
        );
        self.committed.store(false, Ordering::Release);
        self.active.store(false, Ordering::Release);
    }
    pub async fn run(
        &self,
        prepare: impl Future<Output = Result<(), String>>,
        commit: impl FnOnce(),
    ) -> Result<(), String> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "应用正在安全退出，请等待清理完成。".to_owned())?;
        let mut attempt = Attempt {
            gate: self,
            committed: false,
        };
        prepare.await?;
        // No Closing phase or process exit until every required cleanup succeeds.
        self.committed.store(true, Ordering::Release);
        attempt.committed = true;
        commit();
        Ok(())
    }
}

struct Attempt<'a> {
    gate: &'a ExitGate,
    committed: bool,
}
impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.gate.active.store(false, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        task::{Context, Poll, Waker},
    };

    fn ready<T>(future: impl Future<Output = T>) -> T {
        let mut future = std::pin::pin!(future);
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("expected immediate completion"),
        }
    }

    #[test]
    fn cleans_network_before_exit_and_commits_only_once() {
        let gate = ExitGate::default();
        let effects = RefCell::new(Vec::new());
        assert!(
            ready(gate.run(
                async {
                    effects.borrow_mut().push("cleanup");
                    Ok(())
                },
                || effects.borrow_mut().push("exit")
            ))
            .is_ok()
        );
        assert_eq!(*effects.borrow(), ["cleanup", "exit"]);
        assert!(gate.is_committed());
        assert!(!gate.platform_exit_allowed());
        gate.allow_platform_exit();
        assert!(gate.platform_exit_allowed());
        assert!(
            ready(gate.run(async { panic!("duplicate cleanup") }, || panic!(
                "duplicate exit"
            )))
            .is_err()
        );
    }

    #[test]
    fn failed_cleanup_preserves_app_and_allows_retry() {
        let gate = ExitGate::default();
        assert_eq!(
            ready(
                gate.run(async { Err("network still captured".into()) }, || panic!(
                    "must not exit"
                ))
            ),
            Err("network still captured".into())
        );
        assert!(!gate.is_committed());
        assert!(ready(gate.run(async { Ok(()) }, || {})).is_ok());
    }

    #[test]
    fn unconfirmed_plugin_teardown_does_not_allow_exit_and_can_be_retried() {
        let gate = ExitGate::default();
        assert!(ready(gate.run(async { Ok(()) }, || {})).is_ok());
        assert!(gate.is_committed());
        assert!(!gate.platform_exit_allowed());
        gate.refuse_teardown();
        assert!(!gate.is_committed());
        assert!(!gate.platform_exit_allowed());
        assert!(ready(gate.run(async { Ok(()) }, || {})).is_ok());
        assert!(gate.is_committed());
    }

    #[test]
    fn concurrent_and_cancelled_attempts_do_not_duplicate_or_wedge_exit() {
        let gate = ExitGate::default();
        {
            let pending = gate.run(std::future::pending(), || panic!("must not exit"));
            let mut pending = std::pin::pin!(pending);
            assert!(
                pending
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                    .is_pending()
            );
            assert!(ready(gate.run(async { panic!("concurrent cleanup") }, || {})).is_err());
        }
        assert!(ready(gate.run(async { Ok(()) }, || {})).is_ok());
    }
}
