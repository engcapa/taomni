//! The maintenance owner alone constructs access to its bound read-only files.
use rusqlite::{Connection, OpenFlags};
use taomni_profile_locks::VaultOperationLease;

use super::{PreparedMfaExport, source};

/// Borrowed synchronous capability. It cannot outlive the exporter, retain a
/// key, choose another profile or be reconstructed from a serialized receipt.
pub(crate) struct MfaKeySources<'a> {
    vault: Option<&'a Connection>,
    database: Option<&'a Connection>,
    lease: &'a VaultOperationLease,
    check: &'a dyn Fn() -> Result<(), String>,
}

impl MfaKeySources<'_> {
    pub(crate) fn vault(&self) -> Option<&Connection> {
        self.vault
    }

    pub(crate) fn database(&self) -> Option<&Connection> {
        self.database
    }

    pub(crate) fn is_exclusive(&self) -> bool {
        self.lease.is_exclusive()
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        (self.check)()
    }
}

impl PreparedMfaExport {
    pub(crate) fn with_key_sources<T>(
        &self,
        verify: impl FnOnce(MfaKeySources<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        self.verify()?;
        let check = || self.check();
        let database = self
            .database_path()
            .map(|path| {
                Connection::open_with_flags(
                    path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
                )
                .map_err(|error| format!("MFA export cannot be opened read-only: {error}"))
            })
            .transpose()?;
        let run = |vault: Option<&Connection>| {
            verify(MfaKeySources {
                vault,
                database: database.as_ref(),
                lease: &self.maintenance.vault,
                check: &check,
            })
        };
        let result = if let Some(expected) = self.sources.fingerprints.get("vault.db") {
            source::read_bound_snapshot_checked(
                &self.maintenance.profile().path().join("vault.db"),
                Some(expected),
                |vault| run(Some(vault)),
                &check,
            )
            .map(|(result, _)| result)
        } else {
            run(None)
        };
        // Recheck on errors too: a successful password probe or a failure is
        // never allowed to bless concurrently changed source/staging bytes.
        self.verify()?;
        result
    }
}
