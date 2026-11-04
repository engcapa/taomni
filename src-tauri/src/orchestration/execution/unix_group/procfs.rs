//! Linux-only positive zombie classification. Inaccessible/hidden/mismatched
//! procfs is not evidence of an empty group. macOS never depends on this module.
use std::{fs, io};

use super::state::{GroupState, Member};

const MAX_PROCESSES: usize = 65_536;

pub(super) fn observe(group_id: libc::pid_t) -> Result<GroupState, String> {
    let mounts = fs::read_to_string("/proc/mounts").map_err(|_| unavailable())?;
    check_visibility(&mounts)?;
    let own = fs::read_to_string("/proc/self/stat").map_err(|_| unavailable())?;
    parse_stat(&own, std::process::id())?;
    let entries = fs::read_dir("/proc").map_err(|_| unavailable())?;
    let mut zombies = Vec::new();
    let mut checked = 0;
    for entry in entries {
        let entry = entry.map_err(|_| unavailable())?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        checked += 1;
        if checked > MAX_PROCESSES {
            return Err(unavailable());
        }
        let text = match fs::read_to_string(entry.path().join("stat")) {
            Ok(text) => text,
            // The process exited during this scan. No cached membership is used.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(unavailable()),
        };
        let stat = parse_stat(&text, pid)?;
        if stat.group_id != group_id as u32 {
            continue;
        }
        if !matches!(stat.state, b'Z' | b'X' | b'x') {
            return Ok(GroupState::Live);
        }
        zombies.push(Member {
            pid,
            start_ticks: stat.start_ticks,
        });
    }
    zombies.sort_unstable();
    // If kill(0) saw a group but this non-atomic scan saw no member, membership
    // raced or visibility differs. Require another observation, never assume gone.
    if zombies.is_empty() {
        Ok(GroupState::Live)
    } else {
        Ok(GroupState::Zombies(zombies))
    }
}

fn check_visibility(mounts: &str) -> Result<(), String> {
    let visible = mounts.lines().any(|line| {
        let fields: Vec<_> = line.split_ascii_whitespace().collect();
        fields.len() >= 4
            && fields[1] == "/proc"
            && fields[2] == "proc"
            && fields[3].split(',').all(|option| {
                !option.starts_with("hidepid=") || matches!(option, "hidepid=0" | "hidepid=off")
            })
    });
    if visible { Ok(()) } else { Err(unavailable()) }
}

struct Stat {
    group_id: u32,
    state: u8,
    start_ticks: u64,
}

fn parse_stat(text: &str, pid: u32) -> Result<Stat, String> {
    // comm can contain spaces, parentheses and newlines; only the last ") "
    // separates it from fields 3 onward. Never split the whole record on spaces.
    let (identity, _) = text.split_once(" (").ok_or_else(unavailable)?;
    if identity.parse::<u32>().ok() != Some(pid) {
        return Err(unavailable());
    }
    let (_, tail) = text.rsplit_once(") ").ok_or_else(unavailable)?;
    let fields: Vec<_> = tail.split_ascii_whitespace().collect();
    if fields.len() < 20 || fields[0].len() != 1 {
        return Err(unavailable());
    }
    Ok(Stat {
        group_id: fields[2].parse().map_err(|_| unavailable())?,
        state: fields[0].as_bytes()[0],
        start_ticks: fields[19].parse().map_err(|_| unavailable())?,
    })
}

fn unavailable() -> String {
    "WORKER_STOP_UNKNOWN: live worker group membership cannot be verified from procfs".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(pid: u32, name: &str, state: &str, group: u32, start: u64) -> String {
        let mut fields = vec!["0".to_owned(); 20];
        fields[0] = state.into();
        fields[2] = group.to_string();
        fields[19] = start.to_string();
        format!("{pid} ({name}) {}", fields.join(" "))
    }

    #[test]
    fn stat_parser_handles_parenthesized_multiline_comm_and_start_identity() {
        let text = stat(42, "worker ) (with\nspaces)", "Z", 17, 1234);
        let parsed = parse_stat(&text, 42).unwrap();
        assert_eq!(parsed.group_id, 17);
        assert_eq!(parsed.state, b'Z');
        assert_eq!(parsed.start_ticks, 1234);
        assert!(parse_stat(&text, 43).is_err());
    }

    #[test]
    fn malformed_or_missing_stat_fields_cannot_prove_a_dead_member() {
        for text in ["42 (worker) Z 1 2", "42 no comm", "42 (worker) ZZ 1 2"] {
            assert!(parse_stat(text, 42).is_err());
        }
    }

    #[test]
    fn hidden_or_foreign_proc_mounts_cannot_prove_group_absence() {
        assert!(check_visibility("proc /proc proc rw,nosuid,nodev,relatime 0 0\n").is_ok());
        assert!(check_visibility("proc /proc proc rw,hidepid=0 0 0\n").is_ok());
        assert!(check_visibility("proc /proc proc rw,hidepid=2 0 0\n").is_err());
        assert!(check_visibility("proc /other proc rw 0 0\n").is_err());
        assert!(check_visibility("").is_err());
    }
}
