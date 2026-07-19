//! Linux privileged capture transaction and process/cgroup ownership.

use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};

use super::linux::{
    CGROUP_PARENT, CGROUP_ROOT, LinuxCapturePlan, LinuxPrerequisites, validate_cgroup_relative,
};
use super::linux_system::{LinuxCommandRunner, cleanup_network, run_checked};
use super::{
    CaptureArtifactState, CaptureError, CaptureHandle, CaptureInstallSpec, CaptureMode,
    CaptureProcessRestore, CaptureSelector,
};
use crate::sockscap::types::AppSelectorKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxProcessIdentity {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub process_start_time: u64,
    pub owner_uid: u32,
    pub executable_path: Option<PathBuf>,
    pub cgroup_relative: String,
}

#[derive(Debug, Clone)]
pub struct LinuxPreparedCapture {
    pub spec: CaptureInstallSpec,
    pub plan: LinuxCapturePlan,
    pub artifact: CaptureArtifactState,
}

/// Create cgroups, move exact process incarnations, and create a persistent TUN
/// owned by the authorized desktop user. No nft/routing activation happens
/// until the unprivileged TUN runtime has opened the device.
pub async fn prepare_linux_capture(
    runner: &dyn LinuxCommandRunner,
    spec: &CaptureInstallSpec,
    owner_uid: u32,
) -> Result<LinuxPreparedCapture, CaptureError> {
    let prerequisites = LinuxPrerequisites::probe();
    if !prerequisites.ready_for_privileged_mutation() {
        return Err(CaptureError::invalid(
            "LINUX_CAPTURE_PRIVILEGES_UNAVAILABLE",
            format!(
                "Linux helper lacks a required capability (tun={}, cgroup_v2={}, ip={}, nft={}, euid={}, cap_net_admin={})",
                prerequisites.tun_present,
                prerequisites.cgroup_v2,
                prerequisites.ip_path.is_some(),
                prerequisites.nft_path.is_some(),
                prerequisites.effective_uid,
                prerequisites.cap_net_admin
            ),
        ));
    }
    let plan = LinuxCapturePlan::from_spec(spec, owner_uid)?;
    let mut artifact = plan.artifact(Vec::new());

    if let Err(error) = create_owned_cgroups(&plan) {
        return rollback_error(runner, &artifact, error).await;
    }
    let snapshot = snapshot_processes()?;
    let selected = processes_for_install(spec, &snapshot, owner_uid)?;
    match move_processes(&plan, spec.mode, selected, &mut artifact.process_restores) {
        Ok(()) => artifact.validate()?,
        Err(error) => return rollback_error(runner, &artifact, error).await,
    }

    for command in plan.device_setup_commands() {
        if let Err(error) = run_checked(runner, &command).await {
            return rollback_error(runner, &artifact, error).await;
        }
    }
    Ok(LinuxPreparedCapture {
        spec: spec.clone(),
        plan,
        artifact,
    })
}

/// Atomically validate/apply nftables, then add policy routing. A failed
/// activation always attempts the full reverse transaction before returning.
pub async fn activate_linux_capture(
    runner: &dyn LinuxCommandRunner,
    prepared: &LinuxPreparedCapture,
) -> Result<CaptureHandle, CaptureError> {
    if let Err(error) = run_checked(runner, &prepared.plan.nft_check_command()).await {
        return rollback_error(runner, &prepared.artifact, error).await;
    }
    for command in prepared.plan.activation_commands() {
        if let Err(error) = run_checked(runner, &command).await {
            return rollback_error(runner, &prepared.artifact, error).await;
        }
    }
    let helper_pid = prepared.spec.helper_pid.ok_or_else(|| {
        CaptureError::recovery_with_artifact(
            "LINUX_HELPER_PID_REQUIRED",
            "activated Linux capture lost its helper identity",
            prepared.artifact.clone(),
        )
    })?;
    Ok(CaptureHandle {
        generation: prepared.spec.generation,
        config_revision: prepared.spec.config_revision,
        helper_pid,
        artifact: prepared.artifact.clone(),
    })
}

/// Discover newly launched matching applications/children and attach them to
/// the existing capture cgroup. The returned artifact must replace the journal
/// copy before the helper acknowledges its next heartbeat.
pub fn refresh_linux_membership(
    prepared: &LinuxPreparedCapture,
) -> Result<CaptureArtifactState, CaptureError> {
    if prepared.spec.mode == CaptureMode::Global {
        return Ok(prepared.artifact.clone());
    }
    let snapshot = snapshot_processes()?;
    let selected = processes_for_install(&prepared.spec, &snapshot, prepared.plan.owner_uid)?;
    let known = prepared
        .artifact
        .process_restores
        .iter()
        .map(|restore| (restore.pid, restore.process_start_time))
        .collect::<HashSet<_>>();
    let selected = selected
        .into_iter()
        .filter(|process| !known.contains(&(process.pid, process.process_start_time)))
        .collect::<Vec<_>>();
    let mut artifact = prepared.artifact.clone();
    move_processes(
        &prepared.plan,
        prepared.spec.mode,
        selected,
        &mut artifact.process_restores,
    )?;
    artifact.validate()?;
    Ok(artifact)
}

pub async fn stop_linux_capture(
    runner: &dyn LinuxCommandRunner,
    artifact: &CaptureArtifactState,
) -> Result<(), CaptureError> {
    let plan = LinuxCapturePlan::from_artifact(artifact)?;
    // Remove marking/routes first so cleanup is fail-open even if restoring a
    // systemd cgroup later fails.
    let network_result = cleanup_network(runner, &plan, artifact).await;
    let process_result = restore_process_groups(&plan, artifact);
    let residue = cgroup_residue(&plan);
    if network_result.is_ok() && process_result.is_ok() && residue.is_empty() {
        return Ok(());
    }
    let mut reasons = Vec::new();
    if let Err(error) = network_result {
        reasons.push(error.message);
    }
    if let Err(error) = process_result {
        reasons.push(error.message);
    }
    if !residue.is_empty() {
        reasons.push(format!("remaining cgroups: {}", residue.join(", ")));
    }
    Err(CaptureError::recovery_with_artifact(
        "LINUX_CAPTURE_CLEANUP_INCOMPLETE",
        reasons.join("; "),
        artifact.clone(),
    ))
}

fn processes_for_install(
    spec: &CaptureInstallSpec,
    snapshot: &[LinuxProcessIdentity],
    owner_uid: u32,
) -> Result<Vec<LinuxProcessIdentity>, CaptureError> {
    let by_pid = snapshot
        .iter()
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();
    match spec.mode {
        CaptureMode::Global => {
            let helper_pid = spec.helper_pid.ok_or_else(|| {
                CaptureError::invalid("LINUX_HELPER_PID_REQUIRED", "helper PID is missing")
            })?;
            [spec.taomni_pid, helper_pid]
                .into_iter()
                .map(|pid| {
                    let process = by_pid.get(&pid).cloned().cloned().ok_or_else(|| {
                        CaptureError::invalid(
                            "LINUX_BYPASS_PROCESS_MISSING",
                            format!("required bypass process {pid} no longer exists"),
                        )
                    })?;
                    if pid == spec.taomni_pid && process.owner_uid != owner_uid {
                        return Err(CaptureError::invalid(
                            "LINUX_PROCESS_OWNER_MISMATCH",
                            "Taomni process does not belong to the authorized desktop user",
                        ));
                    }
                    Ok(process)
                })
                .collect()
        }
        CaptureMode::RuntimeProcesses => {
            let mut seeds = Vec::new();
            for selector in &spec.selectors {
                let pid = selector.pid.ok_or_else(|| {
                    CaptureError::invalid(
                        "LINUX_RUNTIME_SELECTOR_INVALID",
                        "runtime selector has no PID",
                    )
                })?;
                let expected_start = selector.process_start_time.ok_or_else(|| {
                    CaptureError::invalid(
                        "LINUX_RUNTIME_SELECTOR_INVALID",
                        "runtime selector has no process start token",
                    )
                })?;
                let process = by_pid.get(&pid).ok_or_else(|| {
                    CaptureError::invalid(
                        "LINUX_RUNTIME_PROCESS_EXITED",
                        format!("selected process {pid} exited before capture activation"),
                    )
                })?;
                if process.process_start_time != expected_start {
                    return Err(CaptureError::invalid(
                        "LINUX_RUNTIME_PID_REUSED",
                        format!("selected PID {pid} no longer identifies the same process"),
                    ));
                }
                if process.owner_uid != owner_uid {
                    return Err(CaptureError::invalid(
                        "LINUX_PROCESS_OWNER_MISMATCH",
                        format!("selected PID {pid} belongs to another user"),
                    ));
                }
                seeds.push(((*process).clone(), selector.include_children));
            }
            Ok(expand_children(seeds, snapshot, owner_uid))
        }
        CaptureMode::ApplicationGroup => {
            let mut seeds = Vec::new();
            for selector in &spec.selectors {
                for process in snapshot
                    .iter()
                    .filter(|process| process.owner_uid == owner_uid)
                {
                    if application_selector_matches(selector, process)? {
                        seeds.push((process.clone(), selector.include_children));
                    }
                }
            }
            Ok(expand_children(seeds, snapshot, owner_uid))
        }
    }
}

fn application_selector_matches(
    selector: &CaptureSelector,
    process: &LinuxProcessIdentity,
) -> Result<bool, CaptureError> {
    match selector.kind {
        AppSelectorKind::ExecutablePath => {
            let expected = canonical_or_original(Path::new(&selector.value));
            Ok(process
                .executable_path
                .as_deref()
                .map(canonical_or_original)
                .is_some_and(|actual| actual == expected))
        }
        AppSelectorKind::LinuxCgroup => {
            validate_cgroup_relative(&selector.value)?;
            Ok(cgroup_is_same_or_child(
                &process.cgroup_relative,
                &selector.value,
            ))
        }
        AppSelectorKind::MacosSigningIdentity => Err(CaptureError::invalid(
            "LINUX_SELECTOR_UNSUPPORTED",
            "macOS signing identities cannot select Linux processes",
        )),
    }
}

fn expand_children(
    seeds: Vec<(LinuxProcessIdentity, bool)>,
    snapshot: &[LinuxProcessIdentity],
    owner_uid: u32,
) -> Vec<LinuxProcessIdentity> {
    let mut selected = HashMap::<u32, LinuxProcessIdentity>::new();
    let mut queue = VecDeque::new();
    for (process, include_children) in seeds {
        if include_children {
            queue.push_back(process.pid);
        }
        selected.insert(process.pid, process);
    }
    while let Some(parent) = queue.pop_front() {
        for process in snapshot
            .iter()
            .filter(|process| process.parent_pid == Some(parent) && process.owner_uid == owner_uid)
        {
            if selected.insert(process.pid, process.clone()).is_none() {
                queue.push_back(process.pid);
            }
        }
    }
    let mut selected = selected.into_values().collect::<Vec<_>>();
    selected.sort_by_key(|process| process.pid);
    selected
}

fn snapshot_processes() -> Result<Vec<LinuxProcessIdentity>, CaptureError> {
    let refresh = ProcessRefreshKind::nothing()
        .without_tasks()
        .with_exe(UpdateKind::Always);
    let system = System::new_with_specifics(RefreshKind::nothing().with_processes(refresh));
    let mut processes = Vec::new();
    for (pid, process) in system.processes() {
        let pid = pid.as_u32();
        if pid == 0 || process.start_time() == 0 {
            continue;
        }
        let Some(cgroup_relative) = read_process_cgroup(pid) else {
            continue;
        };
        processes.push(LinuxProcessIdentity {
            pid,
            parent_pid: process.parent().map(Pid::as_u32),
            process_start_time: process.start_time(),
            owner_uid: std::fs::metadata(format!("/proc/{pid}"))
                .map(|metadata| metadata.uid())
                .unwrap_or(u32::MAX),
            executable_path: process.exe().map(Path::to_path_buf),
            cgroup_relative,
        });
    }
    Ok(processes)
}

fn create_owned_cgroups(plan: &LinuxCapturePlan) -> Result<(), CaptureError> {
    let generation_root = plan
        .capture_cgroup_path()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            CaptureError::invalid(
                "LINUX_CGROUP_PATH_INVALID",
                "derived capture cgroup has no generation parent",
            )
        })?;
    if generation_root.exists() {
        return Err(CaptureError::recovery(
            "LINUX_CAPTURE_ARTIFACT_EXISTS",
            format!(
                "owned cgroup generation already exists: {}",
                generation_root.display()
            ),
        ));
    }
    std::fs::create_dir_all(plan.capture_cgroup_path()).map_err(|error| {
        CaptureError::recovery(
            "LINUX_CGROUP_CREATE_FAILED",
            format!("could not create capture cgroup: {error}"),
        )
    })?;
    std::fs::create_dir_all(plan.bypass_cgroup_path()).map_err(|error| {
        CaptureError::recovery(
            "LINUX_CGROUP_CREATE_FAILED",
            format!("could not create bypass cgroup: {error}"),
        )
    })
}

fn move_processes(
    plan: &LinuxCapturePlan,
    mode: CaptureMode,
    processes: Vec<LinuxProcessIdentity>,
    restores: &mut Vec<CaptureProcessRestore>,
) -> Result<(), CaptureError> {
    let target = if mode == CaptureMode::Global {
        plan.bypass_cgroup_path()
    } else {
        plan.capture_cgroup_path()
    };
    for process in processes {
        if process.pid <= 1 {
            return Err(CaptureError::invalid(
                "LINUX_CAPTURE_PID_INVALID",
                "PID 0/1 cannot be moved into a Sockscap cgroup",
            ));
        }
        validate_cgroup_relative(&process.cgroup_relative)?;
        let current = current_process_identity(process.pid)?;
        if current.process_start_time != process.process_start_time {
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_PID_REUSED",
                format!("PID {} changed while capture was preparing", process.pid),
            ));
        }
        if current.owner_uid != process.owner_uid {
            return Err(CaptureError::recovery(
                "LINUX_CAPTURE_PROCESS_OWNER_CHANGED",
                format!(
                    "PID {} owner changed while capture was preparing",
                    process.pid
                ),
            ));
        }
        std::fs::write(target.join("cgroup.procs"), process.pid.to_string()).map_err(|error| {
            CaptureError::recovery(
                "LINUX_CGROUP_MOVE_FAILED",
                format!(
                    "could not attach PID {} to capture cgroup: {error}",
                    process.pid
                ),
            )
        })?;
        // The root helper is moved into the bypass cgroup for global mode but
        // is lifetime-bound to this transaction. Cleanup drains it to cgroup
        // root; only authorized desktop-user processes need exact restoration.
        if process.owner_uid == plan.owner_uid {
            restores.push(CaptureProcessRestore {
                pid: process.pid,
                process_start_time: process.process_start_time,
                owner_uid: process.owner_uid,
                original_group: process.cgroup_relative,
            });
        }
    }
    Ok(())
}

fn current_process_identity(pid: u32) -> Result<LinuxProcessIdentity, CaptureError> {
    let pid_key = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid_key]),
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_exe(UpdateKind::Always),
    );
    let process = system.process(pid_key).ok_or_else(|| {
        CaptureError::recovery(
            "LINUX_CAPTURE_PROCESS_EXITED",
            format!("process {pid} exited during capture transaction"),
        )
    })?;
    let cgroup_relative = read_process_cgroup(pid).ok_or_else(|| {
        CaptureError::recovery(
            "LINUX_CAPTURE_PROCESS_IDENTITY_UNAVAILABLE",
            format!("process {pid} has no readable unified cgroup identity"),
        )
    })?;
    Ok(LinuxProcessIdentity {
        pid,
        parent_pid: process.parent().map(|parent| parent.as_u32()),
        process_start_time: process.start_time(),
        owner_uid: std::fs::metadata(format!("/proc/{pid}"))
            .map(|metadata| metadata.uid())
            .unwrap_or(u32::MAX),
        executable_path: process.exe().map(Path::to_path_buf),
        cgroup_relative,
    })
}

fn restore_process_groups(
    plan: &LinuxCapturePlan,
    artifact: &CaptureArtifactState,
) -> Result<(), CaptureError> {
    let current = snapshot_processes()?
        .into_iter()
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();
    let mut failures = Vec::new();
    for restore in artifact.process_restores.iter().rev() {
        let Some(process) = current.get(&restore.pid) else {
            continue;
        };
        if process.process_start_time != restore.process_start_time {
            continue;
        }
        if restore.owner_uid != plan.owner_uid || process.owner_uid != restore.owner_uid {
            failures.push(format!(
                "refused to restore PID {} owned by a different user",
                restore.pid
            ));
            continue;
        }
        if let Err(error) = validate_cgroup_relative(&restore.original_group) {
            failures.push(error.message);
            continue;
        }
        let relative = restore
            .original_group
            .strip_prefix('/')
            .unwrap_or(&restore.original_group);
        let target = Path::new(CGROUP_ROOT).join(relative).join("cgroup.procs");
        let target = if target.is_file() {
            target
        } else {
            Path::new(CGROUP_ROOT).join("cgroup.procs")
        };
        if let Err(error) = std::fs::write(&target, restore.pid.to_string()) {
            failures.push(format!(
                "could not restore PID {} to {}: {error}",
                restore.pid,
                target.display()
            ));
        }
    }

    // Any process added after the last persisted heartbeat is still moved out
    // fail-open. Exact original placement is unavailable, so use cgroup root.
    let root_procs = Path::new(CGROUP_ROOT).join("cgroup.procs");
    for group in plan.cgroup_paths() {
        for pid in read_cgroup_procs(&group) {
            if let Err(error) = std::fs::write(&root_procs, pid.to_string()) {
                failures.push(format!(
                    "could not release PID {pid} from capture cgroup: {error}"
                ));
            }
        }
    }
    remove_owned_cgroups(plan, &mut failures);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(CaptureError::recovery(
            "LINUX_CGROUP_RESTORE_FAILED",
            failures.join("; "),
        ))
    }
}

fn remove_owned_cgroups(plan: &LinuxCapturePlan, failures: &mut Vec<String>) {
    for path in plan.cgroup_paths() {
        if let Err(error) = std::fs::remove_dir(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!("could not remove {}: {error}", path.display()));
            }
        }
    }
    if let Some(generation) = plan.capture_cgroup_path().parent() {
        if let Err(error) = std::fs::remove_dir(generation) {
            if error.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "could not remove {}: {error}",
                    generation.display()
                ));
            }
        }
    }
    let parent = Path::new(CGROUP_ROOT).join(CGROUP_PARENT);
    if let Err(error) = std::fs::remove_dir(&parent) {
        if error.kind() != std::io::ErrorKind::NotFound
            && error.kind() != std::io::ErrorKind::DirectoryNotEmpty
        {
            failures.push(format!("could not remove {}: {error}", parent.display()));
        }
    }
}

async fn rollback_error<T>(
    runner: &dyn LinuxCommandRunner,
    artifact: &CaptureArtifactState,
    original: CaptureError,
) -> Result<T, CaptureError> {
    match stop_linux_capture(runner, artifact).await {
        Ok(()) => Err(CaptureError::invalid(original.code, original.message)),
        Err(cleanup) => Err(CaptureError::recovery_with_artifact(
            original.code,
            format!("{}; rollback failed: {}", original.message, cleanup.message),
            artifact.clone(),
        )),
    }
}

fn read_process_cgroup(pid: u32) -> Option<String> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    text.lines().find_map(|line| {
        let mut fields = line.splitn(3, ':');
        let hierarchy = fields.next()?;
        let controllers = fields.next()?;
        let path = fields.next()?;
        (hierarchy == "0" && controllers.is_empty()).then(|| path.to_string())
    })
}

fn read_cgroup_procs(path: &Path) -> Vec<u32> {
    std::fs::read_to_string(path.join("cgroup.procs"))
        .map(|text| {
            text.lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .filter(|pid| *pid > 1)
                .collect()
        })
        .unwrap_or_default()
}

fn cgroup_residue(plan: &LinuxCapturePlan) -> Vec<String> {
    plan.cgroup_paths()
        .into_iter()
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn cgroup_is_same_or_child(current: &str, expected: &str) -> bool {
    let current = current.trim_matches('/');
    let expected = expected.trim_matches('/');
    current == expected
        || current
            .strip_prefix(expected)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::CapturePlatform;

    fn process(
        pid: u32,
        parent_pid: Option<u32>,
        start: u64,
        executable: &str,
        cgroup: &str,
    ) -> LinuxProcessIdentity {
        LinuxProcessIdentity {
            pid,
            parent_pid,
            process_start_time: start,
            owner_uid: 1000,
            executable_path: Some(executable.into()),
            cgroup_relative: cgroup.into(),
        }
    }

    fn spec(mode: CaptureMode, selectors: Vec<CaptureSelector>) -> CaptureInstallSpec {
        CaptureInstallSpec {
            generation: 1,
            config_revision: 1,
            platform: CapturePlatform::Linux,
            mode,
            gateway: "127.0.0.1:1080".parse().unwrap(),
            route_ipv6: false,
            selectors,
            bypass_ips: Vec::new(),
            taomni_pid: 100,
            helper_pid: Some(101),
        }
    }

    #[test]
    fn runtime_selection_rejects_pid_reuse_and_expands_children() {
        let selector = CaptureSelector {
            profile_id: "p1".into(),
            kind: AppSelectorKind::ExecutablePath,
            value: "/usr/bin/app".into(),
            pid: Some(20),
            process_start_time: Some(50),
            include_children: true,
        };
        let snapshot = vec![
            process(20, Some(1), 50, "/usr/bin/app", "/user.slice/app.scope"),
            process(21, Some(20), 51, "/usr/bin/child", "/user.slice/app.scope"),
        ];
        let selected = processes_for_install(
            &spec(CaptureMode::RuntimeProcesses, vec![selector.clone()]),
            &snapshot,
            1000,
        )
        .unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|process| process.pid)
                .collect::<Vec<_>>(),
            vec![20, 21]
        );

        let mut reused = selector;
        reused.process_start_time = Some(49);
        assert_eq!(
            processes_for_install(
                &spec(CaptureMode::RuntimeProcesses, vec![reused]),
                &snapshot,
                1000,
            )
            .unwrap_err()
            .code,
            "LINUX_RUNTIME_PID_REUSED"
        );
    }

    #[test]
    fn runtime_selection_rejects_other_users_and_does_not_follow_their_children() {
        let selector = CaptureSelector {
            profile_id: "p1".into(),
            kind: AppSelectorKind::ExecutablePath,
            value: "/usr/bin/app".into(),
            pid: Some(20),
            process_start_time: Some(50),
            include_children: true,
        };
        let mut foreign_seed = process(20, Some(1), 50, "/usr/bin/app", "/user.slice/app.scope");
        foreign_seed.owner_uid = 2000;
        assert_eq!(
            processes_for_install(
                &spec(CaptureMode::RuntimeProcesses, vec![selector.clone()]),
                &[foreign_seed],
                1000,
            )
            .unwrap_err()
            .code,
            "LINUX_PROCESS_OWNER_MISMATCH"
        );

        let seed = process(20, Some(1), 50, "/usr/bin/app", "/user.slice/app.scope");
        let mut foreign_child =
            process(21, Some(20), 51, "/usr/bin/child", "/user.slice/app.scope");
        foreign_child.owner_uid = 2000;
        let selected = processes_for_install(
            &spec(CaptureMode::RuntimeProcesses, vec![selector]),
            &[seed, foreign_child],
            1000,
        )
        .unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|process| process.pid)
                .collect::<Vec<_>>(),
            vec![20]
        );
    }

    #[test]
    fn executable_and_cgroup_application_selectors_are_front_filters() {
        let snapshot = vec![
            process(
                20,
                Some(1),
                50,
                "/usr/bin/browser",
                "/user.slice/browser.scope",
            ),
            process(21, Some(1), 51, "/usr/bin/other", "/user.slice/other.scope"),
        ];
        let selectors = vec![
            CaptureSelector {
                profile_id: "p1".into(),
                kind: AppSelectorKind::ExecutablePath,
                value: "/usr/bin/browser".into(),
                pid: None,
                process_start_time: None,
                include_children: false,
            },
            CaptureSelector {
                profile_id: "p1".into(),
                kind: AppSelectorKind::LinuxCgroup,
                value: "/user.slice/other.scope".into(),
                pid: None,
                process_start_time: None,
                include_children: false,
            },
        ];
        let selected = processes_for_install(
            &spec(CaptureMode::ApplicationGroup, selectors),
            &snapshot,
            1000,
        )
        .unwrap();
        assert_eq!(selected.len(), 2);
    }

    #[test]
    fn global_mode_requires_both_bypass_processes() {
        let snapshot = vec![process(
            100,
            Some(1),
            1,
            "/opt/taomni",
            "/user.slice/app.scope",
        )];
        assert_eq!(
            processes_for_install(&spec(CaptureMode::Global, Vec::new()), &snapshot, 1000)
                .unwrap_err()
                .code,
            "LINUX_BYPASS_PROCESS_MISSING"
        );
    }

    #[test]
    fn cgroup_descendant_match_is_component_bounded() {
        assert!(cgroup_is_same_or_child(
            "/user.slice/browser.scope/child",
            "/user.slice/browser.scope"
        ));
        assert!(!cgroup_is_same_or_child(
            "/user.slice/browser.scope-evil",
            "/user.slice/browser.scope"
        ));
    }
}
