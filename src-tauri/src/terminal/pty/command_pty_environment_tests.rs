#[cfg(target_os = "linux")]
use super::lifetime::create_command_pty_with_environment;
use std::ffi::OsString;

use std::io::Read;

#[test]
fn command_pty_has_a_controlling_tty_and_custom_environment() {
    let args = vec![
        "-c".to_string(),
        "test -t 0 && test \"$TAOMNI_PTY_TEST\" = ok && printf pty-ready".to_string(),
    ];
    let environment = vec![(OsString::from("TAOMNI_PTY_TEST"), OsString::from("ok"))];
    let (mut handle, mut reader) =
        create_command_pty_with_environment(80, 24, "/bin/sh", &args, &environment).unwrap();

    let status = handle.child.wait().unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 256];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => bytes.extend_from_slice(&buffer[..count]),
        }
    }
    let output = String::from_utf8_lossy(&bytes);

    assert!(status.success());
    assert!(output.contains("pty-ready"));
}
