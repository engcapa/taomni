//! Cache ownership for the existing desktop commands and backup adapter.
use std::path::PathBuf;

pub(crate) use taomni_mail_storage::database::{
    MailDatabase, ProcessLock, redirect_path, write_redirect,
};

pub(crate) fn mailbox_database(path: PathBuf) -> MailDatabase {
    MailDatabase::new(path, super::init_mail_tables)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::process::{Child, Command, Stdio};
    use std::{
        fs,
        path::Path,
        time::{Duration, Instant},
    };

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn child(root: &Path, mode: &str) -> ChildGuard {
        ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "mail::coordination::tests::mail_storage_child"])
                .env("TAOMNI_MAIL_PROCESS_TEST", root)
                .env("TAOMNI_MAIL_PROCESS_MODE", mode)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
    fn wait(root: &Path, child: &mut ChildGuard, name: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.join(name).exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "mail child exited early"
            );
            assert!(Instant::now() < deadline, "mail child timed out: {name}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn database(root: &Path) -> PathBuf {
        root.join(format!("{}.db", crate::state::mail_db_file_stem("qa")))
    }
    #[test]
    fn mail_storage_child() {
        let Some(root) = std::env::var_os("TAOMNI_MAIL_PROCESS_TEST") else {
            return;
        };
        let root = Path::new(&root);
        let db = mailbox_database(database(root));
        let mode = std::env::var("TAOMNI_MAIL_PROCESS_MODE").unwrap();
        let lease = if mode == "worker" {
            Some(
                ProcessLock::try_at(&database(root), "archive")
                    .unwrap()
                    .unwrap(),
            )
        } else {
            None
        };
        drop(db.lock().unwrap()); // Cache an old SQLite connection in this process.
        fs::write(root.join("ready"), b"ok").unwrap();
        std::io::stdin().read_exact(&mut [0]).unwrap();
        if mode == "relocate" {
            let connection = db.lock().unwrap();
            let raw = super::super::storage::read(&connection, "qa", "INBOX", 1)
                .unwrap()
                .unwrap();
            assert_eq!(raw, b"Subject: original\r\n\r\nbody");
            connection
                .execute(
                    "INSERT INTO mail_archive_preferences(account_id,paused) VALUES('child',1)",
                    [],
                )
                .unwrap();
            assert_eq!(
                Path::new(connection.path().unwrap())
                    .parent()
                    .unwrap()
                    .canonicalize()
                    .unwrap(),
                root.join("new").canonicalize().unwrap()
            );
        }
        drop(lease);
        fs::write(root.join("done"), b"ok").unwrap();
    }
    #[test]
    fn worker_ownership_is_per_account_and_released_after_process_crash() {
        let root = tempfile::tempdir().unwrap();
        let mut child = child(root.path(), "worker");
        wait(root.path(), &mut child, "ready");
        assert!(
            ProcessLock::try_at(&database(root.path()), "archive")
                .unwrap()
                .is_none()
        );
        // Reading and other accounts continue while this account downloads.
        drop(mailbox_database(database(root.path())).lock().unwrap());
        let _other = ProcessLock::try_at(&root.path().join("second.db"), "archive")
            .unwrap()
            .unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(
            ProcessLock::try_at(&database(root.path()), "archive")
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn another_process_follows_relocation_and_writes_only_to_the_new_database() {
        let root = tempfile::tempdir().unwrap();
        let db = mailbox_database(database(root.path()));
        {
            let conn = db.lock().unwrap();
            super::super::storage::store(
                &conn,
                "qa",
                "INBOX",
                1,
                1,
                &b"Subject: original\r\n\r\nbody"[..],
            )
            .unwrap();
        }
        let mut child = child(root.path(), "relocate");
        wait(root.path(), &mut child, "ready");
        super::super::storage::relocate(
            &mut db.lock().unwrap(),
            "qa",
            &root.path().join("new"),
            || Ok(()),
        )
        .unwrap();
        child.0.stdin.as_mut().unwrap().write_all(b"x").unwrap();
        wait(root.path(), &mut child, "done");
        assert!(child.0.wait().unwrap().success());
        let exists: bool = db
            .lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mail_archive_preferences WHERE account_id='child')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(exists);
        // An instance starting with stale session settings follows the same link.
        let fresh = mailbox_database(database(root.path()));
        let fresh_path = fresh.lock().unwrap().path().unwrap().to_string();
        let current_path = db.lock().unwrap().path().unwrap().to_string();
        assert_eq!(fresh_path, current_path);
    }
}
