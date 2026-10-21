
//! End-to-end test against a live *Kerberos-secured* HBase, exercising the
//! exact program path the UI uses: `build_session` (which parses
//! hbase-site.xml, runs the keytab env setup, and builds the native client)
//! → `ping_backend` → `list`.
//!
//! Gated by HBASE_KRB_LIVE_TEST=1. All cluster-specific and secret values
//! come from the environment / on-disk files — nothing is hardcoded:
//!   HBASE_KRB_LIVE_TEST=1   (gate)
//!   HBASE_SITE_XML=/path/to/hbase-site.xml
//!   HBASE_KEYTAB=/path/to/service.keytab
//!   HBASE_KRB5_CONF=/path/to/krb5.conf
//!   HBASE_CLIENT_PRINCIPAL=hbase/host@REALM   (optional; else derived from keytab)
//!   HBASE_SERVICE_PRINCIPAL=hbase/_HOST@REALM (optional; else from hbase-site.xml)
//!   HBASE_EFFECTIVE_USER=hbase                (optional; default "root")
//! Run with:
//!   cargo test --lib hbase::kerberos_live_tests -- --nocapture --test-threads=1
use super::configuration::build_session;
use super::model::{HBaseConfig, HBaseSessionInner};
use super::native_commands::native_execute;
use super::ping_backend;
use super::rest_operations::execute_command;
use super::shell_parser::parse_shell_command;
use super::thrift_commands::thrift_execute;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.trim().is_empty())
}

fn config_from_env() -> Option<HBaseConfig> {
    if env("HBASE_KRB_LIVE_TEST").as_deref() != Some("1") {
        return None;
    }
    let site = env("HBASE_SITE_XML");
    let keytab = env("HBASE_KEYTAB");
    Some(HBaseConfig {
        host: String::new(),
        port: 2181,
        username: None,
        password: None,
        ssl: false,
        timeout_secs: Some(20),
        rest_path: None,
        namespace: None,
        connection_mode: Some("native".into()),
        zk_quorum: env("HBASE_ZK_QUORUM"),
        zk_root: env("HBASE_ZK_ROOT"),
        effective_user: env("HBASE_EFFECTIVE_USER").or_else(|| Some("root".into())),
        auth_method: Some("kerberos".into()),
        service_principal: env("HBASE_SERVICE_PRINCIPAL"),
        principal: env("HBASE_CLIENT_PRINCIPAL"),
        keytab_path: keytab,
        krb5_conf_path: env("HBASE_KRB5_CONF"),
        hbase_site_path: site,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn krb_connect_and_list() {
    let Some(config) = config_from_env() else {
        eprintln!("skipping: set HBASE_KRB_LIVE_TEST=1 and friends to run");
        return;
    };
    eprintln!(
        "config: zk_quorum(from xml)?, service_principal={:?}, client_principal={:?}, keytab={:?}",
        config.service_principal, config.principal, config.keytab_path
    );

    let session = build_session(&config, None)
        .await
        .expect("build_session failed");

    let ping = ping_backend(&session).await;
    eprintln!("PING: {ping:?}");
    ping.expect("ping failed");

    let parsed = parse_shell_command("list").unwrap();
    let result = match &session {
        HBaseSessionInner::Native(c) => native_execute(c, parsed, "list".into()).await,
        HBaseSessionInner::Rest(r) => execute_command(r, parsed, "list".into()).await,
        HBaseSessionInner::Thrift(t) => thrift_execute(t, parsed, "list".into()).await,
    }
    .expect("list failed");
    eprintln!("LIST: {} -> {:?}", result.message, result.rows);
    assert!(result.message.contains("table"));

    // Optional: prove `list` surfaces a real table by running a
    // create -> list -> drop cycle (gated; only on an explicit flag because
    // it mutates the cluster). Uses a uniquely-named temp table and drops it.
    if env("HBASE_KRB_WRITE_TEST").as_deref() == Some("1") {
        let HBaseSessionInner::Native(c) = &session else {
            return;
        };
        let t = format!("taomni_krb_probe_{}", std::process::id());
        let _ = c.drop_table(&t).await; // best-effort pre-clean
        c.create_table(&t, &[("cf".into(), Default::default())])
            .await
            .expect("create_table failed");
        let listed = c.list_tables().await.expect("list_tables failed");
        eprintln!("LIST after create: {listed:?}");
        assert!(listed.iter().any(|n| n == &t), "created table not listed");
        c.drop_table(&t).await.expect("drop_table failed");
        eprintln!("create/list/drop cycle OK for {t}");
    }
}
