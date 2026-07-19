//! Owned, bounded runtime for decoded TCP flows.
//!
//! Platform capture code terminates at [`FlowIngress`]. This module performs
//! the one shared profile selection, invokes the per-profile [`FlowEngine`],
//! relays bytes with cancellation/half-close semantics, and owns every task
//! until shutdown. It intentionally does not enable any platform adapter in
//! the product orchestrator yet.

use std::collections::{HashMap, HashSet};
use std::num::{NonZeroU64, NonZeroUsize};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::{Id as TaskId, JoinError, JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::engine::{FlowContext, FlowEngine, copy_bidirectional_counted};
use super::ingress::{
    FlowIngress, IngressError, IngressTcpControl, IngressTcpFlow, ProfileBinding,
    TcpCloseDisposition,
};
use crate::sockscap::egress::EgressRuntime;
use crate::sockscap::policy::selector::{ProfileSelector, ProfileSelectorError};
use crate::sockscap::types::{CapturePlatform, RouteAction, RoutingProfileDraft};

pub const MAX_ACTIVE_FLOWS: usize = 65_536;
const MIN_SHUTDOWN_GRACE: Duration = Duration::from_millis(100);
const MAX_SHUTDOWN_GRACE: Duration = Duration::from_secs(60);
const CONTROL_CLOSE_TIMEOUT: Duration = Duration::from_millis(500);
const MIN_CONTROL_CLOSE_CONCURRENCY: usize = 16;
const MAX_CONTROL_CLOSE_CONCURRENCY: usize = 1_024;

/// Validated limits and snapshot identity for one single-use runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowRuntimeConfig {
    platform: CapturePlatform,
    generation: NonZeroU64,
    config_revision: NonZeroU64,
    max_active_flows: NonZeroUsize,
    shutdown_grace: Duration,
}

impl FlowRuntimeConfig {
    pub fn new(
        platform: CapturePlatform,
        generation: u64,
        config_revision: u64,
        max_active_flows: usize,
        shutdown_grace: Duration,
    ) -> Result<Self, FlowRuntimeError> {
        if platform == CapturePlatform::Unknown {
            return Err(FlowRuntimeError::InvalidConfig);
        }
        let generation = NonZeroU64::new(generation).ok_or(FlowRuntimeError::InvalidConfig)?;
        let config_revision =
            NonZeroU64::new(config_revision).ok_or(FlowRuntimeError::InvalidConfig)?;
        let max_active_flows =
            NonZeroUsize::new(max_active_flows).ok_or(FlowRuntimeError::InvalidConfig)?;
        if max_active_flows.get() > MAX_ACTIVE_FLOWS
            || shutdown_grace < MIN_SHUTDOWN_GRACE
            || shutdown_grace > MAX_SHUTDOWN_GRACE
        {
            return Err(FlowRuntimeError::InvalidConfig);
        }
        Ok(Self {
            platform,
            generation,
            config_revision,
            max_active_flows,
            shutdown_grace,
        })
    }

    pub fn platform(self) -> CapturePlatform {
        self.platform
    }

    pub fn generation(self) -> u64 {
        self.generation.get()
    }

    pub fn config_revision(self) -> u64 {
        self.config_revision.get()
    }

    pub fn max_active_flows(self) -> usize {
        self.max_active_flows.get()
    }

    pub fn shutdown_grace(self) -> Duration {
        self.shutdown_grace
    }
}

/// Owner retained for as long as its profile engines can open connections.
/// SSH egresses use this hook to close shared control connections after all
/// flow tasks have drained.
#[async_trait]
pub trait FlowRuntimeOwner: Send + Sync {
    /// Stable non-secret saved egress id this owner keeps alive.
    fn binding_id(&self) -> &str;

    async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED: live egress owner did not shut down cleanly")]
pub struct FlowRuntimeOwnerError;

#[async_trait]
impl FlowRuntimeOwner for EgressRuntime {
    fn binding_id(&self) -> &str {
        &self.summary().id
    }

    async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError> {
        EgressRuntime::shutdown(self).await;
        Ok(())
    }
}

/// One immutable profile, its policy/egress engine, and optional live-resource
/// owner. The owner prevents a connector from outliving its SSH pool/lifecycle.
pub struct ProfileRuntime {
    profile: Arc<RoutingProfileDraft>,
    engine: Arc<FlowEngine>,
    owner: Option<Arc<dyn FlowRuntimeOwner>>,
}

impl ProfileRuntime {
    pub fn new(profile: RoutingProfileDraft, engine: Arc<FlowEngine>) -> Self {
        Self {
            profile: Arc::new(profile),
            engine,
            owner: None,
        }
    }

    pub fn with_owner(
        profile: RoutingProfileDraft,
        engine: Arc<FlowEngine>,
        owner: Arc<dyn FlowRuntimeOwner>,
    ) -> Self {
        Self {
            profile: Arc::new(profile),
            engine,
            owner: Some(owner),
        }
    }
}

impl std::fmt::Debug for ProfileRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProfileRuntime")
            .field("profile_id", &self.profile.id)
            .field("has_owner", &self.owner.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FlowRuntimeError {
    #[error("FLOW_RUNTIME_CONFIG_INVALID: runtime limits or snapshot identity are invalid")]
    InvalidConfig,
    #[error("FLOW_RUNTIME_PROFILE_DUPLICATE: profile runtimes are not unique")]
    DuplicateProfile,
    #[error("FLOW_RUNTIME_PROFILE_DISABLED: runtime contains a disabled profile")]
    DisabledProfile,
    #[error("FLOW_RUNTIME_ENGINE_PROFILE_MISMATCH: engine does not match its profile")]
    EngineProfileMismatch,
    #[error("FLOW_RUNTIME_ENGINE_SNAPSHOT_MISMATCH: engine was built from another config snapshot")]
    EngineSnapshotMismatch,
    #[error("FLOW_RUNTIME_OWNER_REQUIRED: configured live egress has no lifecycle owner")]
    OwnerRequired,
    #[error("FLOW_RUNTIME_OWNER_BINDING_MISMATCH: lifecycle owner does not match saved egress")]
    OwnerBindingMismatch,
    #[error("FLOW_RUNTIME_PROFILE_SELECTOR_INVALID: {0}")]
    ProfileSelector(ProfileSelectorError),
    #[error("FLOW_RUNTIME_ALREADY_STARTED: runtime instances are single-use")]
    AlreadyStarted,
    #[error("FLOW_RUNTIME_ASYNC_RUNTIME_UNAVAILABLE: no Tokio runtime is available")]
    AsyncRuntimeUnavailable,
    #[error("FLOW_RUNTIME_SUPERVISOR_FAILED: runtime supervisor terminated unexpectedly")]
    SupervisorFailed,
    #[error("FLOW_RUNTIME_OWNER_SHUTDOWN_FAILED: one or more live egress owners failed to stop")]
    OwnerShutdownFailed,
    #[error("FLOW_RUNTIME_INGRESS_FAILED: {code}")]
    Ingress { code: &'static str },
}

/// Privacy-bounded counters; no tuple, hostname, application identity, or
/// payload-derived value enters this structure.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRuntimeSnapshot {
    pub admitted: u64,
    pub completed: u64,
    pub policy_blocked: u64,
    pub rejected_overloaded: u64,
    pub rejected_stale: u64,
    pub rejected_invalid: u64,
    pub rejected_duplicate: u64,
    pub rejected_no_profile: u64,
    pub cancelled: u64,
    pub failed: u64,
    pub task_panics: u64,
    pub control_close_failures: u64,
    pub owner_shutdown_failures: u64,
    pub forced_drops: u64,
    pub invariant_violations: u64,
    pub active: usize,
    pub peak_active: usize,
    pub bytes_to_egress: u64,
    pub bytes_to_ingress: u64,
}

struct FlowRuntimeMetrics {
    snapshot: Mutex<FlowRuntimeSnapshot>,
}

impl Default for FlowRuntimeMetrics {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(FlowRuntimeSnapshot::default()),
        }
    }
}

impl FlowRuntimeMetrics {
    fn admitted(&self) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.admitted += 1;
        snapshot.active += 1;
        snapshot.peak_active = snapshot.peak_active.max(snapshot.active);
    }

    fn rejected(&self, disposition: TcpCloseDisposition) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match disposition {
            TcpCloseDisposition::Overloaded => snapshot.rejected_overloaded += 1,
            TcpCloseDisposition::StaleGeneration => snapshot.rejected_stale += 1,
            TcpCloseDisposition::InvalidDescriptor => snapshot.rejected_invalid += 1,
            TcpCloseDisposition::DuplicateFlow => snapshot.rejected_duplicate += 1,
            TcpCloseDisposition::NoProfile => snapshot.rejected_no_profile += 1,
            _ => snapshot.failed += 1,
        }
    }

    fn completed(&self, completion: &TaskCompletion) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if snapshot.active == 0 {
            snapshot.invariant_violations += 1;
        } else {
            snapshot.active -= 1;
        }
        snapshot.bytes_to_egress += completion.bytes_to_egress;
        snapshot.bytes_to_ingress += completion.bytes_to_ingress;
        match completion.disposition {
            TcpCloseDisposition::Finished => {
                snapshot.completed += 1;
            }
            TcpCloseDisposition::PolicyBlocked => {
                snapshot.policy_blocked += 1;
            }
            TcpCloseDisposition::Cancelled => {
                snapshot.cancelled += 1;
            }
            _ => {
                snapshot.failed += 1;
            }
        }
        if completion.panicked {
            snapshot.task_panics += 1;
        }
        if completion.close_failed {
            snapshot.control_close_failures += 1;
        }
    }

    fn rejected_close(&self, outcome: CloseOutcome) {
        if outcome.failed {
            let mut snapshot = self
                .snapshot
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            snapshot.control_close_failures += 1;
            if outcome.panicked {
                snapshot.task_panics += 1;
            }
        }
    }

    fn owner_shutdown_failures(&self, count: usize) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.owner_shutdown_failures += count as u64;
    }

    fn forced_drops(&self, count: usize) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.forced_drops += count as u64;
    }

    fn invariant_violation(&self) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        snapshot.invariant_violations += 1;
    }

    fn snapshot(&self) -> FlowRuntimeSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

pub struct FlowRuntime {
    config: FlowRuntimeConfig,
    selector: ProfileSelector,
    engines: HashMap<String, Arc<FlowEngine>>,
    owners: Vec<Arc<dyn FlowRuntimeOwner>>,
    admission: Arc<Semaphore>,
    cancellation: CancellationToken,
    metrics: Arc<FlowRuntimeMetrics>,
    started: AtomicBool,
}

impl FlowRuntime {
    pub fn new(
        config: FlowRuntimeConfig,
        profiles: Vec<ProfileRuntime>,
    ) -> Result<Self, FlowRuntimeError> {
        let mut ids = HashSet::new();
        let mut engines = HashMap::new();
        let mut immutable_profiles = Vec::new();
        let mut owners: Vec<Arc<dyn FlowRuntimeOwner>> = Vec::new();

        for runtime in profiles {
            if !ids.insert(runtime.profile.id.clone()) {
                return Err(FlowRuntimeError::DuplicateProfile);
            }
            if !runtime.profile.enabled {
                return Err(FlowRuntimeError::DisabledProfile);
            }
            if runtime.engine.matcher.profile_id != runtime.profile.id {
                return Err(FlowRuntimeError::EngineProfileMismatch);
            }
            if !runtime
                .engine
                .snapshot()
                .matches_profile(config.config_revision(), &runtime.profile)
            {
                return Err(FlowRuntimeError::EngineSnapshotMismatch);
            }
            if runtime.engine.matcher.default_action != runtime.profile.default_action
                || runtime.engine.matcher.unknown_domain_action
                    != runtime.profile.unknown_domain_action
            {
                return Err(FlowRuntimeError::EngineProfileMismatch);
            }
            if runtime.profile.egress_kind.is_some() {
                let expected_binding = runtime
                    .profile
                    .egress_ref_id
                    .as_deref()
                    .ok_or(FlowRuntimeError::OwnerBindingMismatch)?;
                let owner = runtime
                    .owner
                    .as_ref()
                    .ok_or(FlowRuntimeError::OwnerRequired)?;
                if owner.binding_id() != expected_binding {
                    return Err(FlowRuntimeError::OwnerBindingMismatch);
                }
            }
            if let Some(owner) = runtime.owner
                && !owners.iter().any(|current| Arc::ptr_eq(current, &owner))
            {
                owners.push(owner);
            }
            engines.insert(runtime.profile.id.clone(), runtime.engine);
            immutable_profiles.push(runtime.profile);
        }

        let selector = ProfileSelector::from_immutable_profiles(immutable_profiles)
            .map_err(FlowRuntimeError::ProfileSelector)?;
        Ok(Self {
            config,
            selector,
            engines,
            owners,
            admission: Arc::new(Semaphore::new(config.max_active_flows())),
            cancellation: CancellationToken::new(),
            metrics: Arc::new(FlowRuntimeMetrics::default()),
            started: AtomicBool::new(false),
        })
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn snapshot(&self) -> FlowRuntimeSnapshot {
        self.metrics.snapshot()
    }

    /// Start an owned supervisor. Dropping the returned handle requests a
    /// bounded shutdown but never aborts the supervisor cleanup task.
    pub fn start(
        self: &Arc<Self>,
        ingress: Arc<dyn FlowIngress>,
    ) -> Result<FlowRuntimeHandle, FlowRuntimeError> {
        let async_runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| FlowRuntimeError::AsyncRuntimeUnavailable)?;
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(FlowRuntimeError::AlreadyStarted);
        }

        let runtime = Arc::clone(self);
        let supervisor = async_runtime.spawn(async move { runtime.supervise(ingress).await });
        Ok(FlowRuntimeHandle {
            cancellation: self.cancellation.clone(),
            supervisor: Some(supervisor),
        })
    }

    async fn supervise(
        self: Arc<Self>,
        ingress: Arc<dyn FlowIngress>,
    ) -> Result<FlowRuntimeSnapshot, FlowRuntimeError> {
        let mut state = RuntimeState::new(self.config.max_active_flows());
        let stop_reason = match AssertUnwindSafe(self.admission_loop(&ingress, &mut state))
            .catch_unwind()
            .await
        {
            Ok(reason) => reason,
            Err(_) => StopReason::SupervisorPanic,
        };

        let owner_failures = self.cleanup(&mut state, stop_reason).await;
        if owner_failures > 0 && matches!(stop_reason, StopReason::Eof | StopReason::Cancelled) {
            return Err(FlowRuntimeError::OwnerShutdownFailed);
        }
        match stop_reason {
            StopReason::Ingress(error) => Err(error),
            StopReason::SupervisorPanic => Err(FlowRuntimeError::SupervisorFailed),
            StopReason::Eof | StopReason::Cancelled => Ok(self.metrics.snapshot()),
        }
    }

    async fn admission_loop(
        &self,
        ingress: &Arc<dyn FlowIngress>,
        state: &mut RuntimeState,
    ) -> StopReason {
        // Keep one accept future alive across unrelated task completions. The
        // FlowIngress contract additionally requires cancellation safety when
        // the future is dropped during terminal shutdown.
        let mut accepted = ingress.accept_tcp();

        loop {
            tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return StopReason::Cancelled,
                completion = state.flow_tasks.join_next_with_id(), if !state.flow_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_flow_join(result, state);
                    }
                }
                completion = state.close_tasks.join_next(), if !state.close_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_close_join(result);
                    }
                }
                result = &mut accepted => {
                    match result {
                        Ok(Some(flow)) => self.admit(flow, state).await,
                        Ok(None) => return StopReason::Eof,
                        Err(error) => {
                            return StopReason::Ingress(FlowRuntimeError::Ingress {
                                code: error.code(),
                            });
                        }
                    }
                    accepted = ingress.accept_tcp();
                }
            }
        }
    }

    async fn admit(&self, flow: IngressTcpFlow, state: &mut RuntimeState) {
        let descriptor = &flow.descriptor;
        if let Err(error) = descriptor.validate_for(self.config.generation()) {
            let disposition = if matches!(error, IngressError::StaleGeneration { .. }) {
                TcpCloseDisposition::StaleGeneration
            } else {
                TcpCloseDisposition::InvalidDescriptor
            };
            self.reject(flow, disposition, state).await;
            return;
        }
        if descriptor.platform != self.config.platform() {
            self.reject(flow, TcpCloseDisposition::InvalidDescriptor, state)
                .await;
            return;
        }
        if let ProfileBinding::TrustedQueue {
            config_revision, ..
        } = &descriptor.profile_binding
            && *config_revision != self.config.config_revision()
        {
            self.reject(flow, TcpCloseDisposition::StaleGeneration, state)
                .await;
            return;
        }
        if state.active_flow_ids.contains(&descriptor.flow_id) {
            self.reject(flow, TcpCloseDisposition::DuplicateFlow, state)
                .await;
            return;
        }

        let input = descriptor.profile_selection_input();
        let selection = match self.selector.select(&input) {
            Ok(selection) => selection,
            Err(_) => {
                self.reject(flow, TcpCloseDisposition::NoProfile, state)
                    .await;
                return;
            }
        };
        let Some(engine) = self.engines.get(selection.profile_id()).cloned() else {
            self.reject(flow, TcpCloseDisposition::NoProfile, state)
                .await;
            return;
        };
        let context = match FlowContext::try_from(descriptor) {
            Ok(context) => context,
            Err(_) => {
                self.reject(flow, TcpCloseDisposition::InvalidDescriptor, state)
                    .await;
                return;
            }
        };
        let permit = match self.admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.reject(flow, TcpCloseDisposition::Overloaded, state)
                    .await;
                return;
            }
        };

        let flow_id = descriptor.flow_id;
        let close = Arc::new(CloseOnce::new(flow.control.clone()));
        let cancellation = self.cancellation.child_token();
        let panic_close = close.clone();
        let active_close = close.clone();
        let abort_handle = state.flow_tasks.spawn(async move {
            match AssertUnwindSafe(run_tcp_flow(
                flow,
                context,
                engine,
                cancellation,
                permit,
                close,
            ))
            .catch_unwind()
            .await
            {
                Ok(completion) => completion,
                Err(_) => task_completion_from_close(
                    TcpCloseDisposition::RuntimeFailure,
                    0,
                    0,
                    true,
                    panic_close.close(TcpCloseDisposition::RuntimeFailure).await,
                ),
            }
        });
        let task_id = abort_handle.id();
        if !state.active_flow_ids.insert(flow_id)
            || state
                .active_by_task
                .insert(
                    task_id,
                    ActiveRecord {
                        flow_id,
                        close: active_close,
                    },
                )
                .is_some()
        {
            self.metrics.invariant_violation();
        }
        self.metrics.admitted();
    }

    async fn reject(
        &self,
        flow: IngressTcpFlow,
        disposition: TcpCloseDisposition,
        state: &mut RuntimeState,
    ) {
        self.metrics.rejected(disposition);
        let IngressTcpFlow {
            stream, control, ..
        } = flow;
        drop(stream);
        if state.close_tasks.len() >= state.max_close_tasks
            && let Some(result) = state.close_tasks.join_next().await
        {
            self.finish_close_join(result);
        }
        let close = Arc::new(CloseOnce::new(control));
        state
            .close_tasks
            .spawn(async move { close.close(disposition).await });
    }

    fn finish_flow_join(
        &self,
        result: Result<(TaskId, TaskCompletion), JoinError>,
        state: &mut RuntimeState,
    ) {
        let (task_id, completion) = match result {
            Ok((task_id, completion)) => (task_id, Some(completion)),
            Err(error) => {
                let task_id = error.id();
                let panicked = error.is_panic();
                let disposition = if panicked {
                    TcpCloseDisposition::RuntimeFailure
                } else {
                    TcpCloseDisposition::Cancelled
                };
                let Some(active) = self.take_active(task_id, state) else {
                    self.metrics.invariant_violation();
                    return;
                };
                state.pending_finalization.push(PendingFinalization {
                    active,
                    disposition,
                    panicked,
                });
                return;
            }
        };
        let Some(active) = self.take_active(task_id, state) else {
            self.metrics.invariant_violation();
            return;
        };
        if active.close.state() == CLOSE_OPEN {
            self.metrics.invariant_violation();
        }
        self.metrics
            .completed(&completion.expect("completion is present"));
    }

    fn take_active(&self, task_id: TaskId, state: &mut RuntimeState) -> Option<ActiveRecord> {
        let active = state.active_by_task.remove(&task_id)?;
        if !state.active_flow_ids.remove(&active.flow_id) {
            self.metrics.invariant_violation();
        }
        Some(active)
    }

    fn finish_close_join(&self, result: Result<CloseOutcome, JoinError>) {
        match result {
            Ok(outcome) => self.metrics.rejected_close(outcome),
            Err(_) => {
                self.metrics.rejected_close(CloseOutcome {
                    failed: true,
                    panicked: true,
                });
            }
        }
    }

    async fn cleanup(&self, state: &mut RuntimeState, reason: StopReason) -> usize {
        let started = Instant::now();
        let grace = self.config.shutdown_grace();
        let graceful_deadline = started + grace.mul_f64(0.50);
        let abort_deadline = started + grace.mul_f64(0.70);
        let close_deadline = started + grace.mul_f64(0.85);
        let total_deadline = started + grace;

        if reason == StopReason::Eof {
            self.drain_flow_tasks_until(state, graceful_deadline).await;
        }
        if !state.flow_tasks.is_empty() || reason != StopReason::Eof {
            self.cancellation.cancel();
            self.drain_flow_tasks_until(state, abort_deadline).await;
        }

        if !state.flow_tasks.is_empty() {
            state.flow_tasks.abort_all();
            while let Some(result) = state.flow_tasks.try_join_next_with_id() {
                self.finish_flow_join(result, state);
            }
            // Aborted Tokio tasks become ready promptly, but keep the absolute
            // deadline authoritative even if a foreign future misbehaves.
            while !state.flow_tasks.is_empty() && Instant::now() < close_deadline {
                let result =
                    tokio::time::timeout_at(close_deadline, state.flow_tasks.join_next_with_id())
                        .await;
                match result {
                    Ok(Some(result)) => self.finish_flow_join(result, state),
                    Ok(None) | Err(_) => break,
                }
            }
        }

        // Any task that could not be joined still has an owned active record.
        // Its task is aborted by JoinSet drop; finalization below is at-most-once
        // and consumes only the remaining shared deadline.
        for (_, active) in state.active_by_task.drain() {
            state.active_flow_ids.remove(&active.flow_id);
            state.pending_finalization.push(PendingFinalization {
                active,
                disposition: TcpCloseDisposition::Cancelled,
                panicked: false,
            });
        }
        self.finalize_pending_until(state, close_deadline).await;
        self.drain_rejected_closes_until(state, close_deadline)
            .await;
        self.cancellation.cancel();

        let owner_failures = self.shutdown_owners_until(total_deadline).await;
        self.metrics.owner_shutdown_failures(owner_failures);
        if !state.active_flow_ids.is_empty() {
            self.metrics.invariant_violation();
            state.active_flow_ids.clear();
        }
        owner_failures
    }

    async fn drain_flow_tasks_until(&self, state: &mut RuntimeState, deadline: Instant) {
        while !state.flow_tasks.is_empty() && Instant::now() < deadline {
            tokio::select! {
                completion = state.flow_tasks.join_next_with_id() => {
                    if let Some(result) = completion {
                        self.finish_flow_join(result, state);
                    }
                }
                completion = state.close_tasks.join_next(), if !state.close_tasks.is_empty() => {
                    if let Some(result) = completion {
                        self.finish_close_join(result);
                    }
                }
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }
    }

    async fn finalize_pending_until(&self, state: &mut RuntimeState, deadline: Instant) {
        let mut next_id = 0_u64;
        let mut metadata = HashMap::new();
        let mut futures: FuturesUnordered<BoxFuture<'static, (u64, TaskCompletion)>> =
            FuturesUnordered::new();
        for pending in state.pending_finalization.drain(..) {
            let id = next_id;
            next_id += 1;
            metadata.insert(id, (pending.disposition, pending.panicked));
            futures.push(
                async move {
                    let outcome = pending.active.close.close(pending.disposition).await;
                    (
                        id,
                        task_completion_from_close(
                            pending.disposition,
                            0,
                            0,
                            pending.panicked,
                            outcome,
                        ),
                    )
                }
                .boxed(),
            );
        }

        while !futures.is_empty() && Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, futures.next()).await {
                Ok(Some((id, completion))) => {
                    metadata.remove(&id);
                    self.metrics.completed(&completion);
                }
                Ok(None) | Err(_) => break,
            }
        }
        drop(futures);
        let forced = metadata.len();
        for (_, (disposition, panicked)) in metadata {
            self.metrics.completed(&TaskCompletion {
                disposition,
                bytes_to_egress: 0,
                bytes_to_ingress: 0,
                close_failed: true,
                panicked,
            });
        }
        self.metrics.forced_drops(forced);
    }

    async fn drain_rejected_closes_until(&self, state: &mut RuntimeState, deadline: Instant) {
        while !state.close_tasks.is_empty() && Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, state.close_tasks.join_next()).await {
                Ok(Some(result)) => self.finish_close_join(result),
                Ok(None) | Err(_) => break,
            }
        }
        while let Some(result) = state.close_tasks.try_join_next() {
            self.finish_close_join(result);
        }
        let forced = state.close_tasks.len();
        if forced > 0 {
            state.close_tasks.abort_all();
            self.metrics.forced_drops(forced);
            for _ in 0..forced {
                self.metrics.rejected_close(CloseOutcome {
                    failed: true,
                    panicked: false,
                });
            }
        }
    }

    async fn shutdown_owners_until(&self, deadline: Instant) -> usize {
        if self.owners.is_empty() {
            return 0;
        }
        let mut shutdowns: FuturesUnordered<BoxFuture<'static, bool>> = FuturesUnordered::new();
        for owner in &self.owners {
            let owner = owner.clone();
            shutdowns.push(
                async move {
                    AssertUnwindSafe(owner.shutdown())
                        .catch_unwind()
                        .await
                        .is_ok_and(|result| result.is_ok())
                }
                .boxed(),
            );
        }
        let mut failures = 0;
        while !shutdowns.is_empty() && Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, shutdowns.next()).await {
                Ok(Some(true)) => {}
                Ok(Some(false)) => failures += 1,
                Ok(None) => break,
                Err(_) => break,
            }
        }
        failures + shutdowns.len()
    }
}

/// Joinable owner of the internal supervisor. There is intentionally no
/// public abort handle: all stop paths signal cancellation and let the owned
/// supervisor execute flow/control/egress cleanup.
pub struct FlowRuntimeHandle {
    cancellation: CancellationToken,
    supervisor: Option<JoinHandle<Result<FlowRuntimeSnapshot, FlowRuntimeError>>>,
}

impl FlowRuntimeHandle {
    pub async fn stop(self) -> Result<FlowRuntimeSnapshot, FlowRuntimeError> {
        self.cancellation.cancel();
        self.wait().await
    }

    pub async fn wait(mut self) -> Result<FlowRuntimeSnapshot, FlowRuntimeError> {
        let supervisor = self
            .supervisor
            .take()
            .ok_or(FlowRuntimeError::SupervisorFailed)?;
        let mut guard = WaitCancellationGuard {
            cancellation: self.cancellation.clone(),
            armed: true,
        };
        let result = supervisor
            .await
            .map_err(|_| FlowRuntimeError::SupervisorFailed)?;
        guard.armed = false;
        result
    }
}

impl Drop for FlowRuntimeHandle {
    fn drop(&mut self) {
        if self.supervisor.is_some() {
            self.cancellation.cancel();
        }
    }
}

impl std::fmt::Debug for FlowRuntimeHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FlowRuntimeHandle")
            .field("cancelled", &self.cancellation.is_cancelled())
            .field("supervisor_owned", &self.supervisor.is_some())
            .finish()
    }
}

struct WaitCancellationGuard {
    cancellation: CancellationToken,
    armed: bool,
}

impl Drop for WaitCancellationGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReason {
    Eof,
    Cancelled,
    Ingress(FlowRuntimeError),
    SupervisorPanic,
}

struct RuntimeState {
    flow_tasks: JoinSet<TaskCompletion>,
    active_by_task: HashMap<TaskId, ActiveRecord>,
    active_flow_ids: HashSet<u64>,
    pending_finalization: Vec<PendingFinalization>,
    close_tasks: JoinSet<CloseOutcome>,
    max_close_tasks: usize,
}

impl RuntimeState {
    fn new(max_active_flows: usize) -> Self {
        Self {
            flow_tasks: JoinSet::new(),
            active_by_task: HashMap::new(),
            active_flow_ids: HashSet::new(),
            pending_finalization: Vec::new(),
            close_tasks: JoinSet::new(),
            max_close_tasks: max_active_flows
                .clamp(MIN_CONTROL_CLOSE_CONCURRENCY, MAX_CONTROL_CLOSE_CONCURRENCY),
        }
    }
}

struct ActiveRecord {
    flow_id: u64,
    close: Arc<CloseOnce>,
}

struct PendingFinalization {
    active: ActiveRecord,
    disposition: TcpCloseDisposition,
    panicked: bool,
}

impl std::fmt::Debug for FlowRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FlowRuntime")
            .field("config", &self.config)
            .field("profile_count", &self.engines.len())
            .field("owner_count", &self.owners.len())
            .field("cancelled", &self.cancellation.is_cancelled())
            .field("snapshot", &self.snapshot())
            .finish()
    }
}

struct TaskCompletion {
    disposition: TcpCloseDisposition,
    bytes_to_egress: u64,
    bytes_to_ingress: u64,
    close_failed: bool,
    panicked: bool,
}

async fn run_tcp_flow(
    flow: IngressTcpFlow,
    context: FlowContext,
    engine: Arc<FlowEngine>,
    cancellation: CancellationToken,
    _permit: OwnedSemaphorePermit,
    close: Arc<CloseOnce>,
) -> TaskCompletion {
    let IngressTcpFlow { mut stream, .. } = flow;

    let outcome = engine.handle_tcp_with_cancel(&context, &cancellation).await;
    let (disposition, bytes_to_egress, bytes_to_ingress) = match outcome {
        Ok(outcome) if outcome.result.effective_action == RouteAction::Block => {
            (TcpCloseDisposition::PolicyBlocked, 0, 0)
        }
        Ok(mut outcome) => match outcome.stream.as_mut() {
            Some(egress) => {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => (TcpCloseDisposition::Cancelled, 0, 0),
                    copied = copy_bidirectional_counted(&mut stream, &mut egress.stream) => {
                        match copied {
                            Ok((upstream, downstream)) => {
                                (TcpCloseDisposition::Finished, upstream, downstream)
                            }
                            Err(error) => (
                                TcpCloseDisposition::RuntimeFailure,
                                error.bytes_a_to_b(),
                                error.bytes_b_to_a(),
                            ),
                        }
                    }
                }
            }
            None => (TcpCloseDisposition::RuntimeFailure, 0, 0),
        },
        Err(_) if cancellation.is_cancelled() => (TcpCloseDisposition::Cancelled, 0, 0),
        Err(_) => (TcpCloseDisposition::RuntimeFailure, 0, 0),
    };

    let close_outcome = close.close(disposition).await;
    task_completion_from_close(
        disposition,
        bytes_to_egress,
        bytes_to_ingress,
        false,
        close_outcome,
    )
}

fn task_completion_from_close(
    disposition: TcpCloseDisposition,
    bytes_to_egress: u64,
    bytes_to_ingress: u64,
    panicked: bool,
    close: CloseOutcome,
) -> TaskCompletion {
    TaskCompletion {
        disposition,
        bytes_to_egress,
        bytes_to_ingress,
        close_failed: close.failed,
        panicked: panicked || close.panicked,
    }
}

const CLOSE_OPEN: u8 = 0;
const CLOSE_IN_PROGRESS: u8 = 1;
const CLOSE_SUCCEEDED: u8 = 2;
const CLOSE_FAILED: u8 = 3;

struct CloseOnce {
    state: AtomicU8,
    control: Arc<dyn IngressTcpControl>,
}

impl CloseOnce {
    fn new(control: Arc<dyn IngressTcpControl>) -> Self {
        Self {
            state: AtomicU8::new(CLOSE_OPEN),
            control,
        }
    }

    fn state(&self) -> u8 {
        self.state.load(Ordering::Acquire)
    }

    async fn close(&self, disposition: TcpCloseDisposition) -> CloseOutcome {
        if let Err(state) = self.state.compare_exchange(
            CLOSE_OPEN,
            CLOSE_IN_PROGRESS,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            return CloseOutcome {
                failed: state != CLOSE_SUCCEEDED,
                panicked: false,
            };
        }

        let mut attempt = CloseAttemptGuard {
            state: &self.state,
            armed: true,
        };
        let result = tokio::time::timeout(
            CONTROL_CLOSE_TIMEOUT,
            AssertUnwindSafe(async { self.control.close(disposition).await }).catch_unwind(),
        )
        .await;
        let outcome = match result {
            Ok(Ok(Ok(()))) => CloseOutcome {
                failed: false,
                panicked: false,
            },
            Ok(Ok(Err(_))) | Err(_) => CloseOutcome {
                failed: true,
                panicked: false,
            },
            Ok(Err(_)) => CloseOutcome {
                failed: true,
                panicked: true,
            },
        };
        self.state.store(
            if outcome.failed {
                CLOSE_FAILED
            } else {
                CLOSE_SUCCEEDED
            },
            Ordering::Release,
        );
        attempt.armed = false;
        outcome
    }
}

struct CloseAttemptGuard<'a> {
    state: &'a AtomicU8,
    armed: bool,
}

impl Drop for CloseAttemptGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.state.store(CLOSE_FAILED, Ordering::Release);
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct CloseOutcome {
    failed: bool,
    panicked: bool,
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    use super::*;
    use crate::sockscap::flow::attribution::{AttributionHints, FakeIpMap};
    use crate::sockscap::flow::bypass::HardBypassSet;
    use crate::sockscap::flow::connectors::{
        EgressConnector, EgressError, EgressMetadata, EgressStream, EgressTarget,
    };
    use crate::sockscap::flow::engine::{EgressProvider, FlowEngineSnapshot};
    use crate::sockscap::flow::ingress::{
        BoxedIngressStream, CaptureIntent, FlowDescriptor, bounded_flow_ingress,
    };
    use crate::sockscap::policy::matcher::ProfileMatcher;
    use crate::sockscap::types::{
        AppSelectorKind, CapturePlatform, EgressFailureAction, LocalNetworkPolicy, ProfileScope,
        UdpPolicy,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    #[derive(Default)]
    struct RecordingControl {
        dispositions: Mutex<Vec<TcpCloseDisposition>>,
    }

    #[async_trait]
    impl IngressTcpControl for RecordingControl {
        async fn close(&self, disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            self.dispositions.lock().unwrap().push(disposition);
            Ok(())
        }
    }

    impl RecordingControl {
        fn dispositions(&self) -> Vec<TcpCloseDisposition> {
            self.dispositions.lock().unwrap().clone()
        }
    }

    struct PanicControl {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl IngressTcpControl for PanicControl {
        async fn close(&self, _disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            panic!("test close panic")
        }
    }

    struct HangingControl {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl IngressTcpControl for HangingControl {
        async fn close(&self, _disposition: TcpCloseDisposition) -> Result<(), IngressError> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            pending().await
        }
    }

    struct RecordingOwner {
        binding_id: String,
        shutdowns: AtomicUsize,
    }

    #[async_trait]
    impl FlowRuntimeOwner for RecordingOwner {
        fn binding_id(&self) -> &str {
            &self.binding_id
        }

        async fn shutdown(&self) -> Result<(), FlowRuntimeOwnerError> {
            self.shutdowns.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(())
        }
    }

    struct DuplexConnector {
        stream: Mutex<Option<DuplexStream>>,
    }

    #[async_trait]
    impl EgressConnector for DuplexConnector {
        fn name(&self) -> &'static str {
            "memory"
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            let stream = self
                .stream
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| EgressError::Unavailable("test stream already used".into()))?;
            Ok(EgressStream {
                stream: Box::new(stream),
                meta: EgressMetadata {
                    connector: "memory".into(),
                    remote_dns: false,
                    tcp_only: true,
                    detail: "in-memory test transport".into(),
                },
            })
        }
    }

    struct PendingConnector;

    #[async_trait]
    impl EgressConnector for PendingConnector {
        fn name(&self) -> &'static str {
            "pending"
        }

        async fn connect(&self, _target: &EgressTarget) -> Result<EgressStream, EgressError> {
            pending().await
        }
    }

    fn profile(action: RouteAction) -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: "profile-1".into(),
            name: "Profile 1".into(),
            enabled: true,
            scope: ProfileScope::Global,
            default_action: action,
            unknown_domain_action: action,
            ..Default::default()
        }
    }

    fn engine(action: RouteAction, direct: Option<Arc<dyn EgressConnector>>) -> Arc<FlowEngine> {
        let profile = profile(action);
        engine_for_profile(&profile, 3, direct)
    }

    fn engine_for_profile(
        profile: &RoutingProfileDraft,
        config_revision: u64,
        direct: Option<Arc<dyn EgressConnector>>,
    ) -> Arc<FlowEngine> {
        let matcher = Arc::new(ProfileMatcher::from_parts(
            profile.id.clone(),
            profile.default_action,
            profile.unknown_domain_action,
            Vec::new(),
            &[],
            &[],
        ));
        let mut engine = FlowEngine::new(
            FlowEngineSnapshot::from_profile(config_revision, profile).unwrap(),
            matcher,
            HardBypassSet::default(),
            FakeIpMap::default(),
            EgressProvider::unavailable("unused in direct/block tests"),
            UdpPolicy::Block,
            EgressFailureAction::FailClosed,
            LocalNetworkPolicy::default(),
        );
        if let Some(direct) = direct {
            engine = engine.with_direct_connector(direct);
        }
        Arc::new(engine)
    }

    fn runtime(
        action: RouteAction,
        direct: Option<Arc<dyn EgressConnector>>,
        max_active: usize,
    ) -> Arc<FlowRuntime> {
        Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new(
                    CapturePlatform::Linux,
                    7,
                    3,
                    max_active,
                    Duration::from_millis(250),
                )
                .unwrap(),
                vec![ProfileRuntime::new(profile(action), engine(action, direct))],
            )
            .unwrap(),
        )
    }

    fn descriptor(flow_id: u64, generation: u64) -> FlowDescriptor {
        FlowDescriptor {
            generation,
            flow_id,
            platform: CapturePlatform::Linux,
            source: SocketAddr::from((Ipv4Addr::new(192, 0, 2, 4), 40_000)),
            destination: SocketAddr::from((Ipv4Addr::new(203, 0, 113, 8), 443)),
            attribution: AttributionHints::default(),
            pid: None,
            process_start_time: None,
            app_kind: None,
            app_identity: None,
            capture_intent: CaptureIntent::AllowGlobalFallback,
            profile_binding: ProfileBinding::AutoSelect,
        }
    }

    fn ingress_flow(
        flow_id: u64,
        generation: u64,
        stream: BoxedIngressStream,
        control: Arc<dyn IngressTcpControl>,
    ) -> IngressTcpFlow {
        IngressTcpFlow {
            descriptor: descriptor(flow_id, generation),
            stream,
            control,
        }
    }

    fn assert_terminal_invariant(snapshot: &FlowRuntimeSnapshot) {
        assert_eq!(snapshot.active, 0);
        assert_eq!(
            snapshot.admitted,
            snapshot.completed + snapshot.policy_blocked + snapshot.cancelled + snapshot.failed
        );
        assert_eq!(snapshot.invariant_violations, 0);
    }

    #[test]
    fn config_rejects_zero_and_unbounded_values() {
        assert!(matches!(
            FlowRuntimeConfig::new(CapturePlatform::Linux, 0, 1, 1, Duration::from_secs(1)),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new(
                CapturePlatform::Linux,
                1,
                1,
                MAX_ACTIVE_FLOWS + 1,
                Duration::from_secs(1)
            ),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new(CapturePlatform::Linux, 1, 1, 1, Duration::ZERO),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new(CapturePlatform::Linux, 1, 1, 1, Duration::from_millis(99)),
            Err(FlowRuntimeError::InvalidConfig)
        ));
        assert!(matches!(
            FlowRuntimeConfig::new(CapturePlatform::Unknown, 1, 1, 1, Duration::from_secs(1)),
            Err(FlowRuntimeError::InvalidConfig)
        ));
    }

    #[tokio::test]
    async fn relays_bidirectionally_and_counts_bytes() {
        let (egress_runtime, mut egress_peer) = tokio::io::duplex(128);
        let connector: Arc<dyn EgressConnector> = Arc::new(DuplexConnector {
            stream: Mutex::new(Some(egress_runtime)),
        });
        let runtime = runtime(RouteAction::Direct, Some(connector), 4);
        let (sender, ingress) = bounded_flow_ingress(4).unwrap();
        let (ingress_runtime, mut client) = tokio::io::duplex(128);
        let control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(
                1,
                7,
                Box::new(ingress_runtime),
                control.clone(),
            ))
            .unwrap();
        let run = runtime.start(Arc::new(ingress)).unwrap();
        // Orderly producer EOF must stop admission without cancelling this
        // already-admitted half-close exchange.
        drop(sender);

        client.write_all(b"ping").await.unwrap();
        client.shutdown().await.unwrap();
        let mut request = Vec::new();
        egress_peer.read_to_end(&mut request).await.unwrap();
        assert_eq!(&request, b"ping");
        egress_peer.write_all(b"pong").await.unwrap();
        egress_peer.shutdown().await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert_eq!(&response, b"pong");

        let snapshot = run.wait().await.unwrap();
        assert_eq!(snapshot.completed, 1);
        assert_eq!(snapshot.active, 0);
        assert_eq!(snapshot.bytes_to_egress, 4);
        assert_eq!(snapshot.bytes_to_ingress, 4);
        assert_eq!(control.dispositions(), vec![TcpCloseDisposition::Finished]);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn policy_block_never_opens_a_connector() {
        let runtime = runtime(RouteAction::Block, None, 2);
        let (sender, ingress) = bounded_flow_ingress(2).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(1, 7, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.policy_blocked, 1);
        assert_eq!(snapshot.failed, 0);
        assert_eq!(
            control.dispositions(),
            vec![TcpCloseDisposition::PolicyBlocked]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn stale_generation_is_rejected_before_admission() {
        let runtime = runtime(RouteAction::Direct, None, 2);
        let (sender, ingress) = bounded_flow_ingress(2).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(1, 6, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.admitted, 0);
        assert_eq!(snapshot.rejected_stale, 1);
        assert_eq!(
            control.dispositions(),
            vec![TcpCloseDisposition::StaleGeneration]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn overload_and_duplicate_are_immediate_and_bounded() {
        let pending: Arc<dyn EgressConnector> = Arc::new(PendingConnector);
        let runtime = runtime(RouteAction::Direct, Some(pending), 1);
        let (sender, ingress) = bounded_flow_ingress(4).unwrap();
        let (first, _first_peer) = tokio::io::duplex(32);
        let (duplicate, _duplicate_peer) = tokio::io::duplex(32);
        let (overloaded, _overloaded_peer) = tokio::io::duplex(32);
        let first_control = Arc::new(RecordingControl::default());
        let duplicate_control = Arc::new(RecordingControl::default());
        let overload_control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(1, 7, Box::new(first), first_control.clone()))
            .unwrap();
        sender
            .try_send(ingress_flow(
                1,
                7,
                Box::new(duplicate),
                duplicate_control.clone(),
            ))
            .unwrap();
        sender
            .try_send(ingress_flow(
                2,
                7,
                Box::new(overloaded),
                overload_control.clone(),
            ))
            .unwrap();
        drop(sender);

        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.admitted, 1);
        assert_eq!(snapshot.rejected_duplicate, 1);
        assert_eq!(snapshot.rejected_overloaded, 1);
        assert_eq!(snapshot.active, 0);
        assert_eq!(
            duplicate_control.dispositions(),
            vec![TcpCloseDisposition::DuplicateFlow]
        );
        assert_eq!(
            overload_control.dispositions(),
            vec![TcpCloseDisposition::Overloaded]
        );
        assert_eq!(
            first_control.dispositions(),
            vec![TcpCloseDisposition::Cancelled]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[test]
    fn stale_engine_snapshot_and_missing_live_owner_are_rejected() {
        let draft = profile(RouteAction::Direct);
        let stale_engine = engine_for_profile(&draft, 2, None);
        let config =
            FlowRuntimeConfig::new(CapturePlatform::Linux, 7, 3, 2, Duration::from_millis(250))
                .unwrap();
        assert!(matches!(
            FlowRuntime::new(
                config,
                vec![ProfileRuntime::new(draft.clone(), stale_engine)]
            ),
            Err(FlowRuntimeError::EngineSnapshotMismatch)
        ));

        let mut configured = draft;
        configured.egress_kind = Some(crate::sockscap::types::EgressKind::ProxySession);
        configured.egress_ref_id = Some("saved-proxy".into());
        let configured_engine = engine_for_profile(&configured, 3, None);
        assert!(matches!(
            FlowRuntime::new(
                config,
                vec![ProfileRuntime::new(configured, configured_engine)]
            ),
            Err(FlowRuntimeError::OwnerRequired)
        ));
    }

    #[tokio::test]
    async fn close_panic_is_caught_and_control_is_invoked_once() {
        let runtime = runtime(RouteAction::Block, None, 2);
        let (sender, ingress) = bounded_flow_ingress(2).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(PanicControl {
            calls: AtomicUsize::new(0),
        });
        sender
            .try_send(ingress_flow(1, 7, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(control.calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(snapshot.policy_blocked, 1);
        assert_eq!(snapshot.control_close_failures, 1);
        assert_eq!(snapshot.task_panics, 1);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn hanging_close_is_not_retried_after_task_abort() {
        let pending_connector: Arc<dyn EgressConnector> = Arc::new(PendingConnector);
        let runtime = runtime(RouteAction::Direct, Some(pending_connector), 1);
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(HangingControl {
            calls: AtomicUsize::new(0),
        });
        sender
            .try_send(ingress_flow(1, 7, Box::new(stream), control.clone()))
            .unwrap();
        drop(sender);

        let started = Instant::now();
        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(600));
        assert_eq!(control.calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(snapshot.cancelled, 1);
        assert_eq!(snapshot.control_close_failures, 1);
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn rejected_hanging_closes_share_the_absolute_shutdown_deadline() {
        let runtime = runtime(RouteAction::Direct, None, 2);
        let (sender, ingress) = bounded_flow_ingress(8).unwrap();
        let mut controls = Vec::new();
        for flow_id in 1..=8 {
            let (stream, _peer) = tokio::io::duplex(32);
            let control = Arc::new(HangingControl {
                calls: AtomicUsize::new(0),
            });
            sender
                .try_send(ingress_flow(flow_id, 6, Box::new(stream), control.clone()))
                .unwrap();
            controls.push(control);
        }
        drop(sender);

        let started = Instant::now();
        let snapshot = runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(600));
        assert_eq!(snapshot.rejected_stale, 8);
        assert_eq!(snapshot.forced_drops, 8);
        assert_eq!(snapshot.control_close_failures, 8);
        assert!(
            controls
                .iter()
                .all(|control| control.calls.load(AtomicOrdering::SeqCst) == 1)
        );
        assert_terminal_invariant(&snapshot);
    }

    #[tokio::test]
    async fn aborting_waiter_still_closes_flow_and_shuts_down_owner() {
        let pending_connector: Arc<dyn EgressConnector> = Arc::new(PendingConnector);
        let owner = Arc::new(RecordingOwner {
            binding_id: "test-owner".into(),
            shutdowns: AtomicUsize::new(0),
        });
        let runtime = Arc::new(
            FlowRuntime::new(
                FlowRuntimeConfig::new(CapturePlatform::Linux, 7, 3, 1, Duration::from_millis(250))
                    .unwrap(),
                vec![ProfileRuntime::with_owner(
                    profile(RouteAction::Direct),
                    engine(RouteAction::Direct, Some(pending_connector)),
                    owner.clone(),
                )],
            )
            .unwrap(),
        );
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        sender
            .try_send(ingress_flow(1, 7, Box::new(stream), control.clone()))
            .unwrap();
        let handle = runtime.start(Arc::new(ingress)).unwrap();
        let waiter = tokio::spawn(handle.wait());

        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.snapshot().admitted == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        drop(sender);

        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.snapshot().active != 0
                || owner.shutdowns.load(AtomicOrdering::SeqCst) != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(control.dispositions(), vec![TcpCloseDisposition::Cancelled]);
        assert_terminal_invariant(&runtime.snapshot());
    }

    #[tokio::test]
    async fn runtime_is_single_use_and_platform_mismatch_fails_closed() {
        let first_runtime = runtime(RouteAction::Direct, None, 1);
        let (_sender, ingress) = bounded_flow_ingress(1).unwrap();
        let handle = first_runtime.start(Arc::new(ingress)).unwrap();
        let (_second_sender, second_ingress) = bounded_flow_ingress(1).unwrap();
        assert!(matches!(
            first_runtime.start(Arc::new(second_ingress)),
            Err(FlowRuntimeError::AlreadyStarted)
        ));
        handle.stop().await.unwrap();

        let platform_runtime = runtime(RouteAction::Direct, None, 1);
        let (sender, ingress) = bounded_flow_ingress(1).unwrap();
        let (stream, _peer) = tokio::io::duplex(32);
        let control = Arc::new(RecordingControl::default());
        let mut flow = ingress_flow(1, 7, Box::new(stream), control.clone());
        flow.descriptor.platform = CapturePlatform::Windows;
        sender.try_send(flow).unwrap();
        drop(sender);
        let snapshot = platform_runtime
            .start(Arc::new(ingress))
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(snapshot.rejected_invalid, 1);
        assert_eq!(
            control.dispositions(),
            vec![TcpCloseDisposition::InvalidDescriptor]
        );
        assert_terminal_invariant(&snapshot);
    }

    #[test]
    fn descriptor_debug_redacts_external_identity() {
        let mut descriptor = descriptor(1, 7);
        descriptor.app_kind = Some(AppSelectorKind::ExecutablePath);
        descriptor.app_identity = Some("/secret/application/path".into());
        descriptor.attribution.tls_sni = Some("private.example".into());
        let debug = format!("{descriptor:?}");
        assert!(!debug.contains("/secret/application/path"));
        assert!(!debug.contains("private.example"));
        assert!(!debug.contains("203.0.113.8"));
    }
}
