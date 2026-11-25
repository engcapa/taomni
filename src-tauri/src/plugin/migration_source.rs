//! Bind read-only discovery to the database and its committed WAL input.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

struct Fingerprint {
    digest: [u8; 32],
    bytes: u64,
}

impl Fingerprint {
    fn display(&self) -> String {
        format!("sha256:{}:bytes:{}", hex::encode(self.digest), self.bytes)
    }
}

fn fingerprint_reader_checked(
    mut reader: impl Read,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Fingerprint, String> {
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        check()?;
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        bytes = bytes
            .checked_add(count as u64)
            .ok_or("legacy source size overflow")?;
    }
    Ok(Fingerprint {
        digest: digest.finalize().into(),
        bytes,
    })
}

fn fingerprint_file(
    path: &Path,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Fingerprint, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "legacy database source must be a regular file: {}",
            path.display()
        ));
    }
    fingerprint_reader_checked(super::paths::open_file(path)?, check)
}

fn with_wal(main: Fingerprint, wal: Option<Fingerprint>) -> Result<Fingerprint, String> {
    // An empty WAL contains no committed records. Preserve the existing raw
    // main-file fingerprint for rollback journals and absent/empty WAL files.
    let Some(wal) = wal.filter(|wal| wal.bytes != 0) else {
        return Ok(main);
    };
    let mut digest = Sha256::new();
    digest.update(b"taomni.legacy.sqlite-with-wal.v1\0");
    digest.update(main.digest);
    digest.update(main.bytes.to_le_bytes());
    digest.update(wal.digest);
    digest.update(wal.bytes.to_le_bytes());
    Ok(Fingerprint {
        digest: digest.finalize().into(),
        bytes: main
            .bytes
            .checked_add(wal.bytes)
            .ok_or("legacy SQLite source size overflow")?,
    })
}

pub(crate) fn database_fingerprint(path: &Path) -> Result<String, String> {
    database_fingerprint_checked(path, &|| Ok(()))
}

pub(crate) fn valid_fingerprint(fingerprint: &str) -> bool {
    fingerprint
        .strip_prefix("sha256:")
        .and_then(|value| value.split_once(":bytes:"))
        .is_some_and(|(digest, size)| {
            digest.len() == 64
                && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                && size.parse::<u64>().is_ok_and(|size| size > 0)
        })
}

pub(crate) fn database_fingerprint_checked(
    path: &Path,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    check()?;
    let main = fingerprint_file(path, check)?;
    let mut wal_path = path.as_os_str().to_os_string();
    wal_path.push("-wal");
    let wal_path = PathBuf::from(wal_path);
    let wal = match fs::symlink_metadata(&wal_path) {
        Ok(_) => Some(fingerprint_file(&wal_path, check)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    // SHM is transient reader/lock bookkeeping, not a data source. In
    // particular, inspecting a WAL database must not invalidate its own hash.
    with_wal(main, wal).map(|fingerprint| fingerprint.display())
}

pub(super) fn read_snapshot<T>(
    path: &Path,
    inspect: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<(T, String), String> {
    read_snapshot_checked(path, inspect, &|| Ok(()))
}

pub(crate) fn read_snapshot_checked<T>(
    path: &Path,
    inspect: impl FnOnce(&Connection) -> Result<T, String>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(T, String), String> {
    read_bound_snapshot_checked(path, None, inspect, check)
}

pub(super) fn read_bound_snapshot_checked<T>(
    path: &Path,
    expected: Option<&str>,
    inspect: impl FnOnce(&Connection) -> Result<T, String>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(T, String), String> {
    // Validate/hash before SQLite opens either file. A second hash while the
    // read transaction is held rejects a writer or checkpoint racing discovery.
    let before = database_fingerprint_checked(path, check)?;
    if expected.is_some_and(|expected| expected != before) {
        return Err("legacy database source changed; refresh the upgrade preflight".into());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| format!("legacy database cannot be opened read-only: {error}"))?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("legacy database snapshot cannot be read: {error}"))?;
    let value = inspect(&transaction);
    if database_fingerprint_checked(path, check)? != before {
        return Err(
            "legacy database changed during upgrade inspection; retry after its writer is idle"
                .into(),
        );
    }
    value.map(|value| (value, before))
}

pub(super) fn stable_database_fingerprint(path: &Path) -> Result<String, String> {
    let before = database_fingerprint(path)?;
    if database_fingerprint(path)? != before {
        return Err(
            "legacy database changed during upgrade inspection; retry after its writer is idle"
                .into(),
        );
    }
    Ok(before)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint_reader(reader: impl Read) -> Result<Fingerprint, String> {
        fingerprint_reader_checked(reader, &|| Ok(()))
    }

    #[test]
    fn cancellation_interrupts_source_hashing_before_reading_more_bytes() {
        let checks = std::cell::Cell::new(0);
        let input = vec![0x51; 3 * 64 * 1024];
        let result = fingerprint_reader_checked(&input[..], &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                return Err("cancelled".into());
            }
            Ok(())
        });
        assert_eq!(result.err().unwrap(), "cancelled");
        assert_eq!(checks.get(), 2);
    }

    #[test]
    fn absent_and_empty_wal_keep_the_existing_main_fingerprint() {
        let raw = fingerprint_reader(&b"database bytes"[..])
            .unwrap()
            .display();
        assert_eq!(
            with_wal(fingerprint_reader(&b"database bytes"[..]).unwrap(), None)
                .unwrap()
                .display(),
            raw
        );
        assert_eq!(
            with_wal(
                fingerprint_reader(&b"database bytes"[..]).unwrap(),
                Some(fingerprint_reader(&b""[..]).unwrap())
            )
            .unwrap()
            .display(),
            raw
        );
    }

    #[test]
    fn wal_bytes_and_file_boundaries_change_the_source_fingerprint() {
        let fingerprint = |main: &[u8], wal: &[u8]| {
            with_wal(
                fingerprint_reader(main).unwrap(),
                Some(fingerprint_reader(wal).unwrap()),
            )
            .unwrap()
            .display()
        };
        assert_ne!(
            fingerprint(b"main", b"wal-A"),
            fingerprint(b"main", b"wal-B")
        );
        assert_ne!(
            fingerprint(b"main", b"wal-A"),
            fingerprint(b"mainw", b"al-A")
        );
        assert!(fingerprint(b"main", b"wal-A").ends_with(":bytes:9"));
    }
}
