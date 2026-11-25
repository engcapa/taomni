use super::*;
use std::{
    cell::Cell,
    panic::{AssertUnwindSafe, catch_unwind},
};
use taomni_mfa_engine::{keys::KeyProvider, models::*, operations, store};
use zeroize::Zeroizing;

struct Keys;
impl KeyProvider for Keys {
    fn load(&self) -> Result<Option<taomni_mfa_engine::crypto::DataKey>, String> {
        Ok(Some(Zeroizing::new([37; 32])))
    }
    fn initialize_empty(&self) -> Result<taomni_mfa_engine::crypto::DataKey, String> {
        unreachable!()
    }
    fn repair_after_reset(&self) -> Result<taomni_mfa_engine::crypto::DataKey, String> {
        unreachable!()
    }
}

fn connection() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    store::init_db(&conn).unwrap();
    conn
}
fn input(issuer: &str) -> MfaAccountInput {
    let secret = if matches!(issuer, "RFC" | "original" | "existing") {
        "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into()
    } else {
        taomni_mfa_engine::otp::encode_base32(format!("unique-test-secret-{issuer}").as_bytes())
    };
    serde_json::from_value(
        serde_json::json!({"issuer":issuer,"accountName":"qa@example.com", "kind":"hotp",
        "secret":secret}),
    )
    .unwrap()
}
fn add(conn: &mut Connection, issuer: &str) -> String {
    let key = taomni_mfa_engine::keys::ensure_key(conn, &Keys).unwrap();
    operations::add(conn, &key, &[input(issuer)], false)
        .unwrap()
        .added[0]
        .id
        .clone()
}

#[test]
fn actor_commits_nested_import_order_and_preferences_as_one_operation() {
    let mut conn = connection();
    let id = transaction(
        &mut conn,
        || Ok(()),
        |conn| {
            let id = add(conn, "RFC");
            operations::set_prefs(
                conn,
                &MfaPrefs {
                    sort_mode: "issuer".into(),
                    group_filter: "retained".into(),
                },
            )
            .map_err(super::super::business_error)?;
            operations::reorder(conn, std::slice::from_ref(&id))
                .map_err(super::super::business_error)?;
            Ok(id)
        },
    )
    .unwrap();
    let data = operations::list(&conn).unwrap();
    assert_eq!(data.accounts[0].id, id);
    assert_eq!(data.prefs.group_filter, "retained");
    assert!(conn.is_autocommit());
}

#[test]
fn cancellation_before_outer_commit_rolls_back_hotp_preferences_and_import() {
    let mut conn = connection();
    let id = add(&mut conn, "original");
    let checks = Cell::new(0);
    let cancelled = || {
        checks.set(checks.get() + 1);
        if checks.get() == 2 {
            Err(taomni_plugin_api::services::CoreServiceError::Cancelled.into_rpc_error())
        } else {
            Ok(())
        }
    };
    let result = transaction(&mut conn, cancelled, |conn| {
        let key = Keys.load().unwrap().unwrap();
        operations::hotp_next(conn, &key, &id).unwrap();
        operations::set_prefs(
            conn,
            &MfaPrefs {
                sort_mode: "issuer".into(),
                group_filter: "must roll back".into(),
            },
        )
        .unwrap();
        add(conn, "temporary");
        Ok(())
    });
    assert_eq!(result.unwrap_err().code, -32006);
    let snapshot = operations::list(&conn).unwrap();
    assert_eq!(snapshot.accounts.len(), 1);
    assert_eq!(snapshot.accounts[0].counter, 0);
    assert_eq!(snapshot.prefs, MfaPrefs::default());
    assert_eq!(
        operations::codes(&conn, &Keys.load().unwrap().unwrap(), None, 0).unwrap()[0].code,
        "755224"
    );
    assert!(conn.is_autocommit());
}

#[test]
fn engine_error_and_unwind_preserve_preexisting_accounts_and_clear_transaction() {
    let mut conn = connection();
    let id = add(&mut conn, "existing");
    assert!(
        transaction(
            &mut conn,
            || Ok(()),
            |conn| {
                store::delete_account(conn, &id).unwrap();
                add(conn, "will roll back");
                Err::<(), _>(super::super::business_error("test failure"))
            }
        )
        .is_err()
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| {
            let _ = transaction(
                &mut conn,
                || Ok(()),
                |conn| -> Result<(), RpcError> {
                    store::reset(conn).unwrap();
                    panic!("controlled actor panic after write")
                },
            );
        }))
        .is_err()
    );
    assert_eq!(store::list_accounts(&conn).unwrap()[0].id, id);
    assert!(conn.is_autocommit());
    transaction(
        &mut conn,
        || Ok(()),
        |conn| {
            add(conn, "next command");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(store::count_accounts(&conn).unwrap(), 2);
}

#[test]
fn failed_import_savepoint_rolls_back_the_whole_batch_inside_the_actor() {
    let mut conn = connection();
    let key = Keys.load().unwrap().unwrap();
    add(&mut conn, "existing");
    assert!(
        transaction(
            &mut conn,
            || Ok(()),
            |conn| {
                operations::add(conn, &key, &[input("new"), input("existing")], false)
                    .map_err(super::super::business_error)
            }
        )
        .is_err()
    );
    assert_eq!(store::count_accounts(&conn).unwrap(), 1);
    assert!(conn.is_autocommit());
}

#[test]
fn startup_refuses_a_future_schema_without_downgrading_or_creating_mfa_tables() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mfa.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA user_version=999; CREATE TABLE future_state(value); INSERT INTO future_state VALUES ('keep');").unwrap();
    db.close().unwrap();
    assert!(open_database(&path, false).is_err());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        999
    );
    assert_eq!(
        db.query_row("SELECT value FROM future_state", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='mfa_accounts'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    db.close().unwrap();
}
