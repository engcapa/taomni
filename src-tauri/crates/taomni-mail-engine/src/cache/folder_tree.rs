//! Cache updates for IMAP folder listing, subscriptions and mutations.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, Result as SqlResult, params};

use crate::MailFolder;

use super::{list_cached_folders, purge_cached_folder, upsert_folder};

pub fn sync_folder_tree(
    conn: &Connection,
    account_id: &str,
    listed: &[MailFolder],
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    for folder in listed {
        upsert_folder(&tx, folder)?;
    }
    let names: HashSet<&str> = listed.iter().map(|folder| folder.name.as_str()).collect();
    for folder in list_cached_folders(&tx, account_id)? {
        if !names.contains(folder.name.as_str()) {
            tx.execute(
                "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
                params![account_id, folder.name],
            )?;
            tx.execute(
                "DELETE FROM mail_folders WHERE account_id = ?1 AND name = ?2",
                params![account_id, folder.name],
            )?;
        }
    }
    tx.commit()
}

pub fn refresh_subscription_flags(
    conn: &Connection,
    account_id: &str,
    listed: &[MailFolder],
) -> SqlResult<Vec<MailFolder>> {
    let tx = conn.unchecked_transaction()?;
    let flags: HashMap<&str, &[String]> = listed
        .iter()
        .map(|folder| (folder.name.as_str(), folder.flags.as_slice()))
        .collect();
    for mut folder in list_cached_folders(&tx, account_id)? {
        if let Some(remote) = flags.get(folder.name.as_str()) {
            folder.flags = remote.to_vec();
            upsert_folder(&tx, &folder)?;
        }
    }
    let folders = list_cached_folders(&tx, account_id)?;
    tx.commit()?;
    Ok(folders)
}

pub fn apply_folder_change(
    conn: &Connection,
    account_id: &str,
    previous: Option<&str>,
    folders: &[MailFolder],
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    if let Some(previous) = previous {
        purge_cached_folder(&tx, account_id, previous)?;
    }
    for folder in folders {
        upsert_folder(&tx, folder)?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str, flags: &[&str]) -> MailFolder {
        MailFolder {
            account_id: "account".into(),
            name: name.into(),
            uid_next: Some(15),
            flags: flags.iter().map(|flag| flag.to_string()).collect(),
            ..MailFolder::default()
        }
    }

    #[test]
    fn subscription_refresh_rolls_back_a_partial_folder_change() {
        let db = Connection::open_in_memory().unwrap();
        super::super::init_mail_tables(&db).unwrap();
        let original = [folder("A", &[]), folder("Z", &[])];
        let remote = [folder("A", &["Subscribed"]), folder("Z", &["Subscribed"])];
        sync_folder_tree(&db, "account", &original).unwrap();
        db.execute_batch(
            "CREATE TEMP TRIGGER drop_subscription BEFORE UPDATE ON mail_folders
             WHEN NEW.name = 'Z' BEGIN SELECT RAISE(FAIL, 'subscription update interrupted'); END",
        )
        .unwrap();

        assert!(refresh_subscription_flags(&db, "account", &remote).is_err());
        let rows = list_cached_folders(&db, "account").unwrap();
        assert!(rows.iter().all(|folder| folder.flags.is_empty()));
        db.execute_batch("DROP TRIGGER drop_subscription").unwrap();
        let updated = refresh_subscription_flags(&db, "account", &remote).unwrap();
        assert_eq!(updated.len(), 2);
        assert!(updated.iter().all(|folder| folder.flags == ["Subscribed"]));
        assert!(updated.iter().all(|folder| folder.uid_next == Some(15)));
    }
}
