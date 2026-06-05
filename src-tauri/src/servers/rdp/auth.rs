//! Credential policy for the RDP server.
//!
//! Like [`crate::servers::ssh`], this validates against credentials in the
//! server config, NOT system accounts. IronRDP's NLA/CredSSP path checks the
//! presented username/password against the [`Credentials`] we hand it via
//! `set_credentials`; TLS-only mode performs no server-side credential check of
//! its own, so we still require credentials to be configured (refusing a
//! wide-open desktop, mirroring the SSH leaf's stance).

use ironrdp::server::Credentials;

/// Validated, non-empty credentials for the RDP server.
pub(crate) struct AuthConfig {
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
}

impl AuthConfig {
    /// Build from raw config fields, enforcing the "must have credentials" rule.
    /// Returns `Err` with a user-facing message when username or password is
    /// missing, so the leaf can surface it as a startup error.
    pub(crate) fn from_fields(
        username: &str,
        password: &str,
        domain: &str,
    ) -> Result<Self, String> {
        let username = username.trim();
        if username.is_empty() || password.is_empty() {
            return Err(
                "RDP server needs a username and password — set them in the server config. \
                 Starting without credentials would share this desktop with anyone who can \
                 reach the port."
                    .to_string(),
            );
        }
        let domain = domain.trim();
        Ok(Self {
            username: username.to_string(),
            password: password.to_string(),
            domain: if domain.is_empty() {
                None
            } else {
                Some(domain.to_string())
            },
        })
    }

    /// Convert into the IronRDP credentials passed to `RdpServer::set_credentials`.
    pub(crate) fn to_credentials(&self) -> Credentials {
        Credentials {
            username: self.username.clone(),
            password: self.password.clone(),
            domain: self.domain.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_credentials() {
        assert!(AuthConfig::from_fields("", "pw", "").is_err());
        assert!(AuthConfig::from_fields("user", "", "").is_err());
        assert!(AuthConfig::from_fields("   ", "pw", "").is_err());
    }

    #[test]
    fn accepts_full_credentials_and_normalizes_domain() {
        let a = AuthConfig::from_fields(" user ", "pw", "").unwrap();
        assert_eq!(a.username, "user");
        assert!(a.domain.is_none());
        let b = AuthConfig::from_fields("user", "pw", "CORP").unwrap();
        assert_eq!(b.domain.as_deref(), Some("CORP"));
        let creds = b.to_credentials();
        assert_eq!(creds.username, "user");
        assert_eq!(creds.domain.as_deref(), Some("CORP"));
    }
}
