//! Linux cgroup v2 + nftables + fwmark/TUN capture plan.
//!
//! This module deliberately produces structured argv and an nftables batch;
//! it never emits a shell command. The privileged helper owns execution and
//! must resolve [`LinuxProgram`] through a fixed absolute-path allowlist.

use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    CaptureArtifactState, CaptureError, CaptureInstallSpec, CaptureMode, CaptureProcessRestore,
};
use crate::sockscap::types::{AppSelectorKind, CapturePlatform};

pub const LINUX_ADAPTER_ID: &str = "linux_cgroup_nft_tun_v1";
pub const CGROUP_ROOT: &str = "/sys/fs/cgroup";
pub const CGROUP_PARENT: &str = "taomni.sockscap";
pub const TUN_IPV4_CIDR: &str = "10.0.0.33/24";
pub const TUN_MTU: u16 = 1500;
const FWMARK_BASE: u32 = 0x5440_0000;
const ROUTE_TABLE_BASE: u32 = 42_000;
const RULE_PRIORITY_BASE: u32 = 12_000;
const ROUTE_SLOT_COUNT: u64 = 1_000;
const CAP_NET_ADMIN_BIT: u32 = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinuxProgram {
    Ip,
    Nft,
}

impl LinuxProgram {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ip => "ip",
            Self::Nft => "nft",
        }
    }
}

/// One allowlisted executable invocation. `stdin` is used only for an atomic
/// nftables batch; no string is ever interpreted by a shell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxCommand {
    pub program: LinuxProgram,
    pub args: Vec<String>,
    pub stdin: Option<String>,
}

impl LinuxCommand {
    fn ip(args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            program: LinuxProgram::Ip,
            args: args.into_iter().map(Into::into).collect(),
            stdin: None,
        }
    }

    fn nft_batch(batch: String) -> Self {
        Self {
            program: LinuxProgram::Nft,
            args: vec!["--check".into(), "--file".into(), "-".into()],
            stdin: Some(batch),
        }
    }

    fn nft_apply(batch: String) -> Self {
        Self {
            program: LinuxProgram::Nft,
            args: vec!["--file".into(), "-".into()],
            stdin: Some(batch),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxCapturePlan {
    pub generation: u64,
    pub mode: CaptureMode,
    pub tun_name: String,
    pub nft_table: String,
    pub capture_cgroup_relative: String,
    pub bypass_cgroup_relative: String,
    pub fwmark: u32,
    pub route_table: u32,
    pub rule_priority: u32,
    pub owner_uid: u32,
    pub route_ipv6: bool,
    pub bypass_ips: Vec<IpAddr>,
}

impl LinuxCapturePlan {
    pub fn from_spec(spec: &CaptureInstallSpec, owner_uid: u32) -> Result<Self, CaptureError> {
        spec.validate()?;
        if spec.platform != CapturePlatform::Linux {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_PLATFORM_MISMATCH",
                "Linux capture plan requires a Linux install specification",
            ));
        }
        let helper_pid = spec.helper_pid.ok_or_else(|| {
            CaptureError::invalid(
                "LINUX_HELPER_PID_REQUIRED",
                "Linux capture setup requires the verified helper PID",
            )
        })?;
        for selector in &spec.selectors {
            if selector.pid == Some(spec.taomni_pid) || selector.pid == Some(helper_pid) {
                return Err(CaptureError::invalid(
                    "LINUX_SELF_CAPTURE_FORBIDDEN",
                    "Taomni and its helper can never be selected for capture",
                ));
            }
            if spec.mode == CaptureMode::ApplicationGroup
                && !matches!(
                    selector.kind,
                    AppSelectorKind::ExecutablePath | AppSelectorKind::LinuxCgroup
                )
            {
                return Err(CaptureError::invalid(
                    "LINUX_SELECTOR_UNSUPPORTED",
                    "Linux application capture accepts executable-path or cgroup selectors",
                ));
            }
        }

        let suffix = encode_base36(spec.generation);
        let tun_name = format!("ts{suffix}");
        if tun_name.len() > libc::IFNAMSIZ - 1 {
            return Err(CaptureError::invalid(
                "LINUX_TUN_NAME_INVALID",
                "derived Linux TUN name exceeds IFNAMSIZ",
            ));
        }
        let slot = (spec.generation % ROUTE_SLOT_COUNT) as u32;
        let generation_component = format!("g{}", spec.generation);
        let cgroup_base = format!("{CGROUP_PARENT}/{generation_component}");
        Ok(Self {
            generation: spec.generation,
            mode: spec.mode,
            tun_name,
            nft_table: format!("taomni_sc_{generation_component}"),
            capture_cgroup_relative: format!("{cgroup_base}/capture"),
            bypass_cgroup_relative: format!("{cgroup_base}/bypass"),
            fwmark: FWMARK_BASE | (spec.generation as u32 & 0x000f_ffff),
            route_table: ROUTE_TABLE_BASE + slot,
            rule_priority: RULE_PRIORITY_BASE + slot,
            owner_uid,
            route_ipv6: spec.route_ipv6,
            bypass_ips: spec.bypass_ips.clone(),
        })
    }

    pub fn capture_cgroup_path(&self) -> PathBuf {
        Path::new(CGROUP_ROOT).join(&self.capture_cgroup_relative)
    }

    pub fn bypass_cgroup_path(&self) -> PathBuf {
        Path::new(CGROUP_ROOT).join(&self.bypass_cgroup_relative)
    }

    pub fn cgroup_paths(&self) -> Vec<PathBuf> {
        vec![self.capture_cgroup_path(), self.bypass_cgroup_path()]
    }

    /// Commands before the nftables transaction. The helper creates both
    /// cgroups and records process membership separately before these run.
    pub fn device_setup_commands(&self) -> Vec<LinuxCommand> {
        vec![
            LinuxCommand::ip([
                "tuntap".into(),
                "add".into(),
                "dev".into(),
                self.tun_name.clone(),
                "mode".into(),
                "tun".into(),
                "user".into(),
                self.owner_uid.to_string(),
            ]),
            LinuxCommand::ip([
                "address".into(),
                "replace".into(),
                TUN_IPV4_CIDR.into(),
                "dev".into(),
                self.tun_name.clone(),
            ]),
            LinuxCommand::ip([
                "link".into(),
                "set".into(),
                "dev".into(),
                self.tun_name.clone(),
                "mtu".into(),
                TUN_MTU.to_string(),
                "up".into(),
            ]),
        ]
    }

    /// Validate the complete nft batch without changing the ruleset. Run this
    /// immediately before [`Self::activation_commands`].
    pub fn nft_check_command(&self) -> LinuxCommand {
        LinuxCommand::nft_batch(self.nft_batch())
    }

    /// Install packet marking and policy routes after the unprivileged TUN
    /// runtime has confirmed that it opened the persistent interface.
    pub fn activation_commands(&self) -> Vec<LinuxCommand> {
        let mark = format!("0x{:08x}", self.fwmark);
        let table = self.route_table.to_string();
        let priority = self.rule_priority.to_string();
        let mut commands = vec![
            LinuxCommand::nft_apply(self.nft_batch()),
            LinuxCommand::ip([
                "rule".into(),
                "add".into(),
                "pref".into(),
                priority.clone(),
                "fwmark".into(),
                mark.clone(),
                "lookup".into(),
                table.clone(),
            ]),
            LinuxCommand::ip([
                "route".into(),
                "replace".into(),
                "default".into(),
                "dev".into(),
                self.tun_name.clone(),
                "table".into(),
                table.clone(),
            ]),
        ];
        if self.route_ipv6 {
            commands.extend([
                LinuxCommand::ip([
                    "-6".into(),
                    "rule".into(),
                    "add".into(),
                    "pref".into(),
                    priority,
                    "fwmark".into(),
                    mark,
                    "lookup".into(),
                    table.clone(),
                ]),
                LinuxCommand::ip([
                    "-6".into(),
                    "route".into(),
                    "replace".into(),
                    "default".into(),
                    "dev".into(),
                    self.tun_name.clone(),
                    "table".into(),
                    table,
                ]),
            ]);
        }
        commands
    }

    /// Best-effort commands are intentionally complete for IPv4 and IPv6,
    /// even if IPv6 was disabled. Recovery runs every command and then verifies
    /// absence rather than treating one "not found" status as success proof.
    pub fn cleanup_commands(&self) -> Vec<LinuxCommand> {
        let mark = format!("0x{:08x}", self.fwmark);
        let table = self.route_table.to_string();
        let priority = self.rule_priority.to_string();
        vec![
            LinuxCommand::ip([
                "rule".into(),
                "del".into(),
                "pref".into(),
                priority.clone(),
                "fwmark".into(),
                mark.clone(),
                "lookup".into(),
                table.clone(),
            ]),
            LinuxCommand::ip([
                "-6".into(),
                "rule".into(),
                "del".into(),
                "pref".into(),
                priority,
                "fwmark".into(),
                mark,
                "lookup".into(),
                table.clone(),
            ]),
            LinuxCommand::ip([
                "route".into(),
                "flush".into(),
                "table".into(),
                table.clone(),
            ]),
            LinuxCommand::ip([
                "-6".into(),
                "route".into(),
                "flush".into(),
                "table".into(),
                table,
            ]),
            LinuxCommand {
                program: LinuxProgram::Nft,
                args: vec![
                    "delete".into(),
                    "table".into(),
                    "inet".into(),
                    self.nft_table.clone(),
                ],
                stdin: None,
            },
            LinuxCommand::ip([
                "link".into(),
                "delete".into(),
                "dev".into(),
                self.tun_name.clone(),
            ]),
        ]
    }

    pub fn nft_batch(&self) -> String {
        let mut lines = vec![
            format!("add table inet {}", self.nft_table),
            format!(
                "add chain inet {} output {{ type route hook output priority mangle; policy accept; }}",
                self.nft_table
            ),
            format!(
                "add rule inet {} output ip daddr 127.0.0.0/8 return",
                self.nft_table
            ),
            format!(
                "add rule inet {} output ip6 daddr ::1 return",
                self.nft_table
            ),
        ];
        let mut bypasses = self.bypass_ips.clone();
        bypasses.sort();
        bypasses.dedup();
        for address in bypasses {
            let family = match address {
                IpAddr::V4(_) => "ip",
                IpAddr::V6(_) => "ip6",
            };
            lines.push(format!(
                "add rule inet {} output {family} daddr {address} return",
                self.nft_table
            ));
        }

        let mark = format!("0x{:08x}", self.fwmark);
        match self.mode {
            CaptureMode::Global => {
                let level = cgroup_level(&self.bypass_cgroup_relative);
                lines.push(format!(
                    "add rule inet {} output meta l4proto {{ tcp, udp }} socket cgroupv2 level {level} \"{}\" return",
                    self.nft_table, self.bypass_cgroup_relative
                ));
                lines.push(format!(
                    "add rule inet {} output meta l4proto {{ tcp, udp }} meta mark set {mark}",
                    self.nft_table
                ));
            }
            CaptureMode::ApplicationGroup | CaptureMode::RuntimeProcesses => {
                let level = cgroup_level(&self.capture_cgroup_relative);
                lines.push(format!(
                    "add rule inet {} output meta l4proto {{ tcp, udp }} socket cgroupv2 level {level} \"{}\" meta mark set {mark}",
                    self.nft_table, self.capture_cgroup_relative
                ));
            }
        }
        lines.push(String::new());
        lines.join("\n")
    }

    pub fn artifact(&self, process_restores: Vec<CaptureProcessRestore>) -> CaptureArtifactState {
        CaptureArtifactState {
            adapter: LINUX_ADAPTER_ID.into(),
            generation: self.generation,
            interface_names: vec![self.tun_name.clone()],
            rule_ids: vec![format!("inet:{}", self.nft_table)],
            route_ids: self.expected_route_ids(),
            cgroup_paths: self
                .cgroup_paths()
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            driver_service: None,
            extension_bundle_id: None,
            process_restores,
        }
    }

    /// Reconstruct a cleanup plan only when every persisted identifier exactly
    /// matches the deterministic ownership namespace for its generation.
    pub fn from_artifact(artifact: &CaptureArtifactState) -> Result<Self, CaptureError> {
        artifact.validate()?;
        if artifact.adapter != LINUX_ADAPTER_ID {
            return Err(CaptureError::invalid(
                "LINUX_ARTIFACT_FOREIGN",
                "recovery artifact belongs to another capture adapter",
            ));
        }
        for restore in &artifact.process_restores {
            validate_cgroup_relative(&restore.original_group)?;
        }
        let placeholder = CaptureInstallSpec {
            generation: artifact.generation,
            config_revision: 1,
            platform: CapturePlatform::Linux,
            mode: CaptureMode::Global,
            gateway: "127.0.0.1:1".parse().expect("literal loopback socket"),
            route_ipv6: true,
            selectors: Vec::new(),
            bypass_ips: Vec::new(),
            taomni_pid: 1,
            helper_pid: Some(2),
        };
        let plan = Self::from_spec(&placeholder, 0)?;
        let expected = plan.artifact(Vec::new());
        if artifact.interface_names != expected.interface_names
            || artifact.rule_ids != expected.rule_ids
            || artifact.route_ids != expected.route_ids
            || artifact.cgroup_paths != expected.cgroup_paths
            || artifact.driver_service.is_some()
            || artifact.extension_bundle_id.is_some()
        {
            return Err(CaptureError::invalid(
                "LINUX_ARTIFACT_OWNERSHIP_INVALID",
                "recovery artifact identifiers are outside Taomni's deterministic namespace",
            ));
        }
        Ok(plan)
    }

    fn expected_route_ids(&self) -> Vec<String> {
        vec![
            format!(
                "ipv4-rule:{}:0x{:08x}:{}",
                self.rule_priority, self.fwmark, self.route_table
            ),
            format!(
                "ipv6-rule:{}:0x{:08x}:{}",
                self.rule_priority, self.fwmark, self.route_table
            ),
            format!("ipv4-table:{}", self.route_table),
            format!("ipv6-table:{}", self.route_table),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxPrerequisites {
    pub tun_present: bool,
    pub cgroup_v2: bool,
    pub ip_path: Option<PathBuf>,
    pub nft_path: Option<PathBuf>,
    pub effective_uid: u32,
    pub cap_net_admin: bool,
}

impl LinuxPrerequisites {
    pub fn probe() -> Self {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let effective_uid = parse_effective_uid(&status).unwrap_or(u32::MAX);
        let cap_net_admin = parse_cap_eff(&status)
            .is_some_and(|capabilities| capabilities & (1_u64 << CAP_NET_ADMIN_BIT) != 0);
        Self {
            tun_present: Path::new("/dev/net/tun").exists(),
            cgroup_v2: Path::new(CGROUP_ROOT).join("cgroup.controllers").is_file(),
            ip_path: resolve_allowlisted_program(LinuxProgram::Ip),
            nft_path: resolve_allowlisted_program(LinuxProgram::Nft),
            effective_uid,
            cap_net_admin,
        }
    }

    pub fn ready_for_privileged_mutation(&self) -> bool {
        self.tun_present
            && self.cgroup_v2
            && self.ip_path.is_some()
            && self.nft_path.is_some()
            && (self.effective_uid == 0 || self.cap_net_admin)
    }
}

pub fn resolve_allowlisted_program(program: LinuxProgram) -> Option<PathBuf> {
    let name = program.name();
    ["/usr/sbin", "/usr/bin", "/sbin", "/bin"]
        .into_iter()
        .map(|directory| Path::new(directory).join(name))
        .find(|path| path.is_file())
}

pub fn validate_cgroup_relative(value: &str) -> Result<(), CaptureError> {
    let value = value.strip_prefix('/').unwrap_or(value);
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(CaptureError::invalid(
            "LINUX_CGROUP_PATH_INVALID",
            "cgroup path is empty, too long, or contains NUL",
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            !matches!(component, Component::Normal(_))
                || component.as_os_str().as_encoded_bytes().iter().any(|byte| {
                    !byte.is_ascii_alphanumeric()
                        && !matches!(byte, b'_' | b'-' | b'.' | b':' | b'@' | b'\\')
                })
        })
    {
        return Err(CaptureError::invalid(
            "LINUX_CGROUP_PATH_INVALID",
            "cgroup path must stay below the unified cgroup root",
        ));
    }
    Ok(())
}

fn cgroup_level(relative: &str) -> usize {
    relative
        .split('/')
        .filter(|component| !component.is_empty())
        .count()
}

fn encode_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut bytes = [b'0'; 13];
    let mut cursor = bytes.len();
    loop {
        cursor -= 1;
        bytes[cursor] = DIGITS[(value % 36) as usize];
        value /= 36;
        if value == 0 {
            break;
        }
    }
    String::from_utf8(bytes[cursor..].to_vec()).expect("base36 is ASCII")
}

fn parse_effective_uid(status: &str) -> Option<u32> {
    let line = status.lines().find(|line| line.starts_with("Uid:"))?;
    line.split_whitespace().nth(2)?.parse().ok()
}

fn parse_cap_eff(status: &str) -> Option<u64> {
    let value = status
        .lines()
        .find_map(|line| line.strip_prefix("CapEff:"))?;
    u64::from_str_radix(value.trim(), 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::capture::CaptureSelector;

    fn spec(mode: CaptureMode) -> CaptureInstallSpec {
        CaptureInstallSpec {
            generation: 987_654_321,
            config_revision: 7,
            platform: CapturePlatform::Linux,
            mode,
            gateway: "127.0.0.1:32100".parse().unwrap(),
            route_ipv6: true,
            selectors: Vec::new(),
            bypass_ips: vec![
                "203.0.113.9".parse().unwrap(),
                "2001:db8::9".parse().unwrap(),
            ],
            taomni_pid: 100,
            helper_pid: Some(101),
        }
    }

    #[test]
    fn deterministic_plan_stays_inside_owned_namespaces() {
        let plan = LinuxCapturePlan::from_spec(&spec(CaptureMode::Global), 1000).unwrap();
        assert!(plan.tun_name.len() < libc::IFNAMSIZ);
        assert!(plan.tun_name.starts_with("ts"));
        assert!(plan.nft_table.starts_with("taomni_sc_g"));
        assert!(plan.capture_cgroup_path().starts_with(CGROUP_ROOT));
        assert_eq!(plan.device_setup_commands()[0].program, LinuxProgram::Ip);
        assert_eq!(plan.device_setup_commands()[0].args[0], "tuntap");
        assert!(plan.device_setup_commands().iter().all(|command| {
            !command
                .args
                .iter()
                .any(|argument| argument == "sh" || argument == "-c")
        }));
    }

    #[test]
    fn selected_mode_marks_only_the_capture_cgroup() {
        let mut install = spec(CaptureMode::ApplicationGroup);
        install.selectors.push(CaptureSelector {
            profile_id: "browser".into(),
            kind: AppSelectorKind::ExecutablePath,
            value: "/usr/bin/firefox".into(),
            pid: None,
            process_start_time: None,
            include_children: true,
        });
        let plan = LinuxCapturePlan::from_spec(&install, 1000).unwrap();
        let batch = plan.nft_batch();
        assert!(batch.contains(&format!(
            "\"{}\" meta mark set",
            plan.capture_cgroup_relative
        )));
        assert!(!batch.contains(&format!("\"{}\" return", plan.bypass_cgroup_relative)));
        assert_eq!(batch.matches("meta mark set").count(), 1);
    }

    #[test]
    fn global_mode_bypasses_loopback_upstreams_and_helper_group_before_marking() {
        let plan = LinuxCapturePlan::from_spec(&spec(CaptureMode::Global), 1000).unwrap();
        let batch = plan.nft_batch();
        let loopback = batch.find("127.0.0.0/8 return").unwrap();
        let upstream = batch.find("203.0.113.9 return").unwrap();
        let helper = batch
            .find(&format!("\"{}\" return", plan.bypass_cgroup_relative))
            .unwrap();
        let catch_all = batch.rfind("meta mark set").unwrap();
        assert!(loopback < catch_all && upstream < catch_all && helper < catch_all);
        assert!(batch.contains("ip6 daddr 2001:db8::9 return"));
    }

    #[test]
    fn artifact_round_trip_rejects_foreign_or_modified_identifiers() {
        let plan = LinuxCapturePlan::from_spec(&spec(CaptureMode::Global), 1000).unwrap();
        let artifact = plan.artifact(vec![CaptureProcessRestore {
            pid: 42,
            process_start_time: 11,
            original_group: "/user.slice/example.scope".into(),
        }]);
        let recovered = LinuxCapturePlan::from_artifact(&artifact).unwrap();
        assert_eq!(recovered.generation, plan.generation);

        let mut foreign = artifact.clone();
        foreign.interface_names[0] = "eth0".into();
        assert_eq!(
            LinuxCapturePlan::from_artifact(&foreign).unwrap_err().code,
            "LINUX_ARTIFACT_OWNERSHIP_INVALID"
        );
        let mut traversal = artifact;
        traversal.process_restores[0].original_group = "../../etc".into();
        assert_eq!(
            LinuxCapturePlan::from_artifact(&traversal)
                .unwrap_err()
                .code,
            "LINUX_CGROUP_PATH_INVALID"
        );
    }

    #[test]
    fn cleanup_always_covers_both_address_families_and_owned_table() {
        let mut install = spec(CaptureMode::Global);
        install.route_ipv6 = false;
        let plan = LinuxCapturePlan::from_spec(&install, 1000).unwrap();
        let cleanup = plan.cleanup_commands();
        assert!(
            cleanup
                .iter()
                .any(|command| command.args.first().is_some_and(|v| v == "-6"))
        );
        assert!(cleanup.iter().any(|command| {
            command.program == LinuxProgram::Nft && command.args.last() == Some(&plan.nft_table)
        }));
    }

    #[test]
    fn parses_linux_privilege_status_without_mutating_the_host() {
        let status = "Name:\ttest\nUid:\t1000\t1001\t1001\t1001\nCapEff:\t0000000000001000\n";
        assert_eq!(parse_effective_uid(status), Some(1001));
        assert_eq!(parse_cap_eff(status), Some(1 << CAP_NET_ADMIN_BIT));
    }

    #[test]
    fn rejects_self_capture_and_non_linux_identity_kinds() {
        let mut install = spec(CaptureMode::RuntimeProcesses);
        install.selectors.push(CaptureSelector {
            profile_id: "bad".into(),
            kind: AppSelectorKind::ExecutablePath,
            value: "/proc/self/exe".into(),
            pid: Some(100),
            process_start_time: Some(12),
            include_children: false,
        });
        assert_eq!(
            LinuxCapturePlan::from_spec(&install, 1000)
                .unwrap_err()
                .code,
            "LINUX_SELF_CAPTURE_FORBIDDEN"
        );

        let mut install = spec(CaptureMode::ApplicationGroup);
        install.selectors.push(CaptureSelector {
            profile_id: "bad".into(),
            kind: AppSelectorKind::MacosSigningIdentity,
            value: "com.example.app".into(),
            pid: None,
            process_start_time: None,
            include_children: false,
        });
        assert_eq!(
            LinuxCapturePlan::from_spec(&install, 1000)
                .unwrap_err()
                .code,
            "LINUX_SELECTOR_UNSUPPORTED"
        );
    }
}
