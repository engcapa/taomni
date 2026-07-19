//! Privileged Linux helper executable and narrow request dispatcher.
//!
//! This process owns only cgroup/TUN/nft/policy-route mutations. Proxy
//! credentials, routing rules, DNS payloads, and arbitrary commands never cross
//! this boundary. The complete restore intent is durably published in a
//! root-owned write-ahead receipt before the first mutation; a separate cleaned
//! tombstone makes lost cleanup acknowledgements safely retryable.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;

use super::helper_protocol::{HelperRequest, HelperResponse};
use super::linux::{LINUX_ADAPTER_ID, LinuxCapturePlan, LinuxPrerequisites};
use super::linux_process::{
    LinuxPreparedCapture, activate_linux_capture, apply_linux_capture,
    apply_linux_membership_refresh, plan_linux_capture, plan_linux_membership_refresh,
    stop_linux_capture,
};
use super::linux_system::RealLinuxCommandRunner;
use super::unix_transport::{
    HELPER_RUNTIME_DIR, INSTALLED_HELPER_POLICY, InstalledHelperPolicy, UnixPeerPolicy,
    accept_verified_channel, bind_helper_socket, linux_process_start_token, load_installed_policy,
    verified_process_identity,
};
use super::{AdapterProbe, CaptureArtifactState, CaptureError, CaptureHandle, CaptureInstallSpec};
use crate::sockscap::types::CapturePlatform;

const ACCEPT_TIMEOUT: Duration = Duration::from_secs(60);
const GATEWAY_READY_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RECEIPT_BYTES: u64 = 64 * 1024;
const CLEANED_TOMBSTONE_VERSION: u32 = 1;
const MAX_RUNTIME_FDS: usize = 65_536;
const MAX_TUN_FDINFO_BYTES: u64 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HelperArgs {
    authorized_uid: u32,
    expected_pid: u32,
    generation: u64,
}

pub async fn run_from_args() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1))?;
    // SAFETY: `geteuid` has no preconditions.
    if unsafe { libc::geteuid() } != 0 {
        return Err(
            "SOCKSCAP_HELPER_ROOT_REQUIRED: launch through the reviewed polkit action".into(),
        );
    }
    let policy = load_installed_policy(Path::new(INSTALLED_HELPER_POLICY), 0)
        .map_err(|error| format!("SOCKSCAP_HELPER_POLICY_INVALID: {error}"))?;
    verified_process_identity(std::process::id(), &policy.helper_policy())
        .map_err(|error| format!("SOCKSCAP_HELPER_SELF_SIGNATURE_INVALID: {error}"))?;

    let socket = bind_helper_socket(args.authorized_uid, args.generation)
        .map_err(|error| format!("SOCKSCAP_HELPER_SOCKET_FAILED: {error}"))?;
    println!("SOCKSCAP_HELPER_READY {}", socket.path().display());
    std::io::stdout()
        .flush()
        .map_err(|error| format!("SOCKSCAP_HELPER_READY_FAILED: {error}"))?;
    let (stream, _) = tokio::time::timeout(ACCEPT_TIMEOUT, socket.listener.accept())
        .await
        .map_err(|_| "SOCKSCAP_HELPER_ACCEPT_TIMEOUT: no verified app connected".to_string())?
        .map_err(|error| format!("SOCKSCAP_HELPER_ACCEPT_FAILED: {error}"))?;
    let peer_policy = UnixPeerPolicy {
        expected_pid: Some(args.expected_pid),
        caller: policy.caller_policy(args.authorized_uid),
    };
    let channel = accept_verified_channel(stream, &peer_policy)
        .await
        .map_err(|error| format!("SOCKSCAP_HELPER_PEER_REJECTED: {error}"))?;
    let peer_pid = channel.peer().pid;
    let mut executor = LinuxHelperExecutor::new(args, peer_pid, policy)?;
    executor.serve(channel).await
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<HelperArgs, String> {
    let args = args.into_iter().collect::<Vec<_>>();
    if args.len() != 7
        || args[0] != "--serve"
        || args[1] != "--authorized-uid"
        || args[3] != "--expected-pid"
        || args[5] != "--generation"
    {
        return Err(
            "SOCKSCAP_HELPER_ARGUMENTS_INVALID: expected --serve --authorized-uid <uid> --expected-pid <pid> --generation <generation>"
                .into(),
        );
    }
    let authorized_uid = parse_nonzero(&args[2], "authorized UID")?;
    let expected_pid = parse_nonzero(&args[4], "expected PID")?;
    let generation = args[6]
        .parse::<u64>()
        .ok()
        .filter(|value| *value != 0)
        .ok_or_else(|| {
            "SOCKSCAP_HELPER_ARGUMENTS_INVALID: generation must be non-zero".to_string()
        })?;
    Ok(HelperArgs {
        authorized_uid,
        expected_pid,
        generation,
    })
}

fn parse_nonzero(value: &str, label: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .ok()
        .filter(|value| *value != 0)
        .ok_or_else(|| format!("SOCKSCAP_HELPER_ARGUMENTS_INVALID: {label} must be non-zero"))
}

struct PreparedEntry {
    prepared: LinuxPreparedCapture,
    active: bool,
}

/// Durable proof that this exact helper generation completed the idempotent
/// cleanup and absence audit. The tombstone is deliberately retained for the
/// life of `/run`: a lost `Stopped`/`Recovered` response can then be retried
/// without treating an unproven missing receipt as success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanedTombstone {
    version: u32,
    authorized_uid: u32,
    generation: u64,
    artifact: CaptureArtifactState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PersistentCleanupState {
    Missing,
    Pending(CaptureArtifactState),
    Cleaned(CaptureArtifactState),
}

struct LinuxHelperExecutor {
    args: HelperArgs,
    peer_pid: u32,
    helper_pid: u32,
    policy: InstalledHelperPolicy,
    runner: RealLinuxCommandRunner,
    entries: HashMap<u64, PreparedEntry>,
}

impl LinuxHelperExecutor {
    fn new(args: HelperArgs, peer_pid: u32, policy: InstalledHelperPolicy) -> Result<Self, String> {
        if peer_pid != args.expected_pid {
            return Err("SOCKSCAP_HELPER_PEER_REJECTED: verified PID changed".into());
        }
        Ok(Self {
            args,
            peer_pid,
            helper_pid: std::process::id(),
            policy,
            runner: RealLinuxCommandRunner,
            entries: HashMap::new(),
        })
    }

    async fn serve(
        &mut self,
        mut channel: super::unix_transport::HelperChannel,
    ) -> Result<(), String> {
        let loop_result = loop {
            let envelope = match channel.receive::<HelperRequest>().await {
                Ok(envelope) => envelope,
                Err(error) => break Err(format!("SOCKSCAP_HELPER_TRANSPORT_CLOSED: {error}")),
            };
            let request_id = envelope.request_id().to_string();
            let generation = envelope.generation();
            let shutdown = matches!(envelope.body(), HelperRequest::Shutdown);
            let response = if generation != self.args.generation {
                helper_error(CaptureError::recovery(
                    "CAPTURE_GENERATION_MISMATCH",
                    "authenticated envelope does not match the helper generation",
                ))
            } else {
                match self.dispatch(envelope.body().clone()).await {
                    Ok(response) => response,
                    Err(error) => helper_error(error),
                }
            };
            if let Err(error) = channel.send(request_id, generation, response).await {
                break Err(format!("SOCKSCAP_HELPER_RESPONSE_FAILED: {error}"));
            }
            if shutdown {
                break Ok(());
            }
        };

        let cleanup = self.cleanup_all().await;
        match (loop_result, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(cleanup)) => Err(cleanup.to_string()),
            (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
        }
    }

    async fn dispatch(&mut self, request: HelperRequest) -> Result<HelperResponse, CaptureError> {
        match request {
            HelperRequest::Probe => Ok(HelperResponse::Probe {
                report: self.probe(),
            }),
            HelperRequest::Prepare { spec } => self.prepare(spec).await,
            HelperRequest::Activate {
                generation,
                runtime_pid,
                runtime_start_token,
            } => {
                self.activate(generation, runtime_pid, runtime_start_token)
                    .await
            }
            HelperRequest::Update { .. } => Err(CaptureError::invalid(
                "LINUX_CAPTURE_UPDATE_REQUIRES_RESTART",
                "selector replacement is not yet safe in-place; stop and start a new generation",
            )),
            HelperRequest::Stop { handle } => self.stop(handle.generation).await,
            HelperRequest::Recover { artifact } => self.recover(&artifact).await,
            HelperRequest::RecoverGeneration { generation } => {
                self.recover_generation(generation).await
            }
            HelperRequest::Heartbeat { generation } => self.heartbeat(generation),
            HelperRequest::Shutdown => {
                self.cleanup_all().await?;
                Ok(HelperResponse::Shutdown)
            }
        }
    }

    fn probe(&self) -> AdapterProbe {
        let prerequisites = LinuxPrerequisites::probe();
        let ready = prerequisites.ready_for_privileged_mutation();
        AdapterProbe {
            adapter: LINUX_ADAPTER_ID.into(),
            platform: CapturePlatform::Linux,
            installed: true,
            privileged_helper_ready: ready,
            signature_verified: true,
            // The helper/system prerequisites are necessary but not
            // sufficient: the packaged product still lacks the complete
            // packet-to-TCP/UDP stack and CaptureAdapter pump. Keep every
            // capability bit locked until those gates and native evidence
            // exist.
            global_available: false,
            application_group_available: false,
            runtime_pid_available: false,
            detail: format!(
                "capture_adapter_not_wired; tun={}, cgroup_v2={}, ip={}, nft={}, root_or_cap_net_admin={}",
                prerequisites.tun_present,
                prerequisites.cgroup_v2,
                prerequisites.ip_path.is_some(),
                prerequisites.nft_path.is_some(),
                prerequisites.effective_uid == 0 || prerequisites.cap_net_admin
            ),
        }
    }

    async fn prepare(
        &mut self,
        mut spec: CaptureInstallSpec,
    ) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(spec.generation)?;
        if spec.taomni_pid != self.peer_pid {
            return Err(CaptureError::invalid(
                "LINUX_TAOMNI_PID_UNVERIFIED",
                "capture specification does not name the verified app process",
            ));
        }
        if self.entries.contains_key(&spec.generation)
            || !matches!(
                load_persistent_cleanup_state(&self.args)?,
                PersistentCleanupState::Missing
            )
        {
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_ARTIFACT_EXISTS",
                "this capture generation already has pending or cleaned helper-owned recovery state",
            ));
        }
        spec.helper_pid = Some(self.helper_pid);
        spec.validate()?;
        let preparation = plan_linux_capture(&spec, self.args.authorized_uid)?;
        let recovery_artifact = preparation.artifact().clone();
        // This is the transaction commit point: the complete restore intent is
        // durable before apply can create cgroups, move a process, or create a
        // TUN. A lost response or process crash can therefore always recover.
        create_receipt(&self.args, &recovery_artifact)?;

        let prepared = match apply_linux_capture(&self.runner, preparation).await {
            Ok(prepared) => prepared,
            Err(error) => {
                if !error.recovery_required {
                    let cleaned = error
                        .artifact
                        .clone()
                        .unwrap_or_else(|| recovery_artifact.clone());
                    self.audit_and_finalize_failed_mutation(&error, &cleaned)
                        .await?;
                }
                return Err(error);
            }
        };
        if prepared.artifact != recovery_artifact {
            return Err(CaptureError::recovery_with_artifact(
                "LINUX_HELPER_WAL_APPLY_MISMATCH",
                "applied prepare state differs from its durable write-ahead receipt",
                recovery_artifact,
            ));
        }
        let handle = CaptureHandle {
            generation: spec.generation,
            config_revision: spec.config_revision,
            helper_pid: self.helper_pid,
            artifact: prepared.artifact.clone(),
        };
        self.entries.insert(
            spec.generation,
            PreparedEntry {
                prepared,
                active: false,
            },
        );
        Ok(HelperResponse::Prepared { handle })
    }

    async fn activate(
        &mut self,
        generation: u64,
        runtime_pid: u32,
        runtime_start_token: u64,
    ) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(generation)?;
        let expected_tun = self
            .entries
            .get(&generation)
            .ok_or_else(|| {
                CaptureError::recovery(
                    "LINUX_CAPTURE_NOT_PREPARED",
                    "activation requires a helper-owned prepared generation",
                )
            })?
            .prepared
            .plan
            .tun_name
            .clone();
        if runtime_pid == self.helper_pid || runtime_start_token == 0 {
            return Err(CaptureError::invalid(
                "LINUX_TUN_RUNTIME_INVALID",
                "TUN runtime identity is missing or points at the root helper",
            ));
        }
        let identity = verified_process_identity(
            runtime_pid,
            &self.policy.runtime_policy(self.args.authorized_uid),
        )
        .map_err(|error| {
            CaptureError::invalid("LINUX_TUN_RUNTIME_UNVERIFIED", error.to_string())
        })?;
        let actual_start = linux_process_start_token(runtime_pid).map_err(|error| {
            CaptureError::invalid("LINUX_TUN_RUNTIME_UNVERIFIED", error.to_string())
        })?;
        if identity.pid != runtime_pid || actual_start != runtime_start_token {
            return Err(CaptureError::invalid(
                "LINUX_TUN_RUNTIME_REUSED",
                "TUN runtime PID no longer identifies the verified process",
            ));
        }
        if !process_has_tun_interface(runtime_pid, &expected_tun) {
            return Err(CaptureError::invalid(
                "LINUX_TUN_RUNTIME_NOT_READY",
                "verified runtime has not opened this generation's exact TUN interface",
            ));
        }
        let entry = self
            .entries
            .get(&generation)
            .expect("prepared entry verified above");
        if entry.active {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_ALREADY_ACTIVE",
                "capture generation is already active",
            ));
        }
        let prepared = entry.prepared.clone();
        ensure_gateway_ready(prepared.spec.gateway).await?;
        match activate_linux_capture(&self.runner, &prepared).await {
            Ok(handle) => {
                if handle.artifact != prepared.artifact {
                    return Err(CaptureError::recovery_with_artifact(
                        "LINUX_HELPER_WAL_APPLY_MISMATCH",
                        "activation changed recovery state without a write-ahead receipt",
                        prepared.artifact,
                    ));
                }
                self.entries
                    .get_mut(&generation)
                    .expect("prepared entry retained during activation")
                    .active = true;
                Ok(HelperResponse::Installed { handle })
            }
            Err(error) => {
                if !error.recovery_required {
                    let cleaned = error
                        .artifact
                        .clone()
                        .unwrap_or_else(|| prepared.artifact.clone());
                    self.audit_and_finalize_failed_mutation(&error, &cleaned)
                        .await?;
                    self.entries.remove(&generation);
                }
                Err(error)
            }
        }
    }

    fn heartbeat(&mut self, generation: u64) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(generation)?;
        let args = self.args;
        let entry = self.entries.get_mut(&generation).ok_or_else(|| {
            CaptureError::recovery(
                "LINUX_CAPTURE_NOT_ACTIVE",
                "heartbeat requires a helper-owned capture generation",
            )
        })?;
        if !entry.active {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_NOT_ACTIVE",
                "prepared capture has not been activated",
            ));
        }
        let refresh = plan_linux_membership_refresh(&entry.prepared)?;
        if refresh.is_empty() {
            return Ok(HelperResponse::Heartbeat {
                helper_pid: self.helper_pid,
                generation,
                artifact: Some(entry.prepared.artifact.clone()),
            });
        }
        let artifact = refresh.artifact().clone();
        write_ahead_then(
            &artifact,
            |artifact| replace_receipt(&args, artifact),
            || apply_linux_membership_refresh(&entry.prepared, &refresh),
        )
        .map(|applied| {
            entry.prepared.artifact = applied;
        })
        .map_err(|error| {
            // Apply errors can occur after an earlier planned process was
            // moved. Keep memory aligned with the authoritative WAL so an
            // immediate stop/disconnect can clean every possible mutation.
            if error.artifact.as_ref() == Some(&artifact) {
                entry.prepared.artifact = artifact.clone();
            }
            error
        })?;
        Ok(HelperResponse::Heartbeat {
            helper_pid: self.helper_pid,
            generation,
            artifact: Some(artifact),
        })
    }

    async fn stop(&mut self, generation: u64) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(generation)?;
        let artifact = self.current_cleanup_artifact()?;
        self.audit_and_record_cleanup(&artifact).await?;
        Ok(HelperResponse::Stopped)
    }

    async fn recover(
        &mut self,
        requested: &CaptureArtifactState,
    ) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(requested.generation)?;
        self.validate_artifact(requested)?;
        let artifact =
            recovery_artifact_for_request(requested, load_persistent_cleanup_state(&self.args)?)?;
        self.recover_artifact(&artifact).await
    }

    async fn recover_generation(
        &mut self,
        generation: u64,
    ) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(generation)?;
        let artifact =
            recovery_artifact_for_generation(load_persistent_cleanup_state(&self.args)?)?;
        self.recover_artifact(&artifact).await
    }

    async fn recover_artifact(
        &mut self,
        artifact: &CaptureArtifactState,
    ) -> Result<HelperResponse, CaptureError> {
        self.audit_and_record_cleanup(artifact).await?;
        Ok(HelperResponse::Recovered)
    }

    async fn cleanup_all(&mut self) -> Result<(), CaptureError> {
        let state = load_persistent_cleanup_state(&self.args)?;
        let artifact = if let Some(entry) = self.entries.get(&self.args.generation) {
            let artifact = entry.prepared.artifact.clone();
            if let PersistentCleanupState::Pending(receipt) = &state {
                if receipt != &artifact {
                    return Err(CaptureError::recovery_with_artifact(
                        "LINUX_HELPER_RECEIPT_MEMORY_MISMATCH",
                        "in-memory capture state differs from the root recovery receipt",
                        receipt.clone(),
                    ));
                }
            }
            Some(artifact)
        } else {
            match state {
                PersistentCleanupState::Pending(artifact) => Some(artifact),
                PersistentCleanupState::Missing | PersistentCleanupState::Cleaned(_) => None,
            }
        };
        if let Some(artifact) = artifact {
            self.audit_and_record_cleanup(&artifact)
                .await
                .map_err(|error| {
                    CaptureError::recovery_with_artifact(
                        "LINUX_HELPER_DISCONNECT_CLEANUP_FAILED",
                        error.message,
                        artifact,
                    )
                })?;
        }
        Ok(())
    }

    fn current_cleanup_artifact(&self) -> Result<CaptureArtifactState, CaptureError> {
        let state = load_persistent_cleanup_state(&self.args)?;
        if let Some(entry) = self.entries.get(&self.args.generation) {
            let artifact = entry.prepared.artifact.clone();
            return match state {
                PersistentCleanupState::Pending(receipt) if receipt == artifact => Ok(artifact),
                PersistentCleanupState::Pending(receipt) => {
                    Err(CaptureError::recovery_with_artifact(
                        "LINUX_HELPER_RECEIPT_MEMORY_MISMATCH",
                        "in-memory capture state differs from the root recovery receipt",
                        receipt,
                    ))
                }
                PersistentCleanupState::Missing => Ok(artifact),
                PersistentCleanupState::Cleaned(cleaned) => {
                    Err(CaptureError::recovery_with_artifact(
                        "LINUX_HELPER_CLEANUP_STATE_CONFLICT",
                        "an active in-memory capture conflicts with a cleaned tombstone",
                        cleaned,
                    ))
                }
            };
        }
        recovery_artifact_for_generation(state)
    }

    async fn audit_and_record_cleanup(
        &mut self,
        artifact: &CaptureArtifactState,
    ) -> Result<(), CaptureError> {
        self.validate_artifact(artifact)?;
        // `stop_linux_capture` is intentionally idempotent: it attempts every
        // removal and then proves the generation's network/cgroup namespace is
        // absent. This audit is repeated even for an existing tombstone.
        stop_linux_capture(&self.runner, artifact).await?;
        finalize_cleaned_state(&self.args, artifact)?;
        self.entries.remove(&artifact.generation);
        Ok(())
    }

    async fn audit_and_finalize_failed_mutation(
        &self,
        original: &CaptureError,
        artifact: &CaptureArtifactState,
    ) -> Result<(), CaptureError> {
        // `recovery_required == false` is not itself proof of cleanup. Repeat
        // the full idempotent removal and absence audit before retiring the
        // receipt, including for lower-layer rollback errors.
        stop_linux_capture(&self.runner, artifact)
            .await
            .map_err(|cleanup| {
                CaptureError::recovery_with_artifact(
                    original.code.clone(),
                    format!(
                        "{}; cleanup absence audit failed: {}",
                        original.message, cleanup.message
                    ),
                    artifact.clone(),
                )
            })?;
        finalize_cleaned_state(&self.args, artifact).map_err(|finalize| {
            CaptureError::recovery_with_artifact(
                original.code.clone(),
                format!(
                    "{}; could not persist cleaned generation: {}",
                    original.message, finalize.message
                ),
                artifact.clone(),
            )
        })
    }

    fn validate_generation(&self, generation: u64) -> Result<(), CaptureError> {
        if generation != self.args.generation {
            return Err(CaptureError::recovery(
                "CAPTURE_GENERATION_MISMATCH",
                "request does not match the helper generation",
            ));
        }
        Ok(())
    }

    fn validate_artifact(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
        artifact.validate()?;
        if artifact.generation != self.args.generation
            || artifact.owner_uid != Some(self.args.authorized_uid)
        {
            return Err(CaptureError::recovery(
                "LINUX_RECOVERY_OWNER_MISMATCH",
                "recovery receipt does not belong to this user and generation",
            ));
        }
        LinuxCapturePlan::from_artifact(artifact)?;
        Ok(())
    }
}

fn write_ahead_then<T>(
    artifact: &CaptureArtifactState,
    persist: impl FnOnce(&CaptureArtifactState) -> Result<(), CaptureError>,
    apply: impl FnOnce() -> Result<T, CaptureError>,
) -> Result<T, CaptureError> {
    persist(artifact)?;
    apply()
}

fn helper_error(error: CaptureError) -> HelperResponse {
    HelperResponse::Error {
        code: error.code,
        message: error.message,
        recovery_required: error.recovery_required,
        artifact: error.artifact,
    }
}

async fn ensure_gateway_ready(gateway: std::net::SocketAddr) -> Result<(), CaptureError> {
    if !gateway.ip().is_loopback() {
        return Err(CaptureError::invalid(
            "CAPTURE_GATEWAY_INVALID",
            "capture gateway must remain on loopback",
        ));
    }
    tokio::time::timeout(GATEWAY_READY_TIMEOUT, TcpStream::connect(gateway))
        .await
        .map_err(|_| {
            CaptureError::invalid(
                "LINUX_CAPTURE_GATEWAY_NOT_READY",
                "local capture gateway readiness timed out",
            )
        })?
        .map_err(|error| {
            CaptureError::invalid(
                "LINUX_CAPTURE_GATEWAY_NOT_READY",
                format!("local capture gateway is unavailable: {error}"),
            )
        })?;
    Ok(())
}

fn process_has_tun_interface(pid: u32, expected_interface: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    entries
        .flatten()
        .take(MAX_RUNTIME_FDS)
        .filter_map(|entry| {
            let fd = entry.file_name().to_str()?.parse::<u32>().ok()?;
            std::fs::read_link(entry.path())
                .ok()
                .filter(|path| path == Path::new("/dev/net/tun"))?;
            let path = PathBuf::from(format!("/proc/{pid}/fdinfo/{fd}"));
            let file = File::open(path).ok()?;
            let mut fdinfo = Vec::new();
            file.take(MAX_TUN_FDINFO_BYTES + 1)
                .read_to_end(&mut fdinfo)
                .ok()?;
            (fdinfo.len() <= MAX_TUN_FDINFO_BYTES as usize).then_some(fdinfo)
        })
        .any(|fdinfo| fdinfo_has_exact_tun_interface(&fdinfo, expected_interface))
}

fn fdinfo_has_exact_tun_interface(fdinfo: &[u8], expected_interface: &str) -> bool {
    fdinfo.split(|byte| *byte == b'\n').any(|line| {
        let Some(value) = line.strip_prefix(b"iff:") else {
            return false;
        };
        trim_ascii_whitespace(value) == expected_interface.as_bytes()
    })
}

fn trim_ascii_whitespace(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
}

fn recovery_artifact_for_request(
    requested: &CaptureArtifactState,
    state: PersistentCleanupState,
) -> Result<CaptureArtifactState, CaptureError> {
    match state {
        PersistentCleanupState::Pending(receipt) if &receipt == requested => Ok(receipt),
        PersistentCleanupState::Pending(receipt) => Err(CaptureError::recovery_with_artifact(
            "LINUX_RECOVERY_RECEIPT_MISMATCH",
            "app and root helper recovery receipts differ",
            receipt,
        )),
        PersistentCleanupState::Cleaned(cleaned) if same_cleanup_identity(requested, &cleaned) => {
            // The cleaned tombstone is authoritative. It may contain a newer
            // process-restore snapshot than the app saw before a heartbeat
            // response was lost.
            Ok(cleaned)
        }
        PersistentCleanupState::Cleaned(cleaned) => Err(CaptureError::recovery_with_artifact(
            "LINUX_RECOVERY_TOMBSTONE_MISMATCH",
            "requested recovery identity differs from the cleaned generation tombstone",
            cleaned,
        )),
        PersistentCleanupState::Missing => Err(CaptureError::recovery(
            "LINUX_HELPER_CLEANUP_PROOF_MISSING",
            "neither a pending receipt nor a cleaned tombstone proves this generation's state",
        )),
    }
}

fn recovery_artifact_for_generation(
    state: PersistentCleanupState,
) -> Result<CaptureArtifactState, CaptureError> {
    match state {
        PersistentCleanupState::Pending(artifact) | PersistentCleanupState::Cleaned(artifact) => {
            Ok(artifact)
        }
        PersistentCleanupState::Missing => Err(CaptureError::recovery(
            "LINUX_HELPER_CLEANUP_PROOF_MISSING",
            "neither a pending receipt nor a cleaned tombstone proves this generation's state",
        )),
    }
}

fn same_cleanup_identity(left: &CaptureArtifactState, right: &CaptureArtifactState) -> bool {
    left.adapter == right.adapter
        && left.generation == right.generation
        && left.owner_uid == right.owner_uid
        && left.interface_names == right.interface_names
        && left.rule_ids == right.rule_ids
        && left.route_ids == right.route_ids
        && left.cgroup_paths == right.cgroup_paths
        && left.driver_service == right.driver_service
        && left.extension_bundle_id == right.extension_bundle_id
}

fn receipt_path(args: &HelperArgs) -> PathBuf {
    Path::new(HELPER_RUNTIME_DIR).join(format!(
        "sockscap-recovery-{}-{}.json",
        args.authorized_uid, args.generation
    ))
}

fn cleaned_tombstone_path(args: &HelperArgs) -> PathBuf {
    Path::new(HELPER_RUNTIME_DIR).join(format!(
        "sockscap-cleaned-{}-{}.json",
        args.authorized_uid, args.generation
    ))
}

fn load_persistent_cleanup_state(
    args: &HelperArgs,
) -> Result<PersistentCleanupState, CaptureError> {
    let receipt = load_receipt_optional(args)?;
    let tombstone = load_cleaned_tombstone_optional(args)?;
    match (receipt, tombstone) {
        (Some(receipt), Some(cleaned)) if receipt == cleaned => {
            // Crash-safe transition: the tombstone is published before the
            // receipt is removed. Seeing both exact copies means cleanup must
            // be audited once more before acknowledging completion.
            Ok(PersistentCleanupState::Pending(receipt))
        }
        (Some(_receipt), Some(cleaned)) => Err(CaptureError::recovery_with_artifact(
            "LINUX_HELPER_CLEANUP_STATE_CONFLICT",
            "pending receipt and cleaned tombstone contain different artifacts",
            cleaned,
        )),
        (Some(receipt), None) => Ok(PersistentCleanupState::Pending(receipt)),
        (None, Some(cleaned)) => Ok(PersistentCleanupState::Cleaned(cleaned)),
        (None, None) => Ok(PersistentCleanupState::Missing),
    }
}

fn create_receipt(args: &HelperArgs, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
    validate_receipt(args, artifact)?;
    let path = receipt_path(args);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|error| {
            CaptureError::recovery(
                "LINUX_HELPER_RECEIPT_CREATE_FAILED",
                format!("could not create root recovery receipt: {error}"),
            )
        })?;
    write_receipt(&mut file, artifact)?;
    sync_runtime_directory()?;
    Ok(())
}

fn replace_receipt(args: &HelperArgs, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
    validate_receipt(args, artifact)?;
    let path = receipt_path(args);
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&temp)
        .map_err(|error| {
            CaptureError::recovery(
                "LINUX_HELPER_RECEIPT_UPDATE_FAILED",
                format!("could not stage root recovery receipt: {error}"),
            )
        })?;
    if let Err(error) = write_receipt(&mut file, artifact) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_UPDATE_FAILED",
            format!("could not publish root recovery receipt: {error}"),
        )
    })?;
    sync_runtime_directory().map_err(|error| {
        CaptureError::recovery_with_artifact(error.code, error.message, artifact.clone())
    })
}

fn write_receipt(file: &mut File, artifact: &CaptureArtifactState) -> Result<(), CaptureError> {
    let encoded = serde_json::to_vec(artifact).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_ENCODE_FAILED",
            format!("could not encode root recovery receipt: {error}"),
        )
    })?;
    if encoded.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_TOO_LARGE",
            "root recovery receipt exceeds its size bound",
        ));
    }
    file.write_all(&encoded).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_WRITE_FAILED",
            format!("could not write root recovery receipt: {error}"),
        )
    })?;
    file.sync_all().map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_SYNC_FAILED",
            format!("could not sync root recovery receipt: {error}"),
        )
    })
}

fn load_receipt_optional(args: &HelperArgs) -> Result<Option<CaptureArtifactState>, CaptureError> {
    match std::fs::symlink_metadata(receipt_path(args)) {
        Ok(_) => load_receipt(args).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_INVALID",
            format!("could not inspect root recovery receipt: {error}"),
        )),
    }
}

fn load_receipt(args: &HelperArgs) -> Result<CaptureArtifactState, CaptureError> {
    let path = receipt_path(args);
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|error| {
            CaptureError::recovery(
                "LINUX_HELPER_RECEIPT_MISSING",
                format!("root recovery receipt is unavailable: {error}"),
            )
        })?;
    let metadata = file.metadata().map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_INVALID",
            format!("could not inspect root recovery receipt: {error}"),
        )
    })?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o777 != 0o600
        || metadata.len() == 0
        || metadata.len() > MAX_RECEIPT_BYTES
    {
        return Err(CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_INVALID",
            "root recovery receipt has unsafe ownership, mode, type, or size",
        ));
    }
    let mut encoded = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut encoded).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_READ_FAILED",
            format!("could not read root recovery receipt: {error}"),
        )
    })?;
    let artifact = serde_json::from_slice(&encoded).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_INVALID",
            format!("could not decode root recovery receipt: {error}"),
        )
    })?;
    validate_receipt(args, &artifact)?;
    Ok(artifact)
}

fn load_cleaned_tombstone_optional(
    args: &HelperArgs,
) -> Result<Option<CaptureArtifactState>, CaptureError> {
    let path = cleaned_tombstone_path(args);
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CaptureError::recovery(
                "LINUX_HELPER_TOMBSTONE_INVALID",
                format!("cleaned generation tombstone is unavailable: {error}"),
            ));
        }
    };
    let metadata = file.metadata().map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_INVALID",
            format!("could not inspect cleaned generation tombstone: {error}"),
        )
    })?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o777 != 0o600
        || metadata.len() == 0
        || metadata.len() > MAX_RECEIPT_BYTES
    {
        return Err(CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_INVALID",
            "cleaned generation tombstone has unsafe ownership, mode, type, or size",
        ));
    }
    let mut encoded = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut encoded).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_INVALID",
            format!("could not read cleaned generation tombstone: {error}"),
        )
    })?;
    let tombstone: CleanedTombstone = serde_json::from_slice(&encoded).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_INVALID",
            format!("could not decode cleaned generation tombstone: {error}"),
        )
    })?;
    validate_cleaned_tombstone(args, &tombstone)?;
    Ok(Some(tombstone.artifact))
}

fn validate_cleaned_tombstone(
    args: &HelperArgs,
    tombstone: &CleanedTombstone,
) -> Result<(), CaptureError> {
    if tombstone.version != CLEANED_TOMBSTONE_VERSION
        || tombstone.authorized_uid != args.authorized_uid
        || tombstone.generation != args.generation
    {
        return Err(CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_IDENTITY_INVALID",
            "cleaned generation tombstone has an unsupported version or foreign identity",
        ));
    }
    validate_receipt(args, &tombstone.artifact)
}

fn publish_cleaned_tombstone(
    args: &HelperArgs,
    artifact: &CaptureArtifactState,
) -> Result<(), CaptureError> {
    validate_receipt(args, artifact)?;
    if let Some(existing) = load_cleaned_tombstone_optional(args)? {
        if existing == *artifact {
            // The file may be the result of a prior process that crashed
            // immediately after linking it. Sync the directory again before
            // allowing the pending receipt to be removed.
            return sync_runtime_directory();
        }
        return Err(CaptureError::recovery_with_artifact(
            "LINUX_HELPER_TOMBSTONE_CONFLICT",
            "refused to replace a different cleaned generation tombstone",
            existing,
        ));
    }

    let tombstone = CleanedTombstone {
        version: CLEANED_TOMBSTONE_VERSION,
        authorized_uid: args.authorized_uid,
        generation: args.generation,
        artifact: artifact.clone(),
    };
    let encoded = serde_json::to_vec(&tombstone).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_ENCODE_FAILED",
            format!("could not encode cleaned generation tombstone: {error}"),
        )
    })?;
    if encoded.is_empty() || encoded.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_TOO_LARGE",
            "cleaned generation tombstone exceeds its size bound",
        ));
    }

    let path = cleaned_tombstone_path(args);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&temp)
        .map_err(|error| {
            CaptureError::recovery(
                "LINUX_HELPER_TOMBSTONE_CREATE_FAILED",
                format!("could not stage cleaned generation tombstone: {error}"),
            )
        })?;
    let write_result = file.write_all(&encoded).and_then(|_| file.sync_all());
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp);
        return Err(CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_WRITE_FAILED",
            format!("could not persist cleaned generation tombstone: {error}"),
        ));
    }
    if let Err(error) = std::fs::hard_link(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            if load_cleaned_tombstone_optional(args)?.as_ref() == Some(artifact) {
                return sync_runtime_directory();
            }
        }
        return Err(CaptureError::recovery(
            "LINUX_HELPER_TOMBSTONE_PUBLISH_FAILED",
            format!("could not publish cleaned generation tombstone: {error}"),
        ));
    }
    let _ = std::fs::remove_file(&temp);
    sync_runtime_directory()
}

fn finalize_cleaned_state(
    args: &HelperArgs,
    artifact: &CaptureArtifactState,
) -> Result<(), CaptureError> {
    // Publish first. A crash can therefore leave both records (safe and
    // retryable), but can never leave neither after cleanup was acknowledged.
    publish_cleaned_tombstone(args, artifact)?;
    remove_receipt_if_present(args)
}

fn validate_receipt(
    args: &HelperArgs,
    artifact: &CaptureArtifactState,
) -> Result<(), CaptureError> {
    artifact.validate()?;
    if artifact.generation != args.generation || artifact.owner_uid != Some(args.authorized_uid) {
        return Err(CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_OWNER_MISMATCH",
            "root recovery receipt belongs to another generation or user",
        ));
    }
    LinuxCapturePlan::from_artifact(artifact)?;
    Ok(())
}

fn remove_receipt(args: &HelperArgs) -> Result<(), CaptureError> {
    let path = receipt_path(args);
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_REMOVE_FAILED",
            format!("could not inspect root recovery receipt: {error}"),
        )
    })?;
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o777 != 0o600 {
        return Err(CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_REMOVE_FAILED",
            "refused to remove an unsafe recovery receipt path",
        ));
    }
    std::fs::remove_file(&path).map_err(|error| {
        CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_REMOVE_FAILED",
            format!("could not remove root recovery receipt: {error}"),
        )
    })?;
    sync_runtime_directory()
}

fn remove_receipt_if_present(args: &HelperArgs) -> Result<(), CaptureError> {
    match std::fs::symlink_metadata(receipt_path(args)) {
        Ok(_) => remove_receipt(args),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CaptureError::recovery(
            "LINUX_HELPER_RECEIPT_REMOVE_FAILED",
            format!("could not inspect root recovery receipt: {error}"),
        )),
    }
}

fn sync_runtime_directory() -> Result<(), CaptureError> {
    File::open(HELPER_RUNTIME_DIR)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            CaptureError::recovery(
                "LINUX_HELPER_RECEIPT_SYNC_FAILED",
                format!("could not sync helper runtime directory: {error}"),
            )
        })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    fn test_args() -> HelperArgs {
        HelperArgs {
            authorized_uid: 1000,
            expected_pid: 42,
            generation: 7,
        }
    }

    fn test_artifact(args: &HelperArgs) -> CaptureArtifactState {
        let spec = CaptureInstallSpec {
            generation: args.generation,
            config_revision: 1,
            platform: CapturePlatform::Linux,
            mode: super::super::CaptureMode::Global,
            gateway: "127.0.0.1:1080".parse().unwrap(),
            route_ipv6: true,
            selectors: Vec::new(),
            bypass_ips: Vec::new(),
            taomni_pid: 41,
            helper_pid: Some(42),
        };
        LinuxCapturePlan::from_spec(&spec, args.authorized_uid)
            .unwrap()
            .artifact(Vec::new())
    }

    #[test]
    fn helper_arguments_are_exact_and_bounded() {
        let parsed = parse_args([
            "--serve".into(),
            "--authorized-uid".into(),
            "1000".into(),
            "--expected-pid".into(),
            "42".into(),
            "--generation".into(),
            "9".into(),
        ])
        .unwrap();
        assert_eq!(parsed.authorized_uid, 1000);
        assert_eq!(parsed.expected_pid, 42);
        assert_eq!(parsed.generation, 9);
        assert!(parse_args(["--serve".into()]).is_err());
        assert!(
            parse_args([
                "--serve".into(),
                "--authorized-uid".into(),
                "0".into(),
                "--expected-pid".into(),
                "42".into(),
                "--generation".into(),
                "9".into(),
            ])
            .is_err()
        );
    }

    #[test]
    fn receipt_paths_are_fixed_below_root_runtime_directory() {
        let args = test_args();
        assert_eq!(
            receipt_path(&args),
            Path::new(HELPER_RUNTIME_DIR).join("sockscap-recovery-1000-7.json")
        );
        assert_eq!(
            cleaned_tombstone_path(&args),
            Path::new(HELPER_RUNTIME_DIR).join("sockscap-cleaned-1000-7.json")
        );

        let mut next_generation = args;
        next_generation.generation += 1;
        assert_ne!(
            cleaned_tombstone_path(&args),
            cleaned_tombstone_path(&next_generation)
        );
    }

    #[test]
    fn cleaned_tombstone_is_generation_and_owner_bound() {
        let args = test_args();
        let mut tombstone = CleanedTombstone {
            version: CLEANED_TOMBSTONE_VERSION,
            authorized_uid: args.authorized_uid,
            generation: args.generation,
            artifact: test_artifact(&args),
        };
        validate_cleaned_tombstone(&args, &tombstone).unwrap();

        tombstone.generation += 1;
        assert_eq!(
            validate_cleaned_tombstone(&args, &tombstone)
                .unwrap_err()
                .code,
            "LINUX_HELPER_TOMBSTONE_IDENTITY_INVALID"
        );
    }

    #[test]
    fn pending_recovery_requires_the_exact_root_receipt() {
        let args = test_args();
        let receipt = test_artifact(&args);
        let mut requested = receipt.clone();
        requested
            .process_restores
            .push(super::super::CaptureProcessRestore {
                pid: 123,
                process_start_time: 456,
                owner_uid: args.authorized_uid,
                original_group: "/user.slice/example.scope".into(),
            });
        let error = recovery_artifact_for_request(
            &requested,
            PersistentCleanupState::Pending(receipt.clone()),
        )
        .unwrap_err();
        assert_eq!(error.code, "LINUX_RECOVERY_RECEIPT_MISMATCH");
        assert_eq!(error.artifact, Some(receipt));
    }

    #[test]
    fn cleaned_recovery_uses_authoritative_tombstone_for_stale_app_artifact() {
        let args = test_args();
        let requested = test_artifact(&args);
        let mut cleaned = requested.clone();
        cleaned
            .process_restores
            .push(super::super::CaptureProcessRestore {
                pid: 123,
                process_start_time: 456,
                owner_uid: args.authorized_uid,
                original_group: "/user.slice/example.scope".into(),
            });

        assert_eq!(
            recovery_artifact_for_request(
                &requested,
                PersistentCleanupState::Cleaned(cleaned.clone())
            )
            .unwrap(),
            cleaned
        );
    }

    #[test]
    fn missing_receipt_without_tombstone_never_becomes_success() {
        let args = test_args();
        let error =
            recovery_artifact_for_request(&test_artifact(&args), PersistentCleanupState::Missing)
                .unwrap_err();
        assert_eq!(error.code, "LINUX_HELPER_CLEANUP_PROOF_MISSING");
        assert!(error.recovery_required);
    }

    #[test]
    fn helper_protocol_has_no_generic_execute_variant() {
        let request = HelperRequest::RecoverGeneration { generation: 4 };
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(json, r#"{"type":"recover_generation","generation":4}"#);
        assert!(!json.contains("command"));
        assert!(!json.contains("shell"));
    }

    #[test]
    fn tun_readiness_requires_the_exact_fdinfo_interface() {
        let fdinfo = b"pos:\t0\nflags:\t0100002\nmnt_id:\t25\nino:\t123\niff:\tts7\n";
        assert!(fdinfo_has_exact_tun_interface(fdinfo, "ts7"));
        assert!(!fdinfo_has_exact_tun_interface(fdinfo, "ts8"));
        assert!(!fdinfo_has_exact_tun_interface(
            b"pos:\t0\nflags:\t0100002\n",
            "ts7"
        ));
        assert!(!fdinfo_has_exact_tun_interface(b"iff:\tts7-extra\n", "ts7"));
    }

    #[test]
    fn write_ahead_persistence_failure_prevents_apply() {
        let args = test_args();
        let artifact = test_artifact(&args);
        let events = RefCell::new(Vec::new());

        let error = write_ahead_then(
            &artifact,
            |_| {
                events.borrow_mut().push("persist");
                Err(CaptureError::recovery(
                    "TEST_RECEIPT_FAILURE",
                    "injected persistence failure",
                ))
            },
            || {
                events.borrow_mut().push("apply");
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "TEST_RECEIPT_FAILURE");
        assert_eq!(&*events.borrow(), &["persist"]);
    }

    #[test]
    fn write_ahead_is_published_before_apply_and_apply_failure_is_visible() {
        let args = test_args();
        let artifact = test_artifact(&args);
        let events = RefCell::new(Vec::new());

        let error = write_ahead_then(
            &artifact,
            |_| {
                events.borrow_mut().push("persist");
                Ok(())
            },
            || {
                events.borrow_mut().push("apply");
                Err::<(), _>(CaptureError::recovery_with_artifact(
                    "TEST_APPLY_FAILURE",
                    "injected partial apply failure",
                    artifact.clone(),
                ))
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "TEST_APPLY_FAILURE");
        assert_eq!(error.artifact, Some(artifact));
        assert_eq!(&*events.borrow(), &["persist", "apply"]);
    }
}
