//! One graceful exit at a time, shared by renderer and native recovery UI.
use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(crate) struct ExitGate(AtomicBool);

impl ExitGate {
    pub async fn run(
        &self,
        prepare: impl Future<Output = Result<(), String>>,
        commit: impl FnOnce(),
    ) -> Result<(), String> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "应用正在安全退出，请等待清理完成。".to_owned())?;
        let mut attempt = Attempt {
            gate: self,
            committed: false,
        };
        prepare.await?;
        // No Closing phase or process exit until every required cleanup succeeds.
        commit();
        attempt.committed = true;
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
            self.gate.0.store(false, Ordering::Release);
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
        assert!(ready(gate.run(async { Ok(()) }, || {})).is_ok());
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
