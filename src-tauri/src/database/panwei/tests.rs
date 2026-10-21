use super::catalog::ordered_schema_infos;
use super::catalog::panwei_relkind_to_kind;
use super::catalog::should_use_show_tables_fallback;
use super::connection::build_connect_config;
use crate::database::DbConfig;
use tokio_opengauss::config::SslMode;

#[test]
fn orders_current_schema_first_without_system_names() {
    let schemas = ordered_schema_infos(
        vec![
            "public".to_string(),
            "panwei_omm".to_string(),
            "information_schema".to_string(),
            "pg_catalog".to_string(),
        ],
        Some("panwei_omm"),
    );
    let names: Vec<_> = schemas.into_iter().map(|schema| schema.name).collect();
    assert_eq!(names, vec!["panwei_omm", "public"]);
}

#[test]
fn maps_pg_relkind_to_object_kind() {
    assert_eq!(panwei_relkind_to_kind("r"), Some("table"));
    assert_eq!(panwei_relkind_to_kind("p"), Some("table"));
    assert_eq!(panwei_relkind_to_kind("v"), Some("view"));
    assert_eq!(panwei_relkind_to_kind("m"), Some("materialized_view"));
    assert_eq!(panwei_relkind_to_kind("i"), None);
}

#[test]
fn show_tables_fallback_only_tracks_current_schema() {
    assert!(should_use_show_tables_fallback(
        "panwei_omm",
        Some("panwei_omm")
    ));
    assert!(!should_use_show_tables_fallback(
        "public",
        Some("panwei_omm")
    ));
    assert!(!should_use_show_tables_fallback("public", None));
}

#[test]
fn config_uses_required_ssl_mode_when_tls_is_enabled() {
    let config = DbConfig {
        engine: "PanWeiDB".to_string(),
        host: "127.0.0.1".to_string(),
        port: 17700,
        username: Some("panwei_omm".to_string()),
        password: None,
        catalog: None,
        database: Some("panweidb".to_string()),
        ssl: true,
        timeout_secs: None,
        http_port: None,
        protocol: None,
        presto_dialect: None,
        db_index: None,
        network_settings: None,
    };
    assert_eq!(
        build_connect_config(&config, None).get_ssl_mode(),
        SslMode::Require
    );
}

#[test]
fn config_disables_ssl_mode_when_tls_is_disabled() {
    let config = DbConfig {
        engine: "PanWeiDB".to_string(),
        host: "127.0.0.1".to_string(),
        port: 17700,
        username: Some("panwei_omm".to_string()),
        password: None,
        catalog: None,
        database: Some("panweidb".to_string()),
        ssl: false,
        timeout_secs: None,
        http_port: None,
        protocol: None,
        presto_dialect: None,
        db_index: None,
        network_settings: None,
    };
    assert_eq!(
        build_connect_config(&config, None).get_ssl_mode(),
        SslMode::Disable
    );
}
