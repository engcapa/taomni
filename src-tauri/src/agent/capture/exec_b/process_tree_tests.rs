use super::*;
use std::path::Path;

fn nested_command(root: &Path) -> String {
    let script = root.join(if cfg!(windows) {
        "child.ps1"
    } else {
        "child.sh"
    });
    let source = if cfg!(windows) {
        "[IO.File]::WriteAllText('started', [string]$PID)\nStart-Sleep -Milliseconds 2000\n[IO.File]::WriteAllText('late', 'must not happen')"
    } else {
        "printf '%s' \"$$\" > started\nsleep 2\nprintf 'must not happen' > late"
    };
    std::fs::write(&script, source).unwrap();
    let script = posix_quote(script.to_str().unwrap());
    if cfg!(windows) {
        format!("& pwsh -NoProfile -NonInteractive -File {script}")
    } else {
        // Keep an outer shell alive, rather than allowing tail-exec optimization.
        format!("sh {script}; :")
    }
}

async fn wait_started(root: &Path) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while !root.join("started").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("nested shell must start before cancellation");
}

async fn assert_no_delayed_write(root: &Path) {
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert!(
        !root.join("late").exists(),
        "cancelled descendant kept working"
    );
}

#[tokio::test]
async fn cancellation_terminates_nested_shell_before_reporting_cancelled() {
    let root = tempfile::tempdir().unwrap();
    let command = nested_command(root.path());
    let cwd = root.path().to_str().unwrap().to_string();
    let writer = CaptureWriter::create(root.path(), "cancel").unwrap();
    let cancel = Arc::new(Notify::new());
    let signal = cancel.clone();
    let task =
        tokio::spawn(
            async move { run_local(&command, Some(&cwd), &writer, cancel, |_, _| {}).await },
        );
    wait_started(root.path()).await;
    signal.notify_one();
    let outcome = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("cancellation must settle promptly")
        .unwrap()
        .unwrap();
    assert_eq!(outcome.status, CaptureStatus::Cancelled);
    assert_ne!(outcome.exit_code, Some(0));
    assert_no_delayed_write(root.path()).await;
}

#[tokio::test]
async fn dropping_capture_future_cleans_up_descendants() {
    let root = tempfile::tempdir().unwrap();
    let command = nested_command(root.path());
    let cwd = root.path().to_str().unwrap().to_string();
    let writer = CaptureWriter::create(root.path(), "drop").unwrap();
    let task = tokio::spawn(async move {
        run_local(
            &command,
            Some(&cwd),
            &writer,
            Arc::new(Notify::new()),
            |_, _| {},
        )
        .await
    });
    wait_started(root.path()).await;
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert_no_delayed_write(root.path()).await;
}

#[tokio::test]
async fn completed_and_failed_captures_preserve_output_and_real_exit_status() {
    let root = tempfile::tempdir().unwrap();
    for code in [0, 7] {
        let writer = CaptureWriter::create(root.path(), &format!("exit-{code}")).unwrap();
        let command = if cfg!(windows) {
            format!("[Console]::Out.WriteLine('captured-output'); exit {code}")
        } else {
            format!("printf 'captured-output\\n'; exit {code}")
        };
        let outcome = run_local(&command, None, &writer, Arc::new(Notify::new()), |_, _| {})
            .await
            .unwrap();
        assert_eq!(outcome.status, CaptureStatus::Done);
        assert_eq!(outcome.exit_code, Some(code));
        assert_eq!(
            std::fs::read_to_string(writer.path()).unwrap().trim(),
            "captured-output"
        );
    }
}
