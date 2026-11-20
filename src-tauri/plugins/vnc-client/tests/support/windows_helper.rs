use std::{
    fs,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

pub async fn wait_for_child(host: u32, running: bool) {
    tokio::task::spawn_blocking(move || {
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"ParentProcessId = {host} AND Name = 'taomni-vnc-key-helper.exe'\" | ForEach-Object ExecutablePath"
        );
        let expected = Path::new(env!("CARGO_BIN_EXE_taomni-plugin-vnc-client"))
            .with_file_name("taomni-vnc-key-helper.exe");
        let expected = fs::canonicalize(expected).expect("compiled Windows key helper");
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let output = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .output()
                .unwrap();
            assert!(output.status.success(), "{:?}", output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let children: Vec<_> = stdout.lines().filter(|line| !line.trim().is_empty()).collect();
            if running && children.len() == 1 {
                assert_eq!(fs::canonicalize(children[0].trim()).unwrap(), expected);
                println!("VNC module PID {host} started its Windows key helper: {}", expected.display());
                return;
            }
            if !running && children.is_empty() {
                println!("VNC module PID {host} released its Windows key helper on WebSocket close");
                return;
            }
            assert!(Instant::now() < deadline, "VNC helper running={running}: {children:?}");
            thread::sleep(Duration::from_millis(100));
        }
    })
    .await
    .unwrap();
}
