//! Cancel approval waits before trying to change the signed module's lifecycle.

use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct StartGate(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    changing_module: bool,
    startup: Option<CancellationToken>,
}

impl StartGate {
    pub(super) fn check(&self) -> Result<(), String> {
        let state = self.0.lock().map_err(|error| error.to_string())?;
        if state.changing_module {
            return Err("SocksCap is stopping for a module change".into());
        }
        Ok(())
    }

    // The caller holds the capture operation lock for the permit's lifetime.
    pub(super) fn start(&self) -> Result<StartPermit<'_>, String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        if state.changing_module || state.startup.is_some() {
            return Err("SocksCap is changing capture state".into());
        }
        let token = CancellationToken::new();
        state.startup = Some(token.clone());
        Ok(StartPermit { gate: self, token })
    }

    pub(super) fn cancel_for_change(&self) -> Result<ModuleChangePermit, String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        if state.changing_module {
            return Err("A SocksCap module change is already in progress".into());
        }
        state.changing_module = true;
        if let Some(token) = &state.startup {
            token.cancel();
        }
        Ok(ModuleChangePermit(self.0.clone()))
    }
}

pub(super) struct StartPermit<'a> {
    gate: &'a StartGate,
    pub(super) token: CancellationToken,
}

impl Drop for StartPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.0.lock() {
            state.startup = None;
        }
    }
}

pub(crate) struct ModuleChangePermit(Arc<Mutex<State>>);

impl Drop for ModuleChangePermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            state.changing_module = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_change_cancels_pending_start_and_excludes_a_replacement() {
        let gate = StartGate::default();
        let startup = gate.start().unwrap();
        assert!(!startup.token.is_cancelled());
        let change = gate.cancel_for_change().unwrap();
        assert!(startup.token.is_cancelled());
        assert!(gate.check().is_err());
        assert!(gate.cancel_for_change().is_err());
        drop(startup);
        assert!(gate.start().is_err());
        drop(change);
        assert!(!gate.start().unwrap().token.is_cancelled());
    }
}
