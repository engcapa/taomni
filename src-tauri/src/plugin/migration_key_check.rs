//! Compose the bound export owner with the core's load-only Vault service.
use super::migration::export::PreparedMfaExport;
use crate::vault::migration_check::{self, MfaMigrationKeyCheck};

impl PreparedMfaExport {
    /// No install, activation or journal commit follows from this observation.
    /// The future coordinator retains this owner and rechecks before commit.
    pub(crate) fn verify_key(&self, password: &str) -> Result<MfaMigrationKeyCheck, String> {
        self.with_key_sources(|sources| migration_check::verify(sources, password))
    }
}
