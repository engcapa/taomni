use super::*;
use crate::session::models::{AuthMethod, SessionType};

fn config(id: &str) -> SessionConfig {
    SessionConfig {
        id: id.into(),
        name: "Fresh Mail".into(),
        session_type: SessionType::Mail,
        group_path: None,
        host: "mail.example.test".into(),
        port: 993,
        username: Some("mail@example.test".into()),
        auth_method: AuthMethod::Password,
        options_json: "{}".into(),
        created_at: 1,
        updated_at: 1,
        last_connected_at: None,
        sort_order: 0,
    }
}

#[test]
fn failed_initialization_does_not_save_settings_and_same_id_can_retry() {
    let mut db = Connection::open_in_memory().unwrap();
    db::init_db(&db).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("mail-cache");
    let account = config("retry");
    assert!(
        save_session(&mut db, &account, &root, &root, false, || Err(
            "interrupted".into()
        ))
        .is_err()
    );
    assert!(
        db::get_session(&db, &account.id)
            .optional()
            .unwrap()
            .is_none()
    );
    assert!(save_session(&mut db, &account, &root, &root, false, || Ok(true)).unwrap());
    assert_eq!(db::get_session(&db, &account.id).unwrap().id, "retry");
}

#[test]
fn an_existing_session_can_keep_its_legacy_store_and_an_owned_account_can_save_again() {
    let mut db = Connection::open_in_memory().unwrap();
    db::init_db(&db).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("mail-cache");
    let mut account = config("existing");
    db::save_session(&db, &account).unwrap();
    account.name = "Renamed".into();
    assert!(
        !save_session(&mut db, &account, &root, &root, false, || panic!(
            "legacy ownership must stay"
        ))
        .unwrap()
    );
    assert!(
        save_session(&mut db, &account, &root, &root, true, || panic!(
            "owned database is reused"
        ))
        .unwrap()
    );
    assert_eq!(db::get_session(&db, &account.id).unwrap().name, "Renamed");
    assert!(
        save_session(
            &mut db,
            &account,
            &root.join("outside"),
            &root,
            true,
            || Ok(true)
        )
        .is_err()
    );
}

#[test]
fn transient_or_legacy_artifacts_prevent_adoption_even_without_the_database() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    assert!(!legacy_files_exist(root, "account").unwrap());
    let old = root.join("account.db");
    let redirect = redirect_path(&old);
    fs::write(&redirect, "legacy").unwrap();
    assert!(legacy_files_exist(root, "account").unwrap());
    fs::remove_file(redirect).unwrap();
    fs::write(root.join("account.db-wal"), "incomplete copy").unwrap();
    assert!(legacy_files_exist(root, "account").unwrap());
}
