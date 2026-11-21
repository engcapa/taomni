//! TLS policy shared by IMAP, POP3 and SMTP.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use native_tls::{Certificate, TlsConnector};
pub use taomni_mail_api::MailConnectionSecurity;

fn trusted_der(trusted: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    let Some(value) = trusted.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    BASE64
        .decode(value)
        .map(Some)
        .map_err(|e| format!("trusted certificate is not valid base64: {e}"))
}

/// Native-TLS connector for a mail server, pinned when a trusted cert is set.
pub fn tls_connector(trusted: Option<&str>) -> Result<TlsConnector, String> {
    let mut builder = TlsConnector::builder();
    if let Some(der) = trusted_der(trusted)? {
        let cert = Certificate::from_der(&der)
            .map_err(|e| format!("trusted certificate is not a valid X.509 DER: {e}"))?;
        builder
            .disable_built_in_roots(true)
            .add_root_certificate(cert)
            .danger_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| format!("failed to build TLS connector: {e}"))
}

/// lettre TLS parameters with the same pinning rules.
pub(super) fn smtp_tls_parameters(
    host: &str,
    trusted: Option<&str>,
) -> Result<lettre::transport::smtp::client::TlsParameters, String> {
    use lettre::transport::smtp::client::{CertificateStore, TlsParameters};
    let mut builder = TlsParameters::builder(host.to_string());
    if let Some(der) = trusted_der(trusted)? {
        let cert = lettre::transport::smtp::client::Certificate::from_der(der)
            .map_err(|e| format!("trusted certificate is not a valid X.509 DER: {e}"))?;
        builder = builder
            .certificate_store(CertificateStore::None)
            .add_root_certificate(cert)
            .dangerous_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| format!("SMTP TLS parameters failed: {e}"))
}

/// Hint appended to handshake errors so the UI can offer the review dialog.
pub fn certificate_error_hint(error: &str, pinned: bool) -> String {
    let lower = error.to_ascii_lowercase();
    let cert_problem = [
        "certificate",
        "self signed",
        "self-signed",
        "untrusted",
        "unknown ca",
        "issuer",
        "0x800b0109",
        "cert_",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if !cert_problem {
        return error.to_string();
    }
    if pinned {
        format!(
            "{error} (the server certificate no longer matches the one you trusted; review it again)"
        )
    } else {
        format!("{error} (untrusted server certificate; review it to add an exception)")
    }
}
