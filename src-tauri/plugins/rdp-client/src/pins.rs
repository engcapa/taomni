//! The signed RDP host owns its certificate decisions and SQLite snapshot.

use std::{
    fs, io,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{Operation, SnapshotExport, SnapshotProvider};
use taomni_rdp_client_api::{
    CertificateTrust, PINS_SCHEMA, RdpOptions, certificate_endpoint, normalize_fingerprint,
};

pub(super) struct Pins(Mutex<Connection>);

impl Pins {
    /// The SDK factory calls this after acquiring the profile and writer leases.
    pub(super) fn open(profile: &Path) -> io::Result<Self> {
        let mut data = profile.to_owned();
        for segment in ["plugins", "rdp-client", "data"] {
            data.push(segment);
            if let Err(error) = fs::create_dir(&data)
                && error.kind() != io::ErrorKind::AlreadyExists
            {
                return Err(error);
            }
            let meta = fs::symlink_metadata(&data)?;
            if !meta.is_dir() || linked(&meta) {
                return Err(invalid_storage());
            }
        }
        let mut exists = false;
        for name in ["data.db", "data.db-wal", "data.db-shm", "data.db-journal"] {
            match fs::symlink_metadata(data.join(name)) {
                Ok(meta) if !ordinary_file(&meta) => return Err(invalid_storage()),
                Ok(_) if name == "data.db" => exists = true,
                Ok(_) if !exists => return Err(invalid_storage()),
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let db =
            Connection::open_with_flags(data.join("data.db"), flags).map_err(io::Error::other)?;
        db.busy_timeout(Duration::from_secs(2))
            .map_err(io::Error::other)?;
        db.pragma_update(None, "trusted_schema", false)
            .map_err(io::Error::other)?;
        db.execute_batch(PINS_SCHEMA).map_err(io::Error::other)?;
        Ok(Self(Mutex::new(db)))
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>, RpcError> {
        self.0.lock().map_err(unavailable)
    }

    pub(super) fn trust(
        &self,
        request: CertificateTrust,
        check: &dyn Fn() -> Result<(), RpcError>,
    ) -> Result<Result<String, String>, RpcError> {
        let endpoint = certificate_endpoint(&request.host, request.port);
        if request.host.trim().is_empty() || request.port == 0 {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        }
        let fingerprint = match normalize_fingerprint(&request.fingerprint) {
            Ok(value) => value,
            Err(error) => return Ok(Err(error)),
        };
        let updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        let mut db = self.db()?;
        let transaction = db.transaction().map_err(unavailable)?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO rdp_certificate_pins VALUES (?1, ?2, ?3)",
                rusqlite::params![endpoint, fingerprint, updated_at],
            )
            .map_err(unavailable)?;
        check()?;
        transaction.commit().map_err(unavailable)?;
        Ok(Ok(fingerprint))
    }

    pub(super) fn apply(
        &self,
        host: &str,
        port: u16,
        options: &mut RdpOptions,
    ) -> Result<(), RpcError> {
        let db = self.db()?;
        let load = |host, port| {
            db.query_row(
                "SELECT fingerprint FROM rdp_certificate_pins WHERE endpoint = ?1",
                [certificate_endpoint(host, port)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(unavailable)
        };
        if let Some(pin) = load(host, port)? {
            options.certificate_fingerprint = Some(pin);
        }
        if let Some(gateway) = options.gateway.as_mut()
            && let Some(pin) = load(&gateway.host, gateway.port)?
        {
            gateway.certificate_fingerprint = Some(pin);
        }
        Ok(())
    }
}

impl SnapshotProvider for Pins {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()
    }

    fn export(
        &self,
        destination: &mut SnapshotExport,
        operation: &Operation,
    ) -> Result<(), RpcError> {
        operation.check_current()?;
        let db = self.db()?;
        destination.sqlite("data.db", &db)
    }

    fn resume(&self) {}
}

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

fn ordinary_file(meta: &fs::Metadata) -> bool {
    if !meta.is_file() || linked(meta) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.nlink() == 1
    }
    #[cfg(not(unix))]
    true
}

fn invalid_storage() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "RDP certificate storage path is invalid",
    )
}

fn unavailable(_: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, "RDP_CERTIFICATE_STORE_UNAVAILABLE")
}

#[cfg(test)]
mod tests {
    use super::*;
    use taomni_rdp_client_api::GatewayOpt;

    #[test]
    fn committed_pins_apply_to_the_exact_target_and_gateway_endpoints() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(PINS_SCHEMA).unwrap();
        let pins = Pins(Mutex::new(db));
        let trust = |host: &str, port, hex: &str| CertificateTrust {
            host: host.to_owned(),
            port,
            fingerprint: hex.repeat(32),
        };
        pins.trust(trust("desktop.EXAMPLE.", 3389, "AB"), &|| Ok(()))
            .unwrap()
            .unwrap();
        pins.trust(trust("gateway.example", 443, "CD"), &|| Ok(()))
            .unwrap()
            .unwrap();
        assert!(
            pins.trust(trust("desktop.example", 3389, "EF"), &|| {
                Err(RpcError::from_code(ErrorCode::RequestCancelled))
            })
            .is_err()
        );

        let mut options = RdpOptions {
            gateway: Some(GatewayOpt {
                host: "gateway.example".into(),
                port: 443,
                username: "qa".into(),
                password: None,
                auth: "basic".into(),
                use_session_creds: false,
                certificate_fingerprint: None,
            }),
            ..RdpOptions::default()
        };
        pins.apply("desktop.example", 3390, &mut options).unwrap();
        assert_eq!(options.certificate_fingerprint, None);
        pins.apply("desktop.example", 3389, &mut options).unwrap();
        assert_eq!(options.certificate_fingerprint, Some("ab".repeat(32)));
        assert_eq!(
            options.gateway.unwrap().certificate_fingerprint,
            Some("cd".repeat(32))
        );
    }
}
