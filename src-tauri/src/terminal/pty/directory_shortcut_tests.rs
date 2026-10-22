use super::directories::directory_from_history_command;
use std::path::PathBuf;

#[test]
fn parses_tilde_cd_from_history() {
    let home = PathBuf::from("/home/ada");
    assert_eq!(
        directory_from_history_command("cd ~/work", Some(home.as_path())),
        Some(PathBuf::from("/home/ada/work")),
    );
}

#[test]
fn parses_quoted_pushd_path_from_history() {
    assert_eq!(
        directory_from_history_command(r#"pushd "/tmp/my app""#, None),
        Some(PathBuf::from("/tmp/my app")),
    );
}

#[test]
fn skips_relative_history_paths() {
    let home = PathBuf::from("/home/ada");
    assert_eq!(
        directory_from_history_command("cd projects", Some(home.as_path())),
        None,
    );
    assert_eq!(
        directory_from_history_command("cd ..", Some(home.as_path())),
        None,
    );
}

#[test]
fn skips_non_ascii_history_prefixes_without_panicking() {
    assert_eq!(directory_from_history_command("›", None), None);
    assert_eq!(directory_from_history_command("› cd /tmp", None), None);
    assert_eq!(directory_from_history_command("c› /tmp", None), None);
}

#[test]
fn parses_windows_absolute_history_paths() {
    assert_eq!(
        directory_from_history_command(r#"Set-Location "C:\Users\ada\work""#, None),
        Some(PathBuf::from(r"C:\Users\ada\work")),
    );
    assert_eq!(
        directory_from_history_command(r#"cd D:\code\person\taomni"#, None),
        Some(PathBuf::from(r"D:\code\person\taomni")),
    );
    assert_eq!(
        directory_from_history_command(r#"cd "D:\code\my app""#, None),
        Some(PathBuf::from(r"D:\code\my app")),
    );
}
