//! Real native effects: hosted-only ignored tests, not part of local unit filters.
use super::process::{configure, supervise};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

async fn wait_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned native fixture did not reach the observed lifecycle boundary");
}

async fn exercise(mode: &str) {
    assert_eq!(
        std::env::var("GITHUB_ACTIONS").as_deref(),
        Ok("true"),
        "real process verification is GitHub-only"
    );
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("owned-native-test"),
        "taomni-orchestration",
    )
    .unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/orchestration/execution/fixtures/process_lifecycle.py");
    let mut command = Command::new("python3");
    command
        .args(["-I"])
        .arg(fixture)
        .arg(mode)
        .arg(root.path())
        .stderr(Stdio::null());
    configure(&mut command);
    let child = command
        .spawn()
        .expect("hosted Python process fixture required");
    let token = CancellationToken::new();
    let outcome = if mode == "cancel" {
        let work = supervise(child, String::new(), &token);
        let cancel = async {
            wait_file(&root.path().join("descendant-pid")).await;
            token.cancel();
        };
        let (outcome, _) = tokio::join!(work, cancel);
        outcome
    } else {
        supervise(child, String::new(), &token).await
    };
    if mode == "cancel" {
        assert_eq!(outcome, Err("CANCELLED".into()));
    } else {
        assert!(outcome.unwrap().contains("Native lifecycle fixture"));
    }
    // This comes from the real descendant's SIGTERM handler, not a mocked child
    // status. Success also requires the production group-empty observation.
    wait_file(&root.path().join("descendant-stopped")).await;
    let pid = std::fs::read_to_string(root.path().join("descendant-pid")).unwrap();
    let stopped = std::fs::read_to_string(root.path().join("descendant-stopped")).unwrap();
    assert_eq!(pid, stopped);
}

#[tokio::test]
#[ignore = "hosted native process-group side effects; local tests are unit-only"]
async fn hosted_lifecycle_exited_leader_does_not_leave_stdio_closed_descendant() {
    exercise("leader").await;
}

#[tokio::test]
#[ignore = "hosted native process-group side effects; local tests are unit-only"]
async fn hosted_lifecycle_cancel_stops_real_stdio_closed_descendant() {
    exercise("cancel").await;
}
