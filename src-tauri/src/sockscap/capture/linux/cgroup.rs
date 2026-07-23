//! cgroup v2 ownership for the Linux transparent-capture rules.
//!
//! nftables can match a cgroup id, which gives us a stable process filter without
//! relying on a race-prone `/proc` lookup for every packet. The session records
//! every move so teardown can put processes back where they started.

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use crate::sockscap::config::ScopeMode;

const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const SESSION_PREFIX: &str = "taomni-sockscap-";

#[derive(Debug)]
struct CgroupMove {
    original_dir: PathBuf,
    managed_dir: PathBuf,
}

/// The cgroups created for one running SocksCap session.
///
/// In global mode, Taomni itself is moved to a bypass cgroup while all other
/// local TCP traffic is redirected. In app mode, only selected target PIDs are
/// moved into capture cgroups; children inherit their parent's cgroup. The
/// relay stays in the caller's cgroup and is therefore naturally excluded.
#[derive(Debug)]
pub struct CgroupSession {
    root: PathBuf,
    moves: Vec<CgroupMove>,
    bypass_id: Option<u64>,
    capture_ids: Vec<u64>,
}

impl CgroupSession {
    pub fn preflight() -> Result<(), String> {
        let root = Path::new(CGROUP_ROOT);
        if !root.join("cgroup.controllers").is_file() {
            return Err(
                "Linux SocksCap requires a mounted cgroup v2 hierarchy at /sys/fs/cgroup".into(),
            );
        }
        Ok(())
    }

    pub fn prepare(
        mode: ScopeMode,
        target_pids: &BTreeSet<u32>,
        self_pid: u32,
    ) -> Result<Self, String> {
        Self::preflight()?;

        let root = Path::new(CGROUP_ROOT).join(format!("{SESSION_PREFIX}{self_pid}"));
        if root.exists() {
            return Err(format!(
                "an existing Linux SocksCap cgroup exists at {}; run Recover before starting again",
                root.display()
            ));
        }
        fs::create_dir(&root).map_err(|e| {
            format!(
                "create {}: {e}. Linux capture must run with permission to manage cgroup v2",
                root.display()
            )
        })?;

        let mut session = Self {
            root,
            moves: Vec::new(),
            bypass_id: None,
            capture_ids: Vec::new(),
        };

        let setup = match mode {
            ScopeMode::Global => session
                .move_pid(self_pid, "bypass")
                .map(|id| session.bypass_id = Some(id)),
            ScopeMode::Apps => {
                if target_pids.is_empty() {
                    Err("App mode needs at least one running selected process".into())
                } else if target_pids.contains(&self_pid) {
                    Err(
                        "Taomni itself cannot be selected for Linux app capture; it must remain outside the redirect cgroup"
                            .into(),
                    )
                } else {
                    for pid in target_pids {
                        let id = session.move_pid(*pid, &format!("capture-{pid}"))?;
                        session.capture_ids.push(id);
                    }
                    Ok(())
                }
            }
        };

        if let Err(error) = setup {
            let cleanup_error = session.cleanup().err();
            return Err(match cleanup_error {
                Some(cleanup_error) => format!("{error}; cleanup also failed: {cleanup_error}"),
                None => error,
            });
        }

        Ok(session)
    }

    pub fn bypass_id(&self) -> Option<u64> {
        self.bypass_id
    }

    pub fn capture_ids(&self) -> &[u64] {
        &self.capture_ids
    }

    /// Restore moved processes and remove the session's empty cgroup tree.
    pub fn cleanup(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();

        for moved in self.moves.iter().rev() {
            if let Err(error) = restore_managed_processes(moved) {
                errors.push(error);
            }
        }

        for moved in self.moves.iter().rev() {
            if let Err(error) = fs::remove_dir(&moved.managed_dir) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    errors.push(format!("remove {}: {error}", moved.managed_dir.display()));
                }
            }
        }
        if let Err(error) = fs::remove_dir(&self.root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                errors.push(format!("remove {}: {error}", self.root.display()));
            }
        }

        self.moves.clear();
        self.capture_ids.clear();
        self.bypass_id = None;

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn move_pid(&mut self, pid: u32, name: &str) -> Result<u64, String> {
        let original_dir = cgroup_dir_for_pid(pid)?;
        let managed_dir = self.root.join(name);
        fs::create_dir(&managed_dir)
            .map_err(|e| format!("create {}: {e}", managed_dir.display()))?;
        // Read the inode before moving the process. If that read fails, the
        // new cgroup is still empty and the session-level rollback can remove
        // it without leaving a PID stranded in an untracked cgroup.
        let id = match cgroup_id(&managed_dir) {
            Ok(id) => id,
            Err(error) => {
                let cleanup_error = fs::remove_dir(&managed_dir).err();
                return Err(match cleanup_error {
                    Some(cleanup_error) => {
                        format!("{error}; remove {}: {cleanup_error}", managed_dir.display())
                    }
                    None => error,
                });
            }
        };
        let cgroup_procs = managed_dir.join("cgroup.procs");
        let managed_display = managed_dir.display().to_string();
        self.moves.push(CgroupMove {
            original_dir,
            managed_dir,
        });
        fs::write(cgroup_procs, pid.to_string()).map_err(|e| {
            format!(
                "move PID {pid} into {}: {e}. Linux capture needs root or delegated cgroup permissions",
                managed_display
            )
        })?;
        Ok(id)
    }
}

/// Return all direct process IDs currently assigned to a cgroup.
///
/// A selected process can fork while capture is active. Its children inherit
/// the managed cgroup, so cleanup must restore the whole direct membership,
/// not merely the PID selected when capture started.
fn cgroup_processes(path: &Path) -> Result<Vec<u32>, String> {
    let contents = match fs::read_to_string(path.join("cgroup.procs")) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read {}/cgroup.procs: {error}", path.display())),
    };
    parse_cgroup_processes(&contents, path)
}

fn parse_cgroup_processes(contents: &str, path: &Path) -> Result<Vec<u32>, String> {
    contents
        .lines()
        .map(|line| {
            line.parse::<u32>()
                .map_err(|error| format!("parse PID {line:?} in {}: {error}", path.display()))
        })
        .collect()
}

fn restore_managed_processes(moved: &CgroupMove) -> Result<(), String> {
    for pid in cgroup_processes(&moved.managed_dir)? {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            continue;
        }
        fs::write(moved.original_dir.join("cgroup.procs"), pid.to_string()).map_err(|error| {
            format!(
                "restore PID {pid} from {} to {}: {error}",
                moved.managed_dir.display(),
                moved.original_dir.display()
            )
        })?;
    }
    Ok(())
}

/// Best-effort cleanup used by Recover / boot repair. It intentionally removes
/// only empty cgroups with the generated prefix; it never moves live processes.
pub fn cleanup_empty_sessions() -> Result<(), String> {
    let root = Path::new(CGROUP_ROOT);
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read {}: {error}", root.display())),
    };

    let mut errors = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(SESSION_PREFIX) {
            continue;
        }
        let path = entry.path();
        if let Err(error) = remove_empty_tree(&path) {
            errors.push(format!("{}: {error}", path.display()));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn remove_empty_tree(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
        let child = entry.path();
        if child.is_dir() {
            remove_empty_tree(&child)?;
        }
    }
    fs::remove_dir(path).map_err(|e| e.to_string())
}

fn cgroup_dir_for_pid(pid: u32) -> Result<PathBuf, String> {
    let contents = fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .map_err(|e| format!("read /proc/{pid}/cgroup: {e}"))?;
    let relative = parse_cgroup_v2_path(&contents)
        .ok_or_else(|| format!("PID {pid} is not in a cgroup v2 hierarchy"))?;
    cgroup_dir_from_relative(relative)
}

fn cgroup_id(path: &Path) -> Result<u64, String> {
    path.metadata()
        .map(|metadata| metadata.ino())
        .map_err(|e| format!("stat {}: {e}", path.display()))
}

pub(crate) fn parse_cgroup_v2_path(contents: &str) -> Option<&str> {
    contents.lines().find_map(|line| line.strip_prefix("0::"))
}

pub(crate) fn cgroup_dir_from_relative(relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative.trim_start_matches('/'));
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("invalid cgroup v2 path".into());
    }
    Ok(Path::new(CGROUP_ROOT).join(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unified_cgroup_path() {
        assert_eq!(
            parse_cgroup_v2_path("0::/user.slice/user-1000.slice/session-2.scope\n"),
            Some("/user.slice/user-1000.slice/session-2.scope")
        );
    }

    #[test]
    fn rejects_parent_components() {
        assert!(cgroup_dir_from_relative("/../outside").is_err());
    }

    #[test]
    fn parses_direct_cgroup_members() {
        let members = parse_cgroup_processes("42\n1001\n", Path::new("/test")).unwrap();
        assert_eq!(members, vec![42, 1001]);
    }
}
