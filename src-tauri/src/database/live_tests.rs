use super::model::DbConfig;
use super::session::DbHandle;
use crate::database::sql;
use crate::database::tx;
use sqlx_postgres::Postgres;
use tokio_util::sync::CancellationToken;

/// Live Hologres smoke test for issue #101. It is ignored so normal test
/// runs do not depend on the user's network or credentials.
#[tokio::test]
#[ignore = "requires TAOMNI_TEST_HOST1/TAOMNI_TEST_AK1/TAOMNI_TEST_SK1 and Hologres network access"]
async fn hologres_postgres_session_lists_schemas_and_executes_query() {
    let host = std::env::var("TAOMNI_TEST_HOST1")
        .expect("TAOMNI_TEST_HOST1 must contain the Hologres PostgreSQL host");
    let username = std::env::var("TAOMNI_TEST_AK1")
        .expect("TAOMNI_TEST_AK1 must contain the Hologres access key");
    let password = std::env::var("TAOMNI_TEST_SK1")
        .expect("TAOMNI_TEST_SK1 must contain the Hologres secret key");
    let config = DbConfig {
        engine: "PostgreSQL".into(),
        host,
        port: 80,
        username: Some(username),
        password: Some(password),
        database: Some("cdp".into()),
        catalog: None,
        ssl: false,
        timeout_secs: Some(30),
        http_port: None,
        protocol: None,
        presto_dialect: None,
        db_index: None,
        network_settings: None,
    };

    let active_schema = sql::new_active_schema_slot(&config);
    let handle = sql::connect_postgres(
        &config,
        config.password.as_deref(),
        active_schema,
        tx::TxState::shared(),
    )
    .await
    .expect("Hologres PostgreSQL connect should succeed");
    let pool = match handle {
        DbHandle::Postgres(pool) => pool,
        _ => unreachable!("PostgreSQL config must create a Postgres pool"),
    };

    let schemas = sql::list_schemas_postgres(&pool)
        .await
        .expect("Hologres PostgreSQL schema listing should succeed");
    assert!(
        !schemas.is_empty(),
        "Hologres PostgreSQL schema listing should return at least one schema"
    );

    let result =
        sql::execute_postgres(&pool, "SELECT 1 AS taomni_smoke", &CancellationToken::new())
            .await
            .expect("Hologres PostgreSQL query execution should succeed");
    assert_eq!(result.columns[0].name, "taomni_smoke");
    assert_eq!(result.rows[0][0].as_deref(), Some("1"));

    pool.close().await;
}
