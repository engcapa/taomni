//! Verification primitives shared by the module downloader and installer.
//!
//! Signatures are checked against the public key embedded in the core. Only
//! this module can construct the trusted catalogue and package capabilities
//! accepted by the production installer.

mod archive;
mod catalog;
mod installed;
mod package;
pub(crate) use package::installed_proof_paths;
mod signature;

pub use catalog::VerifiedCatalog;
pub use installed::InstalledTrust;
pub use package::{VerifiedPackage, host_platform, verify_installed};

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

use std::cmp::Ordering;

use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TrustError {
    #[error("module signature verification failed: {0}")]
    Signature(String),
    #[error("module catalogue verification failed: {0}")]
    Catalog(String),
    #[error("module package verification failed: {0}")]
    Package(String),
    #[error("module trust I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("module trust JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Metadata(#[from] VerifyError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedComment<'a> {
    pub id: &'a str,
    pub version: &'a str,
    pub platform: &'a str,
    pub core_api_version: &'a str,
    pub sha256: &'a str,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum VerifyError {
    #[error("SHA-256 must be a 64-character hexadecimal digest")]
    InvalidSha256,
    #[error("SHA-256 mismatch: expected {expected}, got {actual}")]
    Sha256Mismatch { expected: String, actual: String },
    #[error(
        "module manifest sequence {incoming} is older than the highest seen sequence {previous}"
    )]
    SequenceRollback { previous: u64, incoming: u64 },
    #[error("invalid module version: {0}")]
    InvalidVersion(String),
    #[error("module version {candidate} is older than installed version {installed}")]
    VersionDowngrade {
        installed: String,
        candidate: String,
    },
    #[error("trusted comment is missing {0}")]
    MissingTrustedField(String),
    #[error("trusted comment field {field} does not match the expected value")]
    TrustedFieldMismatch { field: String },
    #[error("trusted comment field is repeated or malformed: {0}")]
    InvalidTrustedField(String),
}

/// Return a lower-case SHA-256 digest without touching the filesystem.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), VerifyError> {
    if !is_sha256(expected) {
        return Err(VerifyError::InvalidSha256);
    }
    let actual = sha256_hex(bytes);
    if actual != expected.to_ascii_lowercase() {
        return Err(VerifyError::Sha256Mismatch {
            expected: expected.to_ascii_lowercase(),
            actual,
        });
    }
    Ok(())
}

pub fn validate_sequence(previous: Option<u64>, incoming: u64) -> Result<(), VerifyError> {
    if let Some(previous) = previous {
        if incoming < previous {
            return Err(VerifyError::SequenceRollback { previous, incoming });
        }
    }
    Ok(())
}

/// Compare two SemVer values. Build metadata is intentionally ignored for
/// ordering, as required by SemVer precedence.
pub fn compare_versions(left: &str, right: &str) -> Result<Ordering, VerifyError> {
    Ok(parse_version(left)?.cmp(&parse_version(right)?))
}

/// Reject a downgrade unless the caller explicitly initiated a rollback.
pub fn validate_candidate_version(
    installed: Option<&str>,
    candidate: &str,
    allow_rollback: bool,
) -> Result<(), VerifyError> {
    parse_version(candidate)?;
    if let Some(installed) = installed {
        parse_version(installed)?;
        if !allow_rollback && compare_versions(candidate, installed)? == Ordering::Less {
            return Err(VerifyError::VersionDowngrade {
                installed: installed.to_owned(),
                candidate: candidate.to_owned(),
            });
        }
    }
    Ok(())
}

/// Check that a minisign trusted comment binds a package to the catalogue
/// entry that selected it.  The signature bytes themselves are verified by the
/// platform minisign adapter; this function validates the signed metadata.
pub fn verify_trusted_comment(
    comment: &str,
    expected: &TrustedComment<'_>,
) -> Result<(), VerifyError> {
    let fields = trusted_fields(comment)?;
    for (name, value) in [
        ("id", expected.id),
        ("version", expected.version),
        ("platform", expected.platform),
        ("coreApiVersion", expected.core_api_version),
        ("sha256", expected.sha256),
    ] {
        let Some(actual) = fields.get(name).copied() else {
            return Err(VerifyError::MissingTrustedField(name.to_owned()));
        };
        if actual != value {
            return Err(VerifyError::TrustedFieldMismatch {
                field: name.to_owned(),
            });
        }
    }
    Ok(())
}

fn trusted_fields(comment: &str) -> Result<std::collections::BTreeMap<&str, &str>, VerifyError> {
    let mut fields = std::collections::BTreeMap::new();
    for part in comment.split_whitespace() {
        let (key, value) = part
            .split_once('=')
            .filter(|(key, value)| !key.is_empty() && !value.is_empty())
            .ok_or_else(|| VerifyError::InvalidTrustedField(part.to_owned()))?;
        if fields.insert(key, value).is_some() {
            return Err(VerifyError::InvalidTrustedField(key.to_owned()));
        }
    }
    Ok(fields)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ParsedVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<Identifier>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Identifier {
    Numeric(u64),
    Text(String),
}

impl Ord for Identifier {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Numeric(left), Self::Numeric(right)) => left.cmp(right),
            (Self::Numeric(_), Self::Text(_)) => Ordering::Less,
            (Self::Text(_), Self::Numeric(_)) => Ordering::Greater,
            (Self::Text(left), Self::Text(right)) => left.cmp(right),
        }
    }
}

impl PartialOrd for Identifier {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl ParsedVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
            // A stable release has higher precedence than any prerelease.
            .then_with(
                || match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
                    (true, true) => Ordering::Equal,
                    (true, false) => Ordering::Greater,
                    (false, true) => Ordering::Less,
                    (false, false) => self.prerelease.cmp(&other.prerelease),
                },
            )
    }
}

fn parse_version(value: &str) -> Result<ParsedVersion, VerifyError> {
    let without_build = if let Some((without_build, build)) = value.split_once('+') {
        if build.is_empty()
            || build.split('.').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err(VerifyError::InvalidVersion(value.to_owned()));
        }
        without_build
    } else {
        value
    };
    let (core, prerelease) = without_build.split_once('-').unwrap_or((without_build, ""));
    if without_build.ends_with('-') {
        return Err(VerifyError::InvalidVersion(value.to_owned()));
    }
    let numbers = core.split('.').collect::<Vec<_>>();
    if numbers.len() != 3 || numbers.iter().any(|part| !valid_numeric_part(part)) {
        return Err(VerifyError::InvalidVersion(value.to_owned()));
    }
    let prerelease = if prerelease.is_empty() {
        Vec::new()
    } else {
        prerelease
            .split('.')
            .map(|part| {
                if part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                {
                    return Err(VerifyError::InvalidVersion(value.to_owned()));
                }
                if part.bytes().all(|byte| byte.is_ascii_digit()) {
                    if part.len() > 1 && part.starts_with('0') {
                        return Err(VerifyError::InvalidVersion(value.to_owned()));
                    }
                    Ok(Identifier::Numeric(part.parse().map_err(|_| {
                        VerifyError::InvalidVersion(value.to_owned())
                    })?))
                } else {
                    Ok(Identifier::Text(part.to_owned()))
                }
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let major = numbers[0]
        .parse()
        .map_err(|_| VerifyError::InvalidVersion(value.to_owned()))?;
    let minor = numbers[1]
        .parse()
        .map_err(|_| VerifyError::InvalidVersion(value.to_owned()))?;
    let patch = numbers[2]
        .parse()
        .map_err(|_| VerifyError::InvalidVersion(value.to_owned()))?;
    Ok(ParsedVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn valid_numeric_part(value: &str) -> bool {
    !value.is_empty()
        && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod primitive_tests {
    use super::*;

    #[test]
    fn verifies_digest_and_rejects_tampering() {
        let expected = sha256_hex(b"module");
        assert!(verify_sha256(b"module", &expected).is_ok());
        assert!(matches!(
            verify_sha256(b"tampered", &expected),
            Err(VerifyError::Sha256Mismatch { .. })
        ));
        assert_eq!(
            sha256_hex(b"module"),
            "120970d812836f19888625587a4606a5ad23cef31c8684e601771552548fc6b9"
        );
    }

    #[test]
    fn sequence_is_monotonic_and_equal_is_idempotent() {
        assert!(validate_sequence(None, 1).is_ok());
        assert!(validate_sequence(Some(42), 42).is_ok());
        assert!(matches!(
            validate_sequence(Some(42), 41),
            Err(VerifyError::SequenceRollback { .. })
        ));
    }

    #[test]
    fn semver_rejects_downgrade_and_orders_prereleases() {
        assert_eq!(
            compare_versions("1.0.0", "1.0.0-rc.1").unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.0.0-rc.2", "1.0.0-rc.10").unwrap(),
            Ordering::Less
        );
        assert!(validate_candidate_version(Some("1.2.0"), "1.1.9", false).is_err());
        assert!(validate_candidate_version(Some("1.2.0"), "1.1.9", true).is_ok());
    }

    #[test]
    fn trusted_comment_binds_all_catalogue_fields() {
        let digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let expected = TrustedComment {
            id: "taomni-plugin-mfa",
            version: "1.2.3",
            platform: "linux-x86_64",
            core_api_version: "1",
            sha256: digest,
        };
        let comment =
            "id=taomni-plugin-mfa version=1.2.3 platform=linux-x86_64 coreApiVersion=1 sha256="
                .to_owned()
                + expected.sha256;
        assert!(verify_trusted_comment(&comment, &expected).is_ok());
        assert!(
            verify_trusted_comment(
                &comment.replace("platform=linux-x86_64", "platform=windows-x86_64"),
                &expected
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_overflow_and_invalid_semver_components() {
        assert!(matches!(
            compare_versions("18446744073709551616.0.0", "1.0.0"),
            Err(VerifyError::InvalidVersion(_))
        ));
        for value in [
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.3-01",
            "1.2.3-",
            "1.2.3+",
            "1.2.3+build data",
            "1.2.3+build+other",
        ] {
            assert!(
                matches!(
                    compare_versions(value, "1.0.0"),
                    Err(VerifyError::InvalidVersion(_))
                ),
                "{value} should not parse as SemVer"
            );
        }
    }

    #[test]
    fn trusted_comment_requires_every_bound_field() {
        let expected = TrustedComment {
            id: "plugin-mfa",
            version: "1.0.0",
            platform: "linux-x86_64",
            core_api_version: "1",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        };
        let missing = "id=plugin-mfa version=1.0.0 platform=linux-x86_64 coreApiVersion=1";
        assert!(matches!(
            verify_trusted_comment(missing, &expected),
            Err(VerifyError::MissingTrustedField(field)) if field == "sha256"
        ));
        let wrong = "id=plugin-mfa version=1.0.0 platform=linux-x86_64 coreApiVersion=2 sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert!(matches!(
            verify_trusted_comment(wrong, &expected),
            Err(VerifyError::TrustedFieldMismatch { field }) if field == "coreApiVersion"
        ));
    }
}
