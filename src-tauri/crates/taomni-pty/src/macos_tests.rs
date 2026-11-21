#[cfg(unix)]
use super::environment::apply_terminal_environment;
use super::lifetime::create_pty;
use portable_pty::CommandBuilder;
#[cfg(target_os = "macos")]
use std::ffi::OsStr;
use std::io::Read;

fn env<'a>(cmd: &'a CommandBuilder, key: &str) -> Option<&'a str> {
    cmd.get_env(key).and_then(OsStr::to_str)
}

#[test]
fn terminal_environment_repairs_empty_and_c_locale_on_macos() {
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.env("LANG", "");
    cmd.env("LC_CTYPE", "C");
    cmd.env("LC_ALL", "C");

    apply_terminal_environment(&mut cmd);

    assert_eq!(env(&cmd, "TERM"), Some("xterm-256color"));
    assert_eq!(env(&cmd, "LANG"), Some("en_US.UTF-8"));
    assert_eq!(env(&cmd, "LC_CTYPE"), Some("en_US.UTF-8"));
    assert_eq!(env(&cmd, "LC_ALL"), Some("en_US.UTF-8"));
}

#[test]
fn terminal_environment_uses_existing_utf8_locale_as_fallback_on_macos() {
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.env("LANG", "zh_CN.UTF-8");
    cmd.env("LC_CTYPE", "C");
    cmd.env("LC_ALL", "");

    apply_terminal_environment(&mut cmd);

    assert_eq!(env(&cmd, "LANG"), Some("zh_CN.UTF-8"));
    assert_eq!(env(&cmd, "LC_CTYPE"), Some("zh_CN.UTF-8"));
    assert_eq!(env(&cmd, "LC_ALL"), Some(""));
}

#[test]
fn terminal_environment_replaces_c_utf8_on_macos() {
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.env("LANG", "zh_CN.UTF-8");
    cmd.env("LC_CTYPE", "C.UTF-8");
    cmd.env("LC_ALL", "C.UTF-8");

    apply_terminal_environment(&mut cmd);

    assert_eq!(env(&cmd, "LANG"), Some("zh_CN.UTF-8"));
    assert_eq!(env(&cmd, "LC_CTYPE"), Some("zh_CN.UTF-8"));
    assert_eq!(env(&cmd, "LC_ALL"), Some("zh_CN.UTF-8"));
}

#[test]
fn terminal_environment_preserves_explicit_utf8_locale_on_macos() {
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.env("LANG", "ja_JP.UTF-8");
    cmd.env("LC_CTYPE", "zh_CN.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");

    apply_terminal_environment(&mut cmd);

    assert_eq!(env(&cmd, "LANG"), Some("ja_JP.UTF-8"));
    assert_eq!(env(&cmd, "LC_CTYPE"), Some("zh_CN.UTF-8"));
    assert_eq!(env(&cmd, "LC_ALL"), Some("en_US.UTF-8"));
}

#[test]
fn create_pty_lists_utf8_filename_on_macos() {
    let temp = tempfile::tempdir().expect("create temp dir");
    let filename = "\u{5bfc}\u{56fe}1.emmx";
    std::fs::write(temp.path().join(filename), b"").expect("write utf8 filename");

    let (mut handle, mut reader, _) = create_pty(
        80,
        24,
        Some("/bin/ls".to_string()),
        Some(vec![
            "-1".to_string(),
            temp.path().to_string_lossy().into_owned(),
        ]),
        None,
    )
    .expect("spawn ls in pty");

    let mut output = String::new();
    reader.read_to_string(&mut output).expect("read ls output");
    let status = handle.child.wait().expect("wait for ls");

    assert!(status.success(), "ls exited with {status}");
    assert!(
        output.contains(filename),
        "ls output should include utf8 filename, got {output:?}"
    );
}
