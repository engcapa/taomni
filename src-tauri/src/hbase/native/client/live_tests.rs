//! Integration tests against a real HBase standalone cluster.
//!
//! These are gated behind `HBASE_LIVE_TEST=1` (and an optional
//! `HBASE_ZK=host:port`, default `127.0.0.1:2181`) so the normal unit-test
//! run stays hermetic. Run with:
//! `HBASE_LIVE_TEST=1 cargo test --lib hbase::native::client::live_tests -- --nocapture --test-threads=1`

use super::connection::NativeClient;
use super::model::NativeConfig;
use crate::hbase::native::zk;
use std::time::Duration;

fn live_client() -> Option<NativeClient> {
    if std::env::var("HBASE_LIVE_TEST").ok().as_deref() != Some("1") {
        return None;
    }
    let zk = std::env::var("HBASE_ZK").unwrap_or_else(|_| "127.0.0.1:2181".into());
    Some(NativeClient::new(NativeConfig {
        zk_quorum: zk,
        zk_root: "/hbase".into(),
        effective_user: "test".into(),
        namespace: None,
        timeout: Duration::from_secs(20),
        auth: super::super::auth::AuthMethod::Simple,
    }))
}

#[tokio::test]
async fn live_ping() {
    let Some(c) = live_client() else { return };
    let msg = c.ping().await.expect("ping failed");
    println!("PING: {msg}");
    assert!(msg.contains("OK"));
}

#[tokio::test]
async fn live_full_lifecycle() {
    let Some(c) = live_client() else { return };
    let table = "taomni_native_it";
    let mut fam = std::collections::BTreeMap::new();
    fam.insert("VERSIONS".to_string(), "1".to_string());

    // Clean slate: drop if exists (ignore errors).
    let _ = c.drop_table(table).await;

    // create
    c.create_table(table, &[("cf".to_string(), fam)])
        .await
        .expect("create_table");
    println!("created {table}");

    // list contains it
    let tables = c.list_tables().await.expect("list_tables");
    println!("tables: {tables:?}");
    assert!(tables.iter().any(|t| t == table));

    // describe
    let (name, families) = c.describe_table(table).await.expect("describe");
    println!("describe {name}: {families:?}");
    assert!(families.iter().any(|f| f.name == "cf"));

    // put
    c.put(table, b"row1", "cf:q1", b"hello").await.expect("put");
    c.put(table, b"row2", "cf:q1", b"world")
        .await
        .expect("put2");
    println!("put 2 rows");

    // get
    let got = c.get(table, b"row1", Some("cf:q1")).await.expect("get");
    println!("get row1: {got:?}");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].value, b"hello");

    // scan
    let scanned = c.scan(table, 100, None, None, &[]).await.expect("scan");
    println!("scan: {} cells", scanned.len());
    assert!(scanned.len() >= 2);

    // delete one column
    c.delete(table, b"row1", "cf:q1").await.expect("delete");
    let after = c.get(table, b"row1", Some("cf:q1")).await.expect("get2");
    println!("after delete row1: {after:?}");
    assert!(after.is_empty());

    // deleteall row2
    c.delete_all(table, b"row2").await.expect("delete_all");

    // drop
    c.drop_table(table).await.expect("drop_table");
    let tables = c.list_tables().await.expect("list2");
    assert!(!tables.iter().any(|t| t == table), "table still present");
    println!("dropped {table} — lifecycle OK");
}
