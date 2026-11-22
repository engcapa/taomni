use std::path::{Path, PathBuf};

pub(super) struct Options {
    pub(super) provider_socket: PathBuf,
    pub(super) flow_socket: PathBuf,
    pub(super) redirector: PathBuf,
    pub(super) parent_pid: u32,
    module_host: Option<(u32, u64)>,
}

impl Options {
    pub(super) fn exited_owner(&self) -> Option<String> {
        if process_start_micros(self.parent_pid).is_none() {
            return Some(format!("Taomni parent pid {} exited", self.parent_pid));
        }
        if let Some((pid, birth)) = self.module_host
            && process_start_micros(pid) != Some(birth)
        {
            return Some(format!("SocksCap module host pid {pid} exited"));
        }
        None
    }
}

/// Darwin process start time distinguishes an exited host from a reused PID.
/// A zombie cannot own the bridge, even before its parent has reaped it.
pub fn process_start_micros(pid: u32) -> Option<u64> {
    let pid = libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 0)?;
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: libproc receives exactly the space for one proc_bsdinfo.
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if count != size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_status == libc::SZOMB {
        return None;
    }
    info.pbi_start_tvsec
        .checked_mul(1_000_000)?
        .checked_add(info.pbi_start_tvusec)
}

fn parse_pid(value: &str) -> Result<u32, String> {
    value
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0)
        .map(|pid| pid as u32)
        .ok_or_else(|| format!("invalid process id {value:?}"))
}

pub(super) fn parse_options(
    mut args: impl Iterator<Item = String>,
    require_module_host: bool,
) -> Result<Options, String> {
    let mut provider_socket = None;
    let mut flow_socket = None;
    let mut redirector = None;
    let mut parent_pid = None;
    let mut module_host = None;
    while let Some(arg) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {arg}"))?;
        match arg.as_str() {
            "--provider-socket" => provider_socket = Some(PathBuf::from(value)),
            "--flow-socket" => flow_socket = Some(PathBuf::from(value)),
            "--redirector" => redirector = Some(PathBuf::from(value)),
            "--parent-pid" => parent_pid = Some(parse_pid(&value)?),
            "--module-host" => {
                let (pid, birth) = value
                    .split_once(':')
                    .ok_or("invalid SocksCap host identity")?;
                let birth = birth
                    .parse::<u64>()
                    .ok()
                    .filter(|birth| *birth > 0)
                    .ok_or("invalid SocksCap host start time")?;
                module_host = Some((parse_pid(pid)?, birth));
            }
            _ => return Err(format!("unknown bridge option {arg:?}")),
        }
    }
    Ok(Options {
        provider_socket: provider_socket.ok_or("missing --provider-socket")?,
        flow_socket: flow_socket.ok_or("missing --flow-socket")?,
        redirector: redirector.ok_or("missing --redirector")?,
        parent_pid: parent_pid.ok_or("missing --parent-pid")?,
        module_host: if require_module_host {
            Some(module_host.ok_or("missing --module-host")?)
        } else {
            module_host
        },
    })
}

pub(super) fn validate_socket_path(path: &Path, label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} socket has no parent"))?;
    if !path.is_absolute() || parent != Path::new("/tmp") {
        return Err(format!(
            "{label} socket must be an absolute child of /tmp: {}",
            path.display()
        ));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if !name.starts_with("taomni-redirector-") || !name.ends_with(".sock") {
        return Err(format!("unsafe {label} socket name {name:?}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(owner: &[&str]) -> impl Iterator<Item = String> {
        [
            "--provider-socket",
            "/tmp/provider",
            "--flow-socket",
            "/tmp/flow",
            "--redirector",
            "/launcher",
            "--parent-pid",
            "42",
        ]
        .into_iter()
        .chain(owner.iter().copied())
        .map(str::to_owned)
    }

    #[test]
    fn packaged_entry_requires_a_distinct_host_identity_argument() {
        assert!(parse_options(args(&[]), true).is_err());
        let legacy = parse_options(args(&[]), false).unwrap();
        assert_eq!(legacy.parent_pid, 42);
        let signed = parse_options(args(&["--module-host", "78:12345"]), true).unwrap();
        assert_eq!(signed.parent_pid, 42);
        assert_eq!(signed.module_host, Some((78, 12345)));
    }

    #[test]
    fn malformed_or_process_group_ids_cannot_own_a_bridge() {
        for bad in ["0:1234", "-1:1234", "78:0", "78", "4294967295:88"] {
            assert!(parse_options(args(&["--module-host", bad]), true).is_err());
        }
    }

    #[test]
    fn stale_host_is_detected_even_when_its_pid_is_live() {
        let pid = std::process::id();
        let birth = process_start_micros(pid).unwrap();
        let mut options = parse_options(args(&[]), false).unwrap();
        options.parent_pid = pid;
        options.module_host = Some((pid, birth));
        assert!(options.exited_owner().is_none());
        options.module_host = Some((pid, birth + 1));
        assert!(options.exited_owner().unwrap().contains("module host"));
    }
}
