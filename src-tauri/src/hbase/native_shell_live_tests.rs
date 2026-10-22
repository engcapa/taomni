//! End-to-end test of the shell-command path (parse + native_execute)
//! against a live standalone HBase. Gated by HBASE_LIVE_TEST=1.
use super::model::HBaseShellResult;
use super::native::{
    auth::AuthMethod,
    client::{NativeClient, NativeConfig},
};
use super::native_commands::native_execute;
use super::shell_parser::parse_shell_command;

fn client() -> Option<NativeClient> {
    if std::env::var("HBASE_LIVE_TEST").ok().as_deref() != Some("1") {
        return None;
    }
    let zk = std::env::var("HBASE_ZK").unwrap_or_else(|_| "127.0.0.1:2181".into());
    Some(NativeClient::new(NativeConfig {
        zk_quorum: zk,
        zk_root: "/hbase".into(),
        effective_user: "test".into(),
        namespace: None,
        timeout: std::time::Duration::from_secs(20),
        auth: AuthMethod::Simple,
    }))
}

async fn run(c: &NativeClient, cmd: &str) -> HBaseShellResult {
    let parsed = parse_shell_command(cmd).expect("parse");
    native_execute(c, parsed, cmd.to_string())
        .await
        .unwrap_or_else(|e| panic!("exec `{cmd}` failed: {e}"))
}

#[tokio::test]
async fn shell_path_lifecycle() {
    let Some(c) = client() else { return };
    let t = "taomni_shell_it";
    // Best-effort cleanup; tolerate "table not found" if it's absent.
    let _ = native_execute(
        &c,
        parse_shell_command(&format!("drop '{t}'")).unwrap(),
        format!("drop '{t}'"),
    )
    .await;

    let r = run(&c, &format!("create '{t}', {{NAME=>'cf', VERSIONS=>3}}")).await;
    println!("create msg: {}", r.message);

    let list = run(&c, "list").await;
    assert!(list.rows.iter().any(|row| row[0] == t), "list missing {t}");

    run(&c, &format!("put '{t}', 'r1', 'cf:a', 'v1'")).await;
    run(&c, &format!("put '{t}', 'r2', 'cf:a', 'v2'")).await;

    let got = run(&c, &format!("get '{t}', 'r1'")).await;
    assert_eq!(got.rows.len(), 1);
    assert_eq!(got.rows[0][3], "v1");

    let scanned = run(&c, &format!("scan '{t}', {{LIMIT=>50}}")).await;
    assert!(scanned.rows.len() >= 2, "scan rows: {}", scanned.rows.len());

    let desc = run(&c, &format!("describe '{t}'")).await;
    assert!(desc.rows.iter().any(|r| r[0] == "cf"));

    run(&c, &format!("deleteall '{t}', 'r1'")).await;
    let after = run(&c, &format!("get '{t}', 'r1'")).await;
    assert_eq!(after.rows.len(), 0);

    run(&c, &format!("drop '{t}'")).await;
    let list2 = run(&c, "list").await;
    assert!(!list2.rows.iter().any(|row| row[0] == t));
    println!("shell-path lifecycle OK");
}
