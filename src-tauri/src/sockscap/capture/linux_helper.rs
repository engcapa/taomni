//! Privileged Linux helper executable and narrow request dispatcher.
//!
//! This process owns only cgroup/TUN/nft/policy-route mutations. Proxy
//! credentials, routing rules, DNS payloads, and arbitrary commands never cross
//! this boundary. A root-owned receipt closes the crash window between the
//! first mutation and the app persisting the helper response.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::net::TcpStream;

use super::helper_protocol::{HelperRequest, HelperResponse};
use super::linux::{LINUX_ADAPTER_ID, LinuxCapturePlan, LinuxPrerequisites};
use super::linux_process::{
    LinuxPreparedCapture, activate_linux_capture, prepare_linux_capture, refresh_linux_membership,
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
            global_available: ready,
            application_group_available: ready && prerequisites.cgroup_v2,
            runtime_pid_available: ready && prerequisites.cgroup_v2,
            detail: format!(
                "tun={}, cgroup_v2={}, ip={}, nft={}, root_or_cap_net_admin={}",
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
        if self.entries.contains_key(&spec.generation) || receipt_path(&self.args).exists() {
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_ARTIFACT_EXISTS",
                "this capture generation already has helper-owned recovery state",
            ));
        }
        spec.helper_pid = Some(self.helper_pid);
        spec.validate()?;
        let plan = LinuxCapturePlan::from_spec(&spec, self.args.authorized_uid)?;
        let initial_artifact = plan.artifact(Vec::new());
        create_receipt(&self.args, &initial_artifact)?;

        let prepared =
            match prepare_linux_capture(&self.runner, &spec, self.args.authorized_uid).await {
                Ok(prepared) => prepared,
                Err(error) => {
                    if let Some(artifact) = &error.artifact {
                        let _ = replace_receipt(&self.args, artifact);
                    }
                    if !error.recovery_required {
                        let _ = remove_receipt(&self.args);
                    }
                    return Err(error);
                }
            };
        replace_receipt(&self.args, &prepared.artifact)?;
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
        if !process_has_tun_fd(runtime_pid) {
            return Err(CaptureError::invalid(
                "LINUX_TUN_RUNTIME_NOT_READY",
                "verified runtime has not opened /dev/net/tun",
            ));
        }
        let entry = self.entries.get_mut(&generation).ok_or_else(|| {
            CaptureError::recovery(
                "LINUX_CAPTURE_NOT_PREPARED",
                "activation requires a helper-owned prepared generation",
            )
        })?;
        if entry.active {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_ALREADY_ACTIVE",
                "capture generation is already active",
            ));
        }
        ensure_gateway_ready(entry.prepared.spec.gateway).await?;
        match activate_linux_capture(&self.runner, &entry.prepared).await {
            Ok(handle) => {
                entry.active = true;
                replace_receipt(&self.args, &handle.artifact)?;
                Ok(HelperResponse::Installed { handle })
            }
            Err(error) => {
                if let Some(artifact) = &error.artifact {
                    let _ = replace_receipt(&self.args, artifact);
                }
                if !error.recovery_required {
                    self.entries.remove(&generation);
                    let _ = remove_receipt(&self.args);
                }
                Err(error)
            }
        }
    }

    fn heartbeat(&mut self, generation: u64) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(generation)?;
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
        let artifact = refresh_linux_membership(&entry.prepared)?;
        replace_receipt(&self.args, &artifact)?;
        entry.prepared.artifact = artifact.clone();
        Ok(HelperResponse::Heartbeat {
            helper_pid: self.helper_pid,
            generation,
            artifact: Some(artifact),
        })
    }

    async fn stop(&mut self, generation: u64) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(generation)?;
        let artifact = self
            .entries
            .get(&generation)
            .map(|entry| entry.prepared.artifact.clone())
            .map(Ok)
            .unwrap_or_else(|| load_receipt(&self.args))?;
        self.validate_artifact(&artifact)?;
        stop_linux_capture(&self.runner, &artifact).await?;
        self.entries.remove(&generation);
        remove_receipt(&self.args)?;
        Ok(HelperResponse::Stopped)
    }

    async fn recover(
        &mut self,
        requested: &CaptureArtifactState,
    ) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(requested.generation)?;
        let receipt = load_receipt(&self.args)?;
        if requested != &receipt {
            return Err(CaptureError::recovery_with_artifact(
                "LINUX_RECOVERY_RECEIPT_MISMATCH",
                "app and root helper recovery receipts differ",
                receipt,
            ));
        }
        self.recover_artifact(requested).await
    }

    async fn recover_generation(
        &mut self,
        generation: u64,
    ) -> Result<HelperResponse, CaptureError> {
        self.validate_generation(generation)?;
        let artifact = load_receipt(&self.args)?;
        self.recover_artifact(&artifact).await
    }

    async fn recover_artifact(
        &mut self,
        artifact: &CaptureArtifactState,
    ) -> Result<HelperResponse, CaptureError> {
        self.validate_artifact(artifact)?;
        stop_linux_capture(&self.runner, artifact).await?;
        self.entries.remove(&artifact.generation);
        remove_receipt(&self.args)?;
        Ok(HelperResponse::Recovered)
    }

    async fn cleanup_all(&mut self) -> Result<(), CaptureError> {
        let mut artifacts = self
            .entries
            .drain()
            .map(|(_, entry)| entry.prepared.artifact)
            .collect::<Vec<_>>();
        // A freshly relaunched helper can inherit only the root-owned receipt
        // after the previous process died mid-transaction. Never delete that
        // receipt until its deterministic cleanup has actually succeeded.
        if artifacts.is_empty() && receipt_path(&self.args).exists() {
            artifacts.push(load_receipt(&self.args)?);
        }
        let mut failures = Vec::new();
        for artifact in artifacts {
            if let Err(error) = stop_linux_capture(&self.runner, &artifact).await {
                failures.push(error.message);
            }
        }
        if failures.is_empty() {
            if receipt_path(&self.args).exists() {
                remove_receipt(&self.args)?;
            }
            Ok(())
        } else {
            Err(CaptureError::recovery(
                "LINUX_HELPER_DISCONNECT_CLEANUP_FAILED",
                failures.join("; "),
            ))
        }
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

fn process_has_tun_fd(pid: u32) -> bool {
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    entries.flatten().take(65_536).any(|entry| {
        std::fs::read_link(entry.path()).is_ok_and(|path| path == Path::new("/dev/net/tun"))
    })
}

fn receipt_path(args: &HelperArgs) -> PathBuf {
    Path::new(HELPER_RUNTIME_DIR).join(format!(
        "sockscap-recovery-{}-{}.json",
        args.authorized_uid, args.generation
    ))
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
    sync_runtime_directory()
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
        || metadata.mode() & 0o077 != 0
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
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o077 != 0 {
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
    use super::*;

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
        let args = HelperArgs {
            authorized_uid: 1000,
            expected_pid: 42,
            generation: 7,
        };
        assert_eq!(
            receipt_path(&args),
            Path::new(HELPER_RUNTIME_DIR).join("sockscap-recovery-1000-7.json")
        );
    }

    #[test]
    fn helper_protocol_has_no_generic_execute_variant() {
        let request = HelperRequest::RecoverGeneration { generation: 4 };
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(json, r#"{"type":"recover_generation","generation":4}"#);
        assert!(!json.contains("command"));
        assert!(!json.contains("shell"));
    }
}
