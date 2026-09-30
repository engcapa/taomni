//! Per-account certificate exceptions (TASK-14, AC-44).
//!
//! A user can trust a server's self-signed certificate after reviewing its
//! SHA-256 fingerprint. The trusted certificate (DER, base64) is then the
//! *only* trust anchor for that server: built-in roots are disabled, so any
//! other certificate — including a changed one — fails the handshake and the
//! user is asked again. Host-name checks are relaxed only in that pinned
//! mode, because the pinned certificate itself identifies the server.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use native_tls::{Certificate, TlsConnector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use super::{
    MailAccountConfig, MailConnectionSecurity, mail_effective_endpoint, resolve_config, tcp_connect,
};
use crate::state::AppState;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

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
pub(super) fn tls_connector(trusted: Option<&str>) -> Result<TlsConnector, String> {
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
pub(super) fn certificate_error_hint(error: &str, pinned: bool) -> String {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailCertificateInfo {
    pub host: String,
    pub port: u16,
    /// Uppercase hex with colons, like Thunderbird's certificate viewer.
    pub sha256: String,
    pub subject: String,
    pub issuer: String,
    pub not_before: String,
    pub not_after: String,
    /// Base64 DER, stored as the account's trusted certificate.
    pub der_base64: String,
    /// The certificate passes normal system verification for this host.
    pub trusted_by_system: bool,
    /// System verification failure, when not trusted.
    pub verify_error: Option<String>,
}

pub(super) fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

pub(super) fn describe_certificate(host: &str, port: u16, der: &[u8]) -> MailCertificateInfo {
    use x509_cert::der::Decode;
    let parsed = x509_cert::Certificate::from_der(der).ok();
    let (subject, issuer, not_before, not_after) = parsed
        .map(|cert| {
            let tbs = &cert.tbs_certificate;
            (
                tbs.subject.to_string(),
                tbs.issuer.to_string(),
                tbs.validity.not_before.to_string(),
                tbs.validity.not_after.to_string(),
            )
        })
        .unwrap_or_default();
    MailCertificateInfo {
        host: host.to_string(),
        port,
        sha256: fingerprint(der),
        subject,
        issuer,
        not_before,
        not_after,
        der_base64: BASE64.encode(der),
        trusted_by_system: false,
        verify_error: None,
    }
}

fn read_line<R: BufRead>(reader: &mut R) -> Result<String, String> {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("read failed: {e}"))?;
    if line.is_empty() {
        return Err("server closed the connection".into());
    }
    Ok(line)
}

/// Run the plaintext STARTTLS preamble for `protocol` on `stream`.
fn starttls_preamble(stream: &mut TcpStream, protocol: &str) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    if protocol == "smtp" {
        // 220 greeting (possibly multi-line), EHLO, STARTTLS.
        loop {
            let line = read_line(&mut reader)?;
            if line.len() < 4 || line.as_bytes()[3] != b'-' {
                break;
            }
        }
        stream
            .write_all(b"EHLO taomni.local\r\n")
            .map_err(|e| e.to_string())?;
        loop {
            let line = read_line(&mut reader)?;
            if line.len() < 4 || line.as_bytes()[3] != b'-' {
                break;
            }
        }
        stream
            .write_all(b"STARTTLS\r\n")
            .map_err(|e| e.to_string())?;
        let reply = read_line(&mut reader)?;
        if !reply.starts_with("220") {
            return Err(format!("STARTTLS refused: {}", reply.trim()));
        }
    } else if protocol == "pop3" {
        read_line(&mut reader)?; // +OK greeting
        stream.write_all(b"STLS\r\n").map_err(|e| e.to_string())?;
        let reply = read_line(&mut reader)?;
        if !reply.starts_with("+OK") {
            return Err(format!("STLS refused: {}", reply.trim()));
        }
    } else {
        read_line(&mut reader)?; // * OK greeting
        stream
            .write_all(b"a1 STARTTLS\r\n")
            .map_err(|e| e.to_string())?;
        loop {
            let line = read_line(&mut reader)?;
            if line.starts_with("a1 ") {
                if !line[3..].to_ascii_uppercase().starts_with("OK") {
                    return Err(format!("STARTTLS refused: {}", line.trim()));
                }
                break;
            }
        }
    }
    Ok(())
}

/// Connect, complete TLS without verification and return the leaf DER, plus
/// the result of a normally-verified handshake to the same endpoint.
pub(super) fn probe_endpoint(
    host: &str,
    connect_host: &str,
    connect_port: u16,
    security: MailConnectionSecurity,
    protocol: &str,
) -> Result<(Vec<u8>, Result<(), String>), String> {
    if security == MailConnectionSecurity::None {
        return Err("this server is configured without TLS".into());
    }
    let handshake = |verify: bool| -> Result<Option<Vec<u8>>, String> {
        let mut stream = tcp_connect(connect_host, connect_port)?;
        stream.set_read_timeout(Some(PROBE_TIMEOUT)).ok();
        stream.set_write_timeout(Some(PROBE_TIMEOUT)).ok();
        if security == MailConnectionSecurity::Starttls {
            starttls_preamble(&mut stream, protocol)?;
        }
        let connector = TlsConnector::builder()
            .danger_accept_invalid_certs(!verify)
            .danger_accept_invalid_hostnames(!verify)
            .build()
            .map_err(|e| format!("failed to build TLS connector: {e}"))?;
        let tls = connector
            .connect(host, stream)
            .map_err(|e| format!("TLS handshake failed: {e}"))?;
        let der = tls
            .peer_certificate()
            .map_err(|e| format!("reading the server certificate failed: {e}"))?
            .map(|cert| cert.to_der())
            .transpose()
            .map_err(|e| format!("encoding the server certificate failed: {e}"))?;
        Ok(der)
    };
    let der = handshake(false)?.ok_or_else(|| "server presented no certificate".to_string())?;
    let verified = handshake(true).map(|_| ());
    Ok((der, verified))
}

/// Fetch the IMAP or SMTP server certificate of an account for review.
#[tauri::command]
pub async fn mail_probe_certificate(
    config: MailAccountConfig,
    protocol: String,
    state: State<'_, AppState>,
) -> Result<MailCertificateInfo, String> {
    let smtp = protocol.eq_ignore_ascii_case("smtp");
    let pop3 = super::pop3::is_pop3(&config);
    let account = resolve_config(&state, config)?;
    let (host, port, security) = if smtp {
        (
            account.config.smtp.host.trim().to_string(),
            account.config.smtp.port,
            account.config.smtp.security,
        )
    } else {
        (
            account.config.imap.host.trim().to_string(),
            account.config.imap.port,
            account.config.imap.security,
        )
    };
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let (connect_host, connect_port, _forward) =
            mail_effective_endpoint(&account, &host, port, &handle)?;
        let (der, verified) = probe_endpoint(
            &host,
            &connect_host,
            connect_port,
            security,
            if smtp {
                "smtp"
            } else if pop3 {
                "pop3"
            } else {
                "imap"
            },
        )?;
        let mut info = describe_certificate(&host, port, &der);
        info.trusted_by_system = verified.is_ok();
        info.verify_error = verified.err();
        Ok(info)
    })
    .await
    .map_err(|e| format!("certificate probe task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const A_DER: &[u8] = include_bytes!("testdata/a.der");
    const A_P12: &[u8] = include_bytes!("testdata/a.p12");
    const B_P12: &[u8] = include_bytes!("testdata/b.p12");

    /// One-shot TLS server presenting `p12`; replies to a line with a line.
    fn tls_server(p12: &'static [u8]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let identity = native_tls::Identity::from_pkcs12(p12, "taomni").unwrap();
            let acceptor = native_tls::TlsAcceptor::new(identity).unwrap();
            for stream in listener.incoming().flatten().take(4) {
                if let Ok(mut tls) = acceptor.accept(stream) {
                    let _ = tls.write_all(b"* OK hello\r\n");
                    let mut buf = [0u8; 64];
                    let _ = tls.read(&mut buf);
                }
            }
        });
        port
    }

    fn connect(port: u16, trusted: Option<&str>) -> Result<(), String> {
        let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        let connector = tls_connector(trusted)?;
        let mut tls = connector
            .connect("localhost", stream)
            .map_err(|e| format!("{e}"))?;
        let mut greeting = [0u8; 12];
        tls.read_exact(&mut greeting).map_err(|e| e.to_string())?;
        let _ = tls.write_all(b"x\r\n");
        Ok(())
    }

    #[test]
    fn pinned_certificate_is_the_only_trust_anchor() {
        let pinned = BASE64.encode(A_DER);
        let port = tls_server(A_P12);
        assert!(
            connect(port, None).is_err(),
            "self-signed is rejected by default"
        );
        connect(port, Some(&pinned)).expect("pinned self-signed cert connects");

        // A different (changed) certificate is rejected even though pinned mode
        // relaxes host names.
        let other = tls_server(B_P12);
        assert!(
            connect(other, Some(&pinned)).is_err(),
            "changed cert must fail"
        );
    }

    #[test]
    fn probe_reports_fingerprint_and_system_failure() {
        let port = tls_server(A_P12);
        let (der, verified) = probe_endpoint(
            "localhost",
            "127.0.0.1",
            port,
            MailConnectionSecurity::Tls,
            "imap",
        )
        .unwrap();
        assert_eq!(der, A_DER);
        assert!(verified.is_err(), "self-signed fails system verification");
        let info = describe_certificate("localhost", port, &der);
        assert_eq!(info.sha256, fingerprint(A_DER));
        assert_eq!(info.sha256.len(), 32 * 3 - 1);
        assert!(info.subject.contains("taomni-test-a"), "{}", info.subject);
    }

    #[test]
    fn certificate_errors_get_a_review_hint() {
        assert!(
            certificate_error_hint("IMAP TLS handshake failed: self signed certificate", false)
                .contains("review it to add an exception")
        );
        assert!(
            certificate_error_hint("handshake: certificate verify failed", true)
                .contains("no longer matches")
        );
        assert_eq!(
            certificate_error_hint("connection refused", false),
            "connection refused"
        );
    }
}
