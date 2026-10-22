use super::limits::LAUNCHER_BYTES;
use super::limits::PREPARATION_WRAPPER;
use crate::sockscap::capture::linux::tracer::LaunchCommand;
use crate::sockscap::config::AppLaunchPreparation;
use std::ffi::OsString;
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

pub(super) fn resolve_executable(command: &str) -> Result<PathBuf, String> {
    if command.is_empty() {
        return Err("SocksCap launch command is empty".into());
    }
    let path = which::which(command).map_err(|error| {
        format!("resolve SocksCap launch command {command:?} through PATH: {error}")
    })?;
    validate_executable(&path)?;
    Ok(path)
}

pub(super) fn prepare_launch(
    command: &str,
    args: &[String],
    preparation: &AppLaunchPreparation,
) -> Result<LaunchCommand, String> {
    if command.is_empty() {
        return Err("SocksCap launch command is empty".into());
    }
    if preparation.is_empty() {
        return Ok(LaunchCommand {
            executable: resolve_executable(command)?,
            args: args.to_vec(),
            working_directory: None,
            environment: Vec::new(),
        });
    }

    let working_directory = if preparation.working_directory.is_empty() {
        None
    } else {
        let path = PathBuf::from(&preparation.working_directory);
        let metadata = fs::metadata(&path).map_err(|error| {
            format!(
                "inspect SocksCap launch working directory {}: {error}",
                path.display()
            )
        })?;
        if !metadata.is_dir() {
            return Err(format!(
                "SocksCap launch working directory is not a directory: {}",
                path.display()
            ));
        }
        Some(path)
    };

    let shell = resolve_executable(preparation.shell.command_name())?;
    let mut shell_args = Vec::with_capacity(args.len() + 5);
    shell_args.push("-c".into());
    shell_args.push(PREPARATION_WRAPPER.into());
    shell_args.push("taomni-sockscap-preparation".into());
    shell_args.push(preparation.pre_command.clone());
    shell_args.push(command.to_string());
    shell_args.extend(args.iter().cloned());
    let environment = preparation
        .environment
        .iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect();
    Ok(LaunchCommand {
        executable: shell,
        args: shell_args,
        working_directory,
        environment,
    })
}

pub(super) fn validate_executable(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("inspect launch path {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "SocksCap launch path is not a file: {}",
            path.display()
        ));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!(
            "SocksCap launch path is not executable: {}",
            path.display()
        ));
    }
    if metadata.permissions().mode() & 0o6000 != 0 {
        return Err(format!(
            "SocksCap cannot launch setuid/setgid executables in unprivileged capture mode: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(super) fn materialize_launcher(runtime_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(runtime_dir)
        .map_err(|error| format!("create SocksCap runtime directory: {error}"))?;
    fs::set_permissions(runtime_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("secure SocksCap runtime directory: {error}"))?;
    let path = runtime_dir.join("taomni-sockscap-trace-launcher");
    if fs::read(&path).ok().as_deref() == Some(LAUNCHER_BYTES) {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure SocksCap trace launcher: {error}"))?;
        return Ok(path);
    }
    let temporary = runtime_dir.join(format!(
        ".taomni-sockscap-trace-launcher-{}.tmp",
        std::process::id()
    ));
    let mut file = File::create(&temporary)
        .map_err(|error| format!("create SocksCap trace launcher: {error}"))?;
    file.write_all(LAUNCHER_BYTES)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("write SocksCap trace launcher: {error}"))?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("set SocksCap trace launcher permissions: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("install SocksCap trace launcher: {error}"))?;
    Ok(path)
}

/// Read-only capability probe used before rootless backend selection.
pub fn preflight() -> Result<(), String> {
    let directory = std::env::temp_dir().join(format!(
        "taomni-sockscap-preflight-{}-{}",
        unsafe { libc::geteuid() },
        uuid::Uuid::new_v4()
    ));
    let launcher = materialize_launcher(&directory)?;
    let result = super::super::tracer::preflight(&launcher);
    let _ = fs::remove_file(&launcher);
    let _ = fs::remove_dir(&directory);
    result
}
use std::os::unix::fs::PermissionsExt;
