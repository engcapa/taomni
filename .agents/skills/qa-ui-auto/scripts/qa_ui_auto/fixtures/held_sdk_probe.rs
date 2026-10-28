//! A real executable called by the production SDK version probe. No app hooks.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn event(root: &Path, phase: &str) {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let line = format!(
        "{{\"pid\":{},\"phase\":\"{}\",\"epochMs\":{}}}\n",
        std::process::id(),
        phase,
        millis,
    );
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(root.join("events.jsonl"))
        .unwrap()
        .write_all(line.as_bytes())
        .unwrap();
}

fn main() {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["-version"] {
        eprintln!("Fixture accepts only the SDK -version probe");
        std::process::exit(2);
    }
    let executable = std::env::current_exe().unwrap();
    let root = executable.parent().unwrap().parent().unwrap();
    event(root, "started");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !root.join("release").is_file() {
        if Instant::now() >= deadline {
            event(root, "fixture-timeout");
            std::process::exit(3);
        }
        event(root, "waiting");
        std::thread::sleep(Duration::from_millis(50));
    }
    if fs::read_to_string(root.join("mode"))
        .unwrap_or_default()
        .trim()
        == "error"
    {
        event(root, "rejected");
        eprintln!("QA held SDK version probe failed");
        std::process::exit(1);
    }
    event(root, "released");
    eprintln!("openjdk version \"21.0.8\"\nOpenJDK Runtime Environment QA");
}
