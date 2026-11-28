#[cfg(target_os = "linux")]
use std::fs;
use std::path::{Path, PathBuf};
pub(super) struct Locations {
    blocked: Vec<PathBuf>,
    #[cfg(windows)]
    drives: u32,
}

impl Locations {
    pub fn new() -> Self {
        #[cfg(target_os = "linux")]
        let blocked = fs::read_to_string("/proc/self/mountinfo")
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                let (left, right) = line.split_once(" - ")?;
                let kind = right.split_whitespace().next()?;
                if !matches!(
                    kind,
                    "nfs"
                        | "nfs4"
                        | "cifs"
                        | "smb3"
                        | "9p"
                        | "autofs"
                        | "afs"
                        | "ceph"
                        | "proc"
                        | "sysfs"
                        | "devtmpfs"
                        | "devpts"
                        | "fuse.portal"
                        | "fuse.gvfsd-fuse"
                ) && !kind.starts_with("fuse.sshfs")
                    && !kind.starts_with("fuse.rclone")
                {
                    return None;
                }
                let raw = left.split_whitespace().nth(4)?;
                Some(PathBuf::from(
                    raw.replace("\\040", " ")
                        .replace("\\011", "\t")
                        .replace("\\012", "\n")
                        .replace("\\134", "\\"),
                ))
            })
            .collect();
        #[cfg(target_os = "macos")]
        let blocked = remote_mounts();
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let blocked = Vec::new();
        Self {
            blocked,
            #[cfg(windows)]
            drives: crate::windows_index::fixed_drive_mask(),
        }
    }

    pub fn allows(&self, path: &Path) -> bool {
        if !path.is_absolute() || self.blocked.iter().any(|prefix| path.starts_with(prefix)) {
            return false;
        }
        #[cfg(windows)]
        {
            use std::path::{Component, Prefix};
            // Windows Search may index network shares or non-file namespaces.
            // Check mapped drives as well as UNC paths before filesystem I/O.
            let Some(Component::Prefix(prefix)) = path.components().next() else {
                return false;
            };
            let (Prefix::Disk(drive) | Prefix::VerbatimDisk(drive)) = prefix.kind() else {
                return false;
            };
            return drive.is_ascii_alphabetic()
                && self.drives & (1 << (drive.to_ascii_uppercase() - b'A')) != 0;
        }
        #[cfg(not(windows))]
        true
    }
}

#[cfg(target_os = "macos")]
fn remote_mounts() -> Vec<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::mem::MaybeUninit;
    use std::os::unix::ffi::OsStrExt;
    // MNT_NOWAIT reads the kernel mount table without contacting mounted servers.
    // getfsstat writes into a private buffer rather than getmntinfo's global state.
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count <= 0 {
        return vec!["/Network".into(), "/Volumes".into()];
    }
    let mut mounts = vec![MaybeUninit::<libc::statfs>::uninit(); (count as usize + 8).min(1024)];
    let byte_count = (mounts.len() * size_of::<libc::statfs>()) as i32;
    let written =
        unsafe { libc::getfsstat(mounts.as_mut_ptr().cast(), byte_count, libc::MNT_NOWAIT) };
    if written < 0 {
        return vec!["/Network".into(), "/Volumes".into()];
    }
    mounts
        .iter()
        .take(written as usize)
        .filter_map(|entry| {
            // The OS initialized each returned record, including its C mount path.
            let mount = unsafe { entry.assume_init_ref() };
            if mount.f_flags & libc::MNT_LOCAL as u32 != 0 {
                return None;
            }
            let path = unsafe { CStr::from_ptr(mount.f_mntonname.as_ptr()) };
            Some(PathBuf::from(OsStr::from_bytes(path.to_bytes())))
        })
        .collect()
}
