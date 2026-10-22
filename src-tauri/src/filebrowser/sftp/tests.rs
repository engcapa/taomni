use super::connection::is_disconnect_error;
use super::connection::network_with_keepalive;
use crate::terminal::network::NetworkSettings;

#[test]
fn disconnect_errors_are_classified_for_retry() {
    // The exact string from issue #425 (russh-sftp UnexpectedBehavior,
    // wrapped by list_dir's "Failed to read {path}: {e}").
    assert!(is_disconnect_error(
        "Failed to read /data/users/x/scripts: session closed"
    ));
    assert!(is_disconnect_error("sender dropped"));
    assert!(is_disconnect_error("Unexpected EOF on stream"));
    assert!(is_disconnect_error("connection reset by peer"));
    assert!(is_disconnect_error("Broken pipe"));
    assert!(is_disconnect_error("Timeout"));
}

#[test]
fn genuine_file_errors_are_not_retried() {
    assert!(!is_disconnect_error("stat /x: No such file or directory"));
    assert!(!is_disconnect_error("mkdir /x: Permission denied"));
    assert!(!is_disconnect_error(
        "File is 999 bytes, exceeds preview limit"
    ));
}

#[test]
fn keepalive_is_forced_on_for_sftp() {
    // No settings at all → synthesize a keep-alive.
    let n = network_with_keepalive(None);
    assert!(n.keep_alive);
    assert_eq!(n.keep_alive_interval_secs, 30);

    // keep_alive on but interval unset (the Rust default) → fill a default.
    let mut base = NetworkSettings::default();
    base.keep_alive = true;
    base.keep_alive_interval_secs = 0;
    let n = network_with_keepalive(Some(&base));
    assert_eq!(n.keep_alive_interval_secs, 30);

    // Explicit user interval is preserved.
    base.keep_alive_interval_secs = 60;
    let n = network_with_keepalive(Some(&base));
    assert_eq!(n.keep_alive_interval_secs, 60);

    // A synthesized default must not accidentally select a proxy.
    let n = network_with_keepalive(None);
    assert!(n.proxy_kind.is_empty() || n.proxy_kind == "none");
}
