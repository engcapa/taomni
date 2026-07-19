use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::sockscap::types::{AppSelectorKind, CapturePlatform};

pub const MAX_CAPTURE_SELECTORS: usize = 1024;
pub const MAX_CAPTURE_BYPASSES: usize = 1024;
pub const MAX_CAPTURE_PROCESS_RESTORES: usize = 4096;
const MAX_ID_BYTES: usize = 128;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Global,
    ApplicationGroup,
    RuntimeProcesses,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSelector {
    pub profile_id: String,
    pub kind: AppSelectorKind,
    pub value: String,
    pub pid: Option<u32>,
    pub process_start_time: Option<u64>,
    pub include_children: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInstallSpec {
    pub generation: u64,
    pub config_revision: u64,
    pub platform: CapturePlatform,
    pub mode: CaptureMode,
    pub gateway: SocketAddr,
    pub route_ipv6: bool,
    pub selectors: Vec<CaptureSelector>,
    /// Numeric IPs only. Hostname resolution and credentials stay outside the
    /// helper so setup cannot leak DNS or accidentally persist a secret.
    pub bypass_ips: Vec<IpAddr>,
    pub taomni_pid: u32,
    pub helper_pid: Option<u32>,
}

impl CaptureInstallSpec {
    pub fn validate(&self) -> Result<(), CaptureError> {
        if self.generation == 0 || self.config_revision == 0 {
            return Err(CaptureError::invalid(
                "CAPTURE_GENERATION_INVALID",
                "capture generation and config revision must be non-zero",
            ));
        }
        if self.platform == CapturePlatform::Unknown || self.platform != CapturePlatform::current()
        {
            return Err(CaptureError::invalid(
                "CAPTURE_PLATFORM_MISMATCH",
                "capture request does not match the helper platform",
            ));
        }
        if self.gateway.ip().is_unspecified() || !self.gateway.ip().is_loopback() {
            return Err(CaptureError::invalid(
                "CAPTURE_GATEWAY_INVALID",
                "capture gateway must be a concrete loopback address",
            ));
        }
        if self.gateway.port() == 0 {
            return Err(CaptureError::invalid(
                "CAPTURE_GATEWAY_INVALID",
                "capture gateway port must be non-zero",
            ));
        }
        if self.taomni_pid == 0 || self.helper_pid == Some(0) {
            return Err(CaptureError::invalid(
                "CAPTURE_PID_INVALID",
                "Taomni/helper process ids must be non-zero",
            ));
        }
        if self.selectors.len() > MAX_CAPTURE_SELECTORS {
            return Err(CaptureError::invalid(
                "CAPTURE_SELECTOR_LIMIT",
                format!("capture request exceeds {MAX_CAPTURE_SELECTORS} selectors"),
            ));
        }
        if self.bypass_ips.len() > MAX_CAPTURE_BYPASSES {
            return Err(CaptureError::invalid(
                "CAPTURE_BYPASS_LIMIT",
                format!("capture request exceeds {MAX_CAPTURE_BYPASSES} bypass addresses"),
            ));
        }
        if self.mode != CaptureMode::Global && self.selectors.is_empty() {
            return Err(CaptureError::invalid(
                "CAPTURE_SELECTOR_REQUIRED",
                "selected capture requires at least one selector",
            ));
        }
        if self.mode == CaptureMode::Global && !self.selectors.is_empty() {
            return Err(CaptureError::invalid(
                "CAPTURE_SELECTOR_CONFLICT",
                "global capture must not carry application or PID selectors",
            ));
        }

        let mut selector_keys = HashSet::new();
        for selector in &self.selectors {
            validate_safe_id("profile id", &selector.profile_id)?;
            if selector.value.is_empty()
                || selector.value.len() > MAX_PATH_BYTES
                || selector.value.contains('\0')
            {
                return Err(CaptureError::invalid(
                    "CAPTURE_SELECTOR_INVALID",
                    "selector value is empty, too long, or contains NUL",
                ));
            }
            match self.mode {
                CaptureMode::ApplicationGroup => {
                    if selector.pid.is_some() || selector.process_start_time.is_some() {
                        return Err(CaptureError::invalid(
                            "CAPTURE_SELECTOR_INVALID",
                            "application-group selectors cannot contain runtime PID identity",
                        ));
                    }
                }
                CaptureMode::RuntimeProcesses => {
                    if selector.pid == Some(0)
                        || selector.pid.is_none()
                        || selector.process_start_time == Some(0)
                        || selector.process_start_time.is_none()
                    {
                        return Err(CaptureError::invalid(
                            "CAPTURE_SELECTOR_INVALID",
                            "runtime selectors require a non-zero PID and process start token",
                        ));
                    }
                }
                CaptureMode::Global => unreachable!("global selectors were rejected above"),
            }
            let key = (
                selector.profile_id.as_str(),
                selector.kind,
                selector.value.as_str(),
                selector.pid,
                selector.process_start_time,
            );
            if !selector_keys.insert(key) {
                return Err(CaptureError::invalid(
                    "CAPTURE_SELECTOR_DUPLICATE",
                    "capture selectors must be unique",
                ));
            }
        }

        let mut bypasses = HashSet::new();
        for bypass in &self.bypass_ips {
            if bypass.is_unspecified() || !bypasses.insert(*bypass) {
                return Err(CaptureError::invalid(
                    "CAPTURE_BYPASS_INVALID",
                    "bypass addresses must be concrete and unique",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureArtifactState {
    pub adapter: String,
    pub generation: u64,
    pub interface_names: Vec<String>,
    pub rule_ids: Vec<String>,
    pub route_ids: Vec<String>,
    pub cgroup_paths: Vec<String>,
    pub driver_service: Option<String>,
    pub extension_bundle_id: Option<String>,
    /// Original cgroup/container membership for exact process incarnations.
    /// This is non-secret recovery data; a reused PID is never restored.
    #[serde(default)]
    pub process_restores: Vec<CaptureProcessRestore>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProcessRestore {
    pub pid: u32,
    pub process_start_time: u64,
    pub original_group: String,
}

impl CaptureArtifactState {
    pub fn validate(&self) -> Result<(), CaptureError> {
        validate_safe_id("adapter id", &self.adapter)?;
        if self.generation == 0 {
            return Err(CaptureError::invalid(
                "CAPTURE_ARTIFACT_INVALID",
                "artifact generation must be non-zero",
            ));
        }
        if self.process_restores.len() > MAX_CAPTURE_PROCESS_RESTORES {
            return Err(CaptureError::invalid(
                "CAPTURE_ARTIFACT_INVALID",
                format!("artifact exceeds {MAX_CAPTURE_PROCESS_RESTORES} process restore records"),
            ));
        }
        for value in self
            .interface_names
            .iter()
            .chain(self.rule_ids.iter())
            .chain(self.route_ids.iter())
            .chain(self.cgroup_paths.iter())
            .chain(self.driver_service.iter())
            .chain(self.extension_bundle_id.iter())
        {
            if value.is_empty() || value.len() > MAX_PATH_BYTES || value.contains('\0') {
                return Err(CaptureError::invalid(
                    "CAPTURE_ARTIFACT_INVALID",
                    "artifact identifier is empty, too long, or contains NUL",
                ));
            }
        }
        let mut restored_processes = HashSet::new();
        for restore in &self.process_restores {
            if restore.pid == 0
                || restore.process_start_time == 0
                || restore.original_group.is_empty()
                || restore.original_group.len() > MAX_PATH_BYTES
                || restore.original_group.contains('\0')
                || !restored_processes.insert((restore.pid, restore.process_start_time))
            {
                return Err(CaptureError::invalid(
                    "CAPTURE_ARTIFACT_INVALID",
                    "process restore records must have a unique PID/start token and bounded group",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureHandle {
    pub generation: u64,
    pub config_revision: u64,
    pub helper_pid: u32,
    pub artifact: CaptureArtifactState,
}

impl CaptureHandle {
    pub fn validate_for(&self, spec: &CaptureInstallSpec) -> Result<(), CaptureError> {
        self.artifact.validate()?;
        if self.generation != spec.generation
            || self.artifact.generation != spec.generation
            || self.config_revision != spec.config_revision
            || self.helper_pid == 0
        {
            return Err(CaptureError::recovery_with_artifact(
                "CAPTURE_HANDLE_INVALID",
                "helper returned a handle for a different transaction",
                self.artifact.clone(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterProbe {
    pub adapter: String,
    pub platform: CapturePlatform,
    pub installed: bool,
    pub privileged_helper_ready: bool,
    pub signature_verified: bool,
    pub global_available: bool,
    pub application_group_available: bool,
    pub runtime_pid_available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct CaptureError {
    pub code: String,
    pub message: String,
    pub recovery_required: bool,
    pub artifact: Option<CaptureArtifactState>,
}

impl CaptureError {
    pub fn invalid(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recovery_required: false,
            artifact: None,
        }
    }

    pub fn recovery(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recovery_required: true,
            artifact: None,
        }
    }

    pub fn recovery_with_artifact(
        code: impl Into<String>,
        message: impl Into<String>,
        artifact: CaptureArtifactState,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recovery_required: true,
            artifact: Some(artifact),
        }
    }
}

#[async_trait]
pub trait CaptureAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn platform(&self) -> CapturePlatform;

    /// Read-only probe. It must not install drivers, create interfaces or edit
    /// routes merely because the capability screen was opened.
    async fn probe(&self) -> AdapterProbe;

    /// Install the complete capture transaction or return an error. Partial
    /// setup must remain represented by a recovery artifact.
    async fn install(&self, spec: &CaptureInstallSpec) -> Result<CaptureHandle, CaptureError>;

    /// Atomically replace selector/bypass state for an existing generation.
    async fn update(
        &self,
        handle: &CaptureHandle,
        spec: &CaptureInstallSpec,
    ) -> Result<CaptureHandle, CaptureError>;

    /// Remove all artifacts owned by this handle. Success is the only proof
    /// that permits the recovery journal to be cleared.
    async fn stop(&self, handle: &CaptureHandle) -> Result<(), CaptureError>;

    /// Idempotent cleanup after restart/crash using persisted, non-secret
    /// artifact identifiers.
    async fn recover(&self, artifact: &CaptureArtifactState) -> Result<(), CaptureError>;

    /// Prove helper liveness and return the latest complete recovery receipt.
    /// Selected-application adapters may attach newly launched children during
    /// this call, so callers must persist the returned handle before accepting
    /// the heartbeat as successful.
    async fn heartbeat(&self, handle: &CaptureHandle) -> Result<CaptureHandle, CaptureError>;
}

fn validate_safe_id(label: &str, value: &str) -> Result<(), CaptureError> {
    if value.is_empty() || value.len() > MAX_ID_BYTES {
        return Err(CaptureError::invalid(
            "CAPTURE_ID_INVALID",
            format!("{label} must be 1-{MAX_ID_BYTES} ASCII characters"),
        ));
    }
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'/')
    }) {
        return Err(CaptureError::invalid(
            "CAPTURE_ID_INVALID",
            format!("{label} contains unsupported characters"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(mode: CaptureMode) -> CaptureInstallSpec {
        CaptureInstallSpec {
            generation: 1,
            config_revision: 2,
            platform: CapturePlatform::current(),
            mode,
            gateway: "127.0.0.1:32100".parse().unwrap(),
            route_ipv6: true,
            selectors: Vec::new(),
            bypass_ips: vec!["127.0.0.1".parse().unwrap()],
            taomni_pid: 100,
            helper_pid: None,
        }
    }

    #[test]
    fn global_spec_requires_loopback_gateway_and_no_selectors() {
        let mut spec = base(CaptureMode::Global);
        assert!(spec.validate().is_ok());
        spec.gateway = "192.0.2.1:32100".parse().unwrap();
        assert_eq!(spec.validate().unwrap_err().code, "CAPTURE_GATEWAY_INVALID");
    }

    #[test]
    fn runtime_selector_requires_pid_reuse_token() {
        let mut spec = base(CaptureMode::RuntimeProcesses);
        spec.selectors.push(CaptureSelector {
            profile_id: "profile-1".into(),
            kind: AppSelectorKind::ExecutablePath,
            value: "/usr/bin/curl".into(),
            pid: Some(42),
            process_start_time: None,
            include_children: true,
        });
        assert_eq!(
            spec.validate().unwrap_err().code,
            "CAPTURE_SELECTOR_INVALID"
        );
        spec.selectors[0].process_start_time = Some(1234);
        assert!(spec.validate().is_ok());
    }

    #[test]
    fn duplicate_bypass_is_rejected() {
        let mut spec = base(CaptureMode::Global);
        spec.bypass_ips.push("127.0.0.1".parse().unwrap());
        assert_eq!(spec.validate().unwrap_err().code, "CAPTURE_BYPASS_INVALID");
    }

    #[test]
    fn artifact_identifiers_are_non_secret_and_bounded() {
        let artifact = CaptureArtifactState {
            adapter: "linux_nft_tun".into(),
            generation: 1,
            interface_names: vec!["taomni-sc-1".into()],
            rule_ids: vec!["inet:taomni_sockscap_1".into()],
            route_ids: vec!["table:42101".into()],
            cgroup_paths: vec!["/sys/fs/cgroup/taomni/sockscap-1".into()],
            driver_service: None,
            extension_bundle_id: None,
            process_restores: vec![CaptureProcessRestore {
                pid: 42,
                process_start_time: 1234,
                original_group: "/user.slice/example.scope".into(),
            }],
        };
        assert!(artifact.validate().is_ok());
    }
}
