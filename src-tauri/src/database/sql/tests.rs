use super::mysql_catalog::add_mysql_schema_name;
use super::mysql_catalog::mysql_table_kind;
use super::schema_helpers::quote_mysql_ident;
use super::schema_helpers::quote_mysql_table;
use super::schema_helpers::quote_sqlserver_ident;
use super::schema_helpers::sqlserver_default_schema;
use super::schema_helpers::sqlserver_qualified;
use super::statements::is_query;
use super::statements::needs_mysql_text_protocol;
use super::statements::parse_default_schema_switch;
use std::collections::BTreeSet;

#[test]
fn mysql_schema_names_include_visible_databases_and_deduplicate() {
    let mut names = BTreeSet::new();
    add_mysql_schema_name(&mut names, Some("mysql".into()));
    add_mysql_schema_name(&mut names, Some(" information_schema ".into()));
    add_mysql_schema_name(&mut names, Some("test".into()));
    add_mysql_schema_name(&mut names, Some("test".into()));
    add_mysql_schema_name(&mut names, Some("app".into()));

    assert_eq!(
        names.into_iter().collect::<Vec<_>>(),
        vec![
            "app".to_string(),
            "information_schema".to_string(),
            "mysql".to_string(),
            "test".to_string()
        ]
    );
}

#[test]
fn mysql_identifier_quoting_escapes_backticks() {
    assert_eq!(quote_mysql_ident("te`st"), "`te``st`");
    assert_eq!(
        quote_mysql_table(Some("db`1"), "ta`ble"),
        "`db``1`.`ta``ble`"
    );
}

#[test]
fn mysql_table_kind_maps_views() {
    assert_eq!(mysql_table_kind("VIEW"), "view");
    assert_eq!(mysql_table_kind("BASE TABLE"), "table");
}

#[test]
fn sqlserver_identifier_quoting_escapes_brackets() {
    assert_eq!(quote_sqlserver_ident("te]st"), "[te]]st]");
    assert_eq!(
        sqlserver_qualified(Some("dbo]x"), "ta]ble"),
        "[dbo]]x].[ta]]ble]"
    );
}

#[test]
fn sqlserver_default_schema_falls_back_to_dbo() {
    assert_eq!(sqlserver_default_schema(None), "dbo");
    assert_eq!(sqlserver_default_schema(Some("  ")), "dbo");
    assert_eq!(sqlserver_default_schema(Some("sales")), "sales");
}

#[test]
fn query_detection_skips_leading_comments() {
    assert!(is_query("-- explain selected statement\nSELECT 1"));
    assert!(is_query("/* leading ; block */ SHOW TABLES"));
    assert!(is_query(
        "# mysql comment\nWITH cte AS (SELECT 1) SELECT * FROM cte"
    ));
    assert!(!is_query("-- mutate\nINSERT INTO t VALUES (1)"));
    assert!(!is_query("/* unterminated"));
}

#[test]
fn mysql_use_requires_text_protocol() {
    assert!(needs_mysql_text_protocol("USE `app`"));
    assert!(needs_mysql_text_protocol("-- switch\nUSE app;"));
    assert!(!needs_mysql_text_protocol("INSERT INTO t VALUES (1)"));
    assert!(!needs_mysql_text_protocol("SELECT 1"));
}

#[test]
fn parse_default_schema_switch_supports_common_dialects() {
    assert_eq!(
        parse_default_schema_switch("USE `ali-model-tools`"),
        Some("ali-model-tools".into())
    );
    assert_eq!(
        parse_default_schema_switch("use ecommerce;"),
        Some("ecommerce".into())
    );
    assert_eq!(
        parse_default_schema_switch(r#"SET search_path TO "sales""#),
        Some("sales".into())
    );
    assert_eq!(
        parse_default_schema_switch(r#"ALTER SESSION SET CURRENT_SCHEMA = "HR""#),
        Some("HR".into())
    );
    assert_eq!(parse_default_schema_switch("SELECT 1"), None);
}
