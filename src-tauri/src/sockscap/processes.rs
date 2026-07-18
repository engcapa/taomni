//! Privacy-bounded cross-platform process catalog for runtime selectors.
//!
//! PID alone is never a stable selector. Every selectable row includes the
//! process start time reported by the operating system so the capture adapter
//! can reject PID reuse. The catalog intentionally never requests or returns
//! command-line arguments, environment variables, working directories, user
//! identities, CPU usage, or memory usage.

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, RefreshKind, System, UpdateKind};

const MAX_PROCESS_ROWS: usize = 4096;
const MAX_PROCESS_NAME_CHARS: usize = 256;
const MAX_EXECUTABLE_PATH_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSummary {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub executable_path: Option<String>,
    /// Seconds since the Unix epoch as reported by the native process table.
    /// Combined with PID, this identifies one process incarnation.
    pub process_start_time: u64,
    pub selectable: bool,
    pub rememberable: bool,
    pub issue_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCatalog {
    pub processes: Vec<ProcessSummary>,
    pub truncated: bool,
    pub max_rows: usize,
}

/// Take one bounded process-table snapshot. `ProcessRefreshKind::nothing()`
/// still retrieves PID, parent PID, name, and start time; only executable path
/// is explicitly added. Tasks/threads are excluded from the application list.
pub fn list_processes() -> Result<ProcessCatalog, String> {
    if !sysinfo::IS_SUPPORTED_SYSTEM {
        return Err("PROCESS_CATALOG_UNSUPPORTED: this operating system is not supported".into());
    }
    let refresh = ProcessRefreshKind::nothing()
        .without_tasks()
        .with_exe(UpdateKind::OnlyIfNotSet);
    let system = System::new_with_specifics(RefreshKind::nothing().with_processes(refresh));
    let current_pid = std::process::id();
    let mut rows = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let pid = pid.as_u32();
            (pid != 0).then(|| {
                project_process(
                    pid,
                    process.parent().map(|parent| parent.as_u32()),
                    &process.name().to_string_lossy(),
                    process
                        .exe()
                        .filter(|path| !path.as_os_str().is_empty())
                        .map(|path| path.to_string_lossy().into_owned()),
                    process.start_time(),
                    current_pid,
                )
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.pid.cmp(&right.pid))
    });
    let truncated = rows.len() > MAX_PROCESS_ROWS;
    rows.truncate(MAX_PROCESS_ROWS);
    Ok(ProcessCatalog {
        processes: rows,
        truncated,
        max_rows: MAX_PROCESS_ROWS,
    })
}

fn project_process(
    pid: u32,
    parent_pid: Option<u32>,
    raw_name: &str,
    raw_executable_path: Option<String>,
    process_start_time: u64,
    current_pid: u32,
) -> ProcessSummary {
    let name = bounded_text(raw_name, MAX_PROCESS_NAME_CHARS).unwrap_or_else(|| "Process".into());
    let executable_path = raw_executable_path.and_then(|path| {
        if path.len() > MAX_EXECUTABLE_PATH_BYTES {
            None
        } else {
            bounded_text(&path, MAX_EXECUTABLE_PATH_BYTES)
        }
    });
    let (selectable, issue_code) = if pid == current_pid {
        (false, Some("PROCESS_IS_TAOMNI".to_string()))
    } else if process_start_time == 0 {
        (false, Some("PROCESS_START_TIME_UNAVAILABLE".to_string()))
    } else {
        (true, None)
    };
    ProcessSummary {
        pid,
        parent_pid: parent_pid.filter(|parent| *parent != 0),
        name,
        rememberable: selectable && executable_path.is_some(),
        executable_path,
        process_start_time,
        selectable,
        issue_code,
    }
}

fn bounded_text(value: &str, max_chars: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return None;
    }
    Some(value.chars().take(max_chars).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_contains_current_process_but_never_allows_selecting_it() {
        let catalog = list_processes().expect("list process catalog");
        let current = catalog
            .processes
            .iter()
            .find(|process| process.pid == std::process::id())
            .expect("current process must be visible");
        assert!(!current.selectable);
        assert_eq!(current.issue_code.as_deref(), Some("PROCESS_IS_TAOMNI"));
        assert!(current.process_start_time > 0);
    }

    #[test]
    fn projection_requires_start_time_and_path_before_persistence() {
        let row = project_process(44, Some(1), "Example", Some("/opt/example".into()), 0, 99);
        assert!(!row.selectable);
        assert!(!row.rememberable);
        assert_eq!(
            row.issue_code.as_deref(),
            Some("PROCESS_START_TIME_UNAVAILABLE")
        );

        let row = project_process(44, Some(1), "Example", Some("/opt/example".into()), 123, 99);
        assert!(row.selectable);
        assert!(row.rememberable);
    }

    #[test]
    fn catalog_shape_contains_no_command_line_or_environment_fields() {
        let row = project_process(44, None, "Example", Some("/opt/example".into()), 123, 99);
        let json = serde_json::to_value(row).expect("serialize process summary");
        let object = json.as_object().expect("summary must be an object");
        for forbidden in [
            "cmd",
            "commandLine",
            "environment",
            "cwd",
            "user",
            "memory",
            "cpuUsage",
        ] {
            assert!(!object.contains_key(forbidden));
        }
    }

    #[test]
    fn invalid_control_characters_are_not_projected() {
        let row = project_process(
            44,
            None,
            "bad\nname",
            Some("/tmp/bad\npath".into()),
            123,
            99,
        );
        assert_eq!(row.name, "Process");
        assert!(row.executable_path.is_none());
        assert!(!row.rememberable);
    }
}
