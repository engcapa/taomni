//! Sockscap engine orchestrator — state machine + capture adapter hooks.
//!
//! Design plan §4.1 / §9. Start runs preflight then asks the platform
//! CaptureAdapter to install rules. Until Phase 0 gates close, adapters refuse
//! install without mutating the system.

use std::sync::Mutex;

use super::preflight::{run_preflight, PreflightReport};
use super::types::{EngineState, EngineStatus, RoutingProfileDraft};

/// In-process Sockscap engine handle.
pub struct SockscapEngine {
    inner: Mutex<EngineInner>,
}

struct EngineInner {
    status: EngineStatus,
    /// Last preflight report (if any), kept for diagnostics.
    last_preflight: Option<PreflightReport>,
}

impl Default for SockscapEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SockscapEngine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(EngineInner {
                status: EngineStatus::default(),
                last_preflight: None,
            }),
        }
    }

    pub fn status(&self) -> EngineStatus {
        self.inner
            .lock()
            .map(|g| g.status.clone())
            .unwrap_or_else(|e| e.into_inner().status.clone())
    }

    pub fn last_preflight(&self) -> Option<PreflightReport> {
        self.inner
            .lock()
            .map(|g| g.last_preflight.clone())
            .unwrap_or_else(|e| e.into_inner().last_preflight.clone())
    }

    /// Attempt to start the engine. Phase 0 always refuses because the capture
    /// plane is not implemented; the transition path and error surface are real.
    pub fn start(&self, profiles: &[RoutingProfileDraft]) -> Result<EngineStatus, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "sockscap engine lock poisoned".to_string())?;

        match guard.status.state {
            EngineState::Preparing | EngineState::Active | EngineState::Stopping => {
                return Err(format!(
                    "cannot start while engine is in state {:?}",
                    guard.status.state
                ));
            }
            EngineState::RecoveryRequired => {
                return Err(
                    "engine requires recovery before start; call sockscap_recover first".into(),
                );
            }
            EngineState::Disabled | EngineState::Degraded | EngineState::UserActionRequired => {}
        }

        guard.status.state = EngineState::Preparing;
        guard.status.message = "Running preflight checks".into();
        guard.status.last_error = None;

        let preflight = run_preflight(profiles);
        guard.last_preflight = Some(preflight.clone());

        if !preflight.ok {
            let msg = preflight
                .findings
                .iter()
                .filter(|f| {
                    matches!(
                        f.severity,
                        super::preflight::PreflightSeverity::Error
                    )
                })
                .map(|f| f.message.clone())
                .collect::<Vec<_>>()
                .join("; ");
            guard.status.state = EngineState::Disabled;
            guard.status.message = "Preflight failed".into();
            guard.status.last_error = Some(msg.clone());
            guard.status.capture_active = false;
            guard.status.active_profile_ids.clear();
            return Err(format!("sockscap preflight failed: {msg}"));
        }

        // Capture adapter install (Phases 5–7). Adapters currently refuse with
        // mutated_system=false until platform spikes close the Phase 0 gate.
        drop(guard);
        let plan = super::capture::CapturePlan {
            profiles: profiles.to_vec(),
            bypass_hosts: vec![
                "127.0.0.1".into(),
                "::1".into(),
                "localhost".into(),
            ],
        };
        let adapter = super::capture::current_adapter();
        let install = tauri::async_runtime::block_on(adapter.install(&plan));
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "sockscap engine lock poisoned".to_string())?;
        if !install.ok {
            guard.status.state = EngineState::Disabled;
            guard.status.message = "Capture adapter refused install".into();
            guard.status.last_error = Some(install.message.clone());
            guard.status.capture_active = false;
            guard.status.active_profile_ids.clear();
            return Err(format!("sockscap capture install failed: {}", install.message));
        }
        guard.status.state = EngineState::Active;
        guard.status.message = "Sockscap is active".into();
        guard.status.capture_active = install.mutated_system;
        guard.status.active_profile_ids = profiles
            .iter()
            .filter(|p| p.enabled)
            .map(|p| p.id.clone())
            .collect();
        Ok(guard.status.clone())
    }

    /// Stop the engine. Idempotent when already disabled.
    pub fn stop(&self) -> Result<EngineStatus, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "sockscap engine lock poisoned".to_string())?;

        match guard.status.state {
            EngineState::Disabled => {
                guard.status.message = "Sockscap engine is disabled".into();
                return Ok(guard.status.clone());
            }
            EngineState::Stopping => {
                return Err("stop already in progress".into());
            }
            _ => {}
        }

        guard.status.state = EngineState::Stopping;
        guard.status.message = "Stopping Sockscap".into();
        drop(guard);

        let adapter = super::capture::current_adapter();
        let uninstall = tauri::async_runtime::block_on(adapter.uninstall());
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "sockscap engine lock poisoned".to_string())?;
        if !uninstall.ok {
            guard.status.state = EngineState::RecoveryRequired;
            guard.status.recovery_required = true;
            guard.status.message = "Stop failed; recovery required".into();
            guard.status.last_error = Some(uninstall.message);
            return Ok(guard.status.clone());
        }

        guard.status.state = EngineState::Disabled;
        guard.status.message = "Sockscap engine is disabled".into();
        guard.status.capture_active = false;
        guard.status.active_profile_ids.clear();
        guard.status.last_error = None;
        Ok(guard.status.clone())
    }

    /// Best-effort recovery path. Phase 0 has no system state to repair; it
    /// clears RecoveryRequired / errors and returns to Disabled.
    pub fn recover(&self) -> Result<EngineStatus, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "sockscap engine lock poisoned".to_string())?;

        drop(guard);
        let adapter = super::capture::current_adapter();
        let uninstall = tauri::async_runtime::block_on(adapter.uninstall());
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "sockscap engine lock poisoned".to_string())?;
        if !uninstall.ok {
            guard.status.state = EngineState::RecoveryRequired;
            guard.status.recovery_required = true;
            guard.status.message = "Recovery failed".into();
            guard.status.last_error = Some(uninstall.message);
            return Ok(guard.status.clone());
        }
        guard.status.state = EngineState::Disabled;
        guard.status.message = format!("Recovery complete: {}", uninstall.message);
        guard.status.recovery_required = false;
        guard.status.capture_active = false;
        guard.status.active_profile_ids.clear();
        guard.status.last_error = None;
        Ok(guard.status.clone())
    }

    /// Mark the engine as needing recovery (used by helper heartbeat loss later).
    #[allow(dead_code)]
    pub fn mark_recovery_required(&self, reason: impl Into<String>) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.status.state = EngineState::RecoveryRequired;
            guard.status.recovery_required = true;
            guard.status.capture_active = false;
            let reason = reason.into();
            guard.status.message = "Recovery required".into();
            guard.status.last_error = Some(reason);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::{EgressKind, ProfileScope, RouteAction};

    fn profile() -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: "p1".into(),
            name: "Test".into(),
            enabled: true,
            scope: ProfileScope::Global,
            egress_kind: Some(EgressKind::ProxySession),
            egress_ref_id: Some("px".into()),
            default_action: RouteAction::Proxy,
            ..Default::default()
        }
    }

    #[test]
    fn start_fails_in_phase0_and_stays_disabled() {
        let engine = SockscapEngine::new();
        let err = engine.start(&[profile()]).unwrap_err();
        assert!(err.contains("preflight"));
        let status = engine.status();
        assert_eq!(status.state, EngineState::Disabled);
        assert!(!status.capture_active);
        assert!(engine.last_preflight().is_some());
    }

    #[test]
    fn stop_is_idempotent_when_disabled() {
        let engine = SockscapEngine::new();
        let status = engine.stop().unwrap();
        assert_eq!(status.state, EngineState::Disabled);
    }

    #[test]
    fn recover_clears_recovery_flag() {
        let engine = SockscapEngine::new();
        engine.mark_recovery_required("test leftover rules");
        assert_eq!(engine.status().state, EngineState::RecoveryRequired);
        let status = engine.recover().unwrap();
        assert_eq!(status.state, EngineState::Disabled);
        assert!(!status.recovery_required);
    }
}
