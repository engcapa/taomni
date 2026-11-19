use super::*;

fn database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE sessions (id TEXT, session_type TEXT, password TEXT);
             CREATE TABLE rdp_certificate_pins (host TEXT);
             CREATE TABLE server_configs (server_type TEXT, config_json TEXT);",
        )
        .unwrap();
    connection
}

fn owners(connection: &Connection) -> Vec<(MigrationItem, String)> {
    inspect_database(connection)
        .unwrap()
        .1
        .into_iter()
        .map(|candidate| (candidate.item, candidate.plugin_slug))
        .collect()
}

#[test]
fn fresh_schema_and_core_only_sessions_have_no_module_candidates() {
    let connection = database();
    assert!(owners(&connection).is_empty());
    connection
        .execute_batch(
            "INSERT INTO sessions VALUES ('ssh', 'SSH', 'never-read');
             INSERT INTO sessions VALUES ('sftp', 'SFTP', 'never-read');
             INSERT INTO sessions VALUES ('local', 'LocalShell', NULL);
             INSERT INTO sessions VALUES ('future', 'FutureProtocol', NULL);",
        )
        .unwrap();
    assert!(owners(&connection).is_empty());
}

#[test]
fn vnc_only_sessions_recommend_the_vnc_owner_and_preserve_every_record() {
    let connection = database();
    connection
        .execute_batch(
            "INSERT INTO sessions VALUES ('vnc', 'VNC', 'never-read');
             INSERT INTO sessions VALUES ('vnc2', 'VNC', 'also-not-read');",
        )
        .unwrap();
    let before = connection.total_changes();
    connection.pragma_update(None, "query_only", true).unwrap();
    assert_eq!(
        owners(&connection),
        vec![(MigrationItem::VncSessions, "vnc-client".into())]
    );
    assert_eq!(connection.total_changes(), before);
    assert_eq!(
        connection
            .query_row(
                "SELECT password FROM sessions WHERE id = 'vnc'",
                [],
                |row| { row.get::<_, String>(0) }
            )
            .unwrap(),
        "never-read"
    );
    let snapshot = serde_json::to_string(&inspect_database(&connection).unwrap().1).unwrap();
    assert!(!snapshot.contains("never-read"));
    assert!(!snapshot.contains("also-not-read"));
}

#[test]
fn each_populated_feature_gets_its_own_candidate_in_stable_order() {
    let connection = database();
    connection
        .execute_batch(
            "INSERT INTO sessions VALUES ('rdp', 'RDP', NULL);
             INSERT INTO sessions VALUES ('vnc', 'VNC', NULL);
             INSERT INTO sessions VALUES ('mail-a', 'Mail', 'opaque-vault-reference');
             INSERT INTO sessions VALUES ('mail-b', 'Mail', 'second-opaque-reference');
             INSERT INTO rdp_certificate_pins VALUES ('example.test');
             INSERT INTO server_configs VALUES ('ssh', '{}');",
        )
        .unwrap();
    let expected = vec![
        (MigrationItem::RdpVncSessions, "rdp-client".into()),
        (MigrationItem::VncSessions, "vnc-client".into()),
        (MigrationItem::MailAccounts, "mail".into()),
        (MigrationItem::RdpCertificatePins, "rdp-client".into()),
        (MigrationItem::ServerConfigs, "servers".into()),
    ];
    assert_eq!(owners(&connection), expected);
    assert_eq!(owners(&connection), expected);
    let wire = serde_json::to_string(&inspect_database(&connection).unwrap().1).unwrap();
    assert!(wire.contains("mail-accounts"));
    assert!(!wire.contains("opaque-vault-reference"));
    assert!(!wire.contains("second-opaque-reference"));
    assert!(
        inspect_database(&connection)
            .unwrap()
            .1
            .iter()
            .all(|candidate| candidate.evidence == ["taomni.db"])
    );
}

#[test]
fn certificate_pins_do_not_invent_a_session_migration() {
    let connection = database();
    connection
        .execute(
            "INSERT INTO rdp_certificate_pins VALUES ('example.test')",
            [],
        )
        .unwrap();
    assert_eq!(
        owners(&connection),
        vec![(MigrationItem::RdpCertificatePins, "rdp-client".into())]
    );
}

#[test]
fn missing_tables_are_empty_but_malformed_session_schema_is_an_error() {
    let connection = Connection::open_in_memory().unwrap();
    assert!(inspect_database(&connection).unwrap().1.is_empty());
    connection
        .execute_batch("CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('unknown');")
        .unwrap();
    let error = inspect_database(&connection).unwrap_err();
    assert!(error.contains("sessions records cannot be inspected"));
    assert!(error.contains("session_type"));
}

#[test]
fn existing_rdp_journal_spelling_is_unchanged_and_vnc_is_additive() {
    assert_eq!(
        serde_json::to_string(&MigrationItem::RdpVncSessions).unwrap(),
        "\"rdp-vnc-sessions\""
    );
    assert_eq!(
        serde_json::to_string(&MigrationItem::VncSessions).unwrap(),
        "\"vnc-sessions\""
    );
    assert_eq!(
        serde_json::to_string(&MigrationItem::ServerConfigs).unwrap(),
        "\"server-configs\""
    );
    assert_eq!(
        serde_json::to_string(&MigrationItem::RdpServerConfigs).unwrap(),
        "\"rdp-server-configs\""
    );
    assert_eq!(
        serde_json::to_string(&MigrationItem::VncServerConfigs).unwrap(),
        "\"vnc-server-configs\""
    );
}

#[test]
fn remote_desktop_server_configs_never_recommend_the_general_server_owner() {
    for (server_type, item, slug) in [
        ("rdp", MigrationItem::RdpServerConfigs, "rdp-server"),
        ("vnc", MigrationItem::VncServerConfigs, "vnc-server"),
    ] {
        let connection = database();
        connection
            .execute(
                "INSERT INTO server_configs VALUES (?1, 'opaque config: never parse or export')",
                [server_type],
            )
            .unwrap();
        connection.pragma_update(None, "query_only", true).unwrap();
        assert_eq!(owners(&connection), [(item, slug.into())]);
        assert_eq!(connection.total_changes(), 1);
        let snapshot = serde_json::to_string(&inspect_database(&connection).unwrap().1).unwrap();
        assert!(!snapshot.contains("opaque config"));
    }
}

#[test]
fn mixed_server_configs_keep_three_distinct_owners_without_loading_payloads() {
    let connection = database();
    connection
        .execute_batch(
            "INSERT INTO server_configs VALUES ('http', 'http config');
         INSERT INTO server_configs VALUES ('rdp', 'rdp config');
         INSERT INTO server_configs VALUES ('vnc', 'vnc config');
         INSERT INTO server_configs VALUES ('future-server', 'unknown retained config');",
        )
        .unwrap();
    connection.pragma_update(None, "query_only", true).unwrap();
    let expected = [
        (MigrationItem::ServerConfigs, "servers".into()),
        (MigrationItem::RdpServerConfigs, "rdp-server".into()),
        (MigrationItem::VncServerConfigs, "vnc-server".into()),
    ];
    assert_eq!(owners(&connection), expected);
    assert_eq!(owners(&connection), expected);
    assert_eq!(connection.total_changes(), 4);
}

#[test]
fn malformed_server_schema_is_reported_even_when_empty() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("CREATE TABLE server_configs (id TEXT)")
        .unwrap();
    let error = inspect_database(&connection).unwrap_err();
    assert!(error.contains("server_configs records cannot be inspected"));
    assert!(error.contains("server_type"));
}
