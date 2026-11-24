pub use taomni_mail_storage::tls::*;

/// lettre TLS parameters with the same pinning rules.
#[cfg(any(feature = "legacy-smtp", feature = "routed-smtp"))]
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
