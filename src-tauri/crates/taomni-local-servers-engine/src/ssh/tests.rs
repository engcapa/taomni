use super::authentication::load_authorized_key_file;
use super::authentication::parse_authorized_key;
use super::authentication::parse_authorized_keys_text;
use super::forwarding::is_loopback_addr;
use super::forwarding::resolve_listen_addr;
use super::pty_session::apply_env_exports;
use super::sftp_paths::canonical_client_path;
use super::sftp_paths::confine_path;
use russh_sftp::protocol::StatusCode;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

#[test]
fn confine_keeps_simple_paths_under_root() {
    let root = Path::new("/srv/share");
    assert_eq!(
        confine_path(root, "/").unwrap(),
        PathBuf::from("/srv/share")
    );
    assert_eq!(
        confine_path(root, "/a/b.txt").unwrap(),
        PathBuf::from("/srv/share/a/b.txt")
    );
    assert_eq!(
        confine_path(root, "sub/file").unwrap(),
        PathBuf::from("/srv/share/sub/file")
    );
}

#[test]
fn confine_allows_parent_within_root() {
    let root = Path::new("/srv/share");
    // Descend then climb back to root — allowed because depth stays >= 0.
    assert_eq!(
        confine_path(root, "/a/../b").unwrap(),
        PathBuf::from("/srv/share/b")
    );
}

#[test]
fn confine_rejects_escape_above_root() {
    let root = Path::new("/srv/share");
    assert_eq!(
        confine_path(root, "/../etc/passwd"),
        Err(StatusCode::PermissionDenied)
    );
    assert_eq!(
        confine_path(root, "/a/../../etc"),
        Err(StatusCode::PermissionDenied)
    );
}

#[test]
fn confine_treats_absolute_segment_as_root_reset() {
    let root = Path::new("/srv/share");
    // A second leading-root resets to the export root rather than the FS root.
    assert_eq!(
        confine_path(root, "/a//b").unwrap(),
        PathBuf::from("/srv/share/a/b")
    );
}

#[test]
fn resolve_listen_addr_normalizes_common_forms() {
    assert_eq!(resolve_listen_addr(""), "0.0.0.0");
    assert_eq!(resolve_listen_addr("*"), "0.0.0.0");
    assert_eq!(resolve_listen_addr("localhost"), "127.0.0.1");
    assert_eq!(resolve_listen_addr("127.0.0.1"), "127.0.0.1");
    assert_eq!(resolve_listen_addr("0.0.0.0"), "0.0.0.0");
    assert_eq!(resolve_listen_addr("::"), "::");
}

#[test]
fn loopback_detection() {
    assert!(is_loopback_addr("127.0.0.1"));
    assert!(is_loopback_addr("::1"));
    assert!(!is_loopback_addr("0.0.0.0"));
    assert!(!is_loopback_addr("192.168.1.1"));
}

#[test]
fn load_authorized_key_file_skips_comments_and_blank_lines() {
    let dir = std::env::temp_dir().join(format!(
        "taomni-ssh-key-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("id_ed25519.pub");
    // Fake base64 blob — parse is tested separately; load only extracts the line.
    std::fs::write(
        &path,
        "# comment\n\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyMaterialHere user@host\n",
    )
    .unwrap();
    let line = load_authorized_key_file(path.to_str().unwrap()).unwrap();
    assert!(line.starts_with("ssh-ed25519 "));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn client_path_renders_relative_to_root() {
    let root = Path::new("/srv/share");
    assert_eq!(canonical_client_path(root, Path::new("/srv/share")), "/");
    assert_eq!(
        canonical_client_path(root, Path::new("/srv/share/a/b")),
        "/a/b"
    );
}

#[test]
fn authorized_key_parses_openssh_line() {
    // A valid ed25519 public key line (from russh-keys' own doctest).
    let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ test@host";
    assert!(parse_authorized_key(line).is_ok());
    // Garbage base64 must error, not panic.
    assert!(parse_authorized_key("ssh-ed25519 not-base64!!").is_err());
    // Missing key body must error.
    assert!(parse_authorized_key("ssh-ed25519").is_err());
}

#[test]
fn multi_line_authorized_keys_text() {
    let line1 =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ a@host";
    let line2 =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ b@host";
    let text = format!("# comment\n\n{line1}\n{line2}\n");
    let keys = parse_authorized_keys_text(&text, "test").unwrap();
    assert_eq!(keys.len(), 2);
}

#[test]
fn apply_env_exports_prefixes_exports() {
    let mut env = HashMap::new();
    env.insert("LANG".into(), "C.UTF-8".into());
    let out = apply_env_exports("echo hi", &env);
    assert!(out.contains("export LANG="));
    assert!(out.ends_with("echo hi"));
}
