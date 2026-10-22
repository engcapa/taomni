use super::local_start::terminal_task_environment;

use std::path::{Path, PathBuf};

#[test]
fn exposes_sdk_values_with_sdk_bins_preceding_the_inherited_path() {
    let mut sdk_environment =
        crate::sdk::WorkspaceSdkEnvironment::passthrough(Path::new("/repo"), Path::new("/repo"));
    sdk_environment
        .environment
        .insert("JAVA_HOME".to_string(), "/sdk/jdk-21".to_string());
    sdk_environment.path_entries = vec!["/sdk/jdk-21/bin".to_string()];

    let inherited_entry = PathBuf::from("/inherited/bin");
    let inherited_path =
        std::env::join_paths([inherited_entry.as_path()]).expect("join inherited task PATH");
    let environment =
        terminal_task_environment(Some(&sdk_environment), Some(inherited_path.as_os_str()));

    assert_eq!(
        environment.get("JAVA_HOME").map(String::as_str),
        Some("/sdk/jdk-21")
    );
    let path = environment.get("PATH").expect("task PATH");
    let entries = std::env::split_paths(std::ffi::OsStr::new(path)).collect::<Vec<_>>();
    assert_eq!(
        entries.first().and_then(|entry| entry.to_str()),
        Some("/sdk/jdk-21/bin")
    );
    assert!(entries.iter().any(|entry| entry == &inherited_entry));
}

#[test]
fn returns_no_task_overrides_without_a_workspace_sdk_environment() {
    assert!(terminal_task_environment(None, Some(std::ffi::OsStr::new("/usr/bin"))).is_empty());
}
