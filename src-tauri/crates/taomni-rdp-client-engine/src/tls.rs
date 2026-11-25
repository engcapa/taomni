//! Certificate-verifying TLS for the RDP client and RD Gateway.
//!
//! IronRDP's convenience TLS adapter intentionally disables certificate
//! verification. Taomni instead validates against the operating-system trust
//! store and supports an explicit SHA-256 leaf-certificate pin for self-signed
//! or private-CA deployments. A missing/mismatched pin is reported with the
//! observed fingerprint so the frontend can ask for informed user consent.

use std::io;
use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};
pub use taomni_rdp_client_api::normalize_fingerprint;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use x509_cert::der::{Decode, Encode};

pub type TlsStream<S> = tokio_rustls::client::TlsStream<S>;

pub struct VerifiedTls<S> {
    pub stream: TlsStream<S>,
    pub server_public_key: Vec<u8>,
    pub fingerprint: String,
    pub used_pin: bool,
}

pub fn format_fingerprint(value: &str) -> String {
    value
        .as_bytes()
        .chunks(2)
        .filter_map(|chunk| std::str::from_utf8(chunk).ok())
        .collect::<Vec<_>>()
        .join(":")
        .to_ascii_uppercase()
}

pub async fn upgrade<S>(
    stream: S,
    server_name: &str,
    port: u16,
    pinned_fingerprint: Option<&str>,
) -> io::Result<VerifiedTls<S>>
where
    S: Unpin + AsyncRead + AsyncWrite,
{
    install_crypto_provider();
    let pin = pinned_fingerprint
        .map(normalize_fingerprint)
        .transpose()
        .map_err(io::Error::other)?;

    let native = rustls_native_certs::load_native_certs();
    if !native.errors.is_empty() {
        tracing::warn!(
            errors = native.errors.len(),
            "some operating-system root certificates could not be loaded"
        );
    }
    let mut roots = RootCertStore::empty();
    let (valid, invalid) = roots.add_parsable_certificates(native.certs);
    if invalid > 0 {
        tracing::warn!(
            invalid,
            "ignored malformed operating-system root certificates"
        );
    }
    if valid == 0 {
        return Err(io::Error::other(
            "operating-system certificate store did not provide any usable roots",
        ));
    }

    // Other network clients can install a different process-wide provider.
    // Keep RDP's verifier and TLS negotiation on the same provider as its
    // tested transport/probe rather than depending on initialization order.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let webpki = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build()
        .map_err(io::Error::other)?;
    let verifier = Arc::new(PinnedServerVerifier {
        webpki,
        pin,
        host: server_name.to_string(),
        port,
    });
    let used_pin = verifier.pin.is_some();

    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();

    let domain = ServerName::try_from(server_name.to_owned()).map_err(io::Error::other)?;
    let mut tls_stream = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(domain, stream)
        .await?;
    tls_stream.flush().await?;

    let cert_der = tls_stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .ok_or_else(|| io::Error::other("peer certificate is missing"))?;
    let cert = x509_cert::Certificate::from_der(cert_der.as_ref()).map_err(io::Error::other)?;
    let server_public_key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| io::Error::other("RDP TLS certificate public key is not byte-aligned"))?
        .to_vec();
    let fingerprint = certificate_fingerprint(cert_der);

    Ok(VerifiedTls {
        stream: tls_stream,
        server_public_key,
        fingerprint,
        used_pin,
    })
}

fn certificate_fingerprint(cert: &CertificateDer<'_>) -> String {
    hex::encode(Sha256::digest(cert.as_ref()))
}

fn install_crypto_provider() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[derive(Debug)]
struct PinnedServerVerifier {
    webpki: Arc<WebPkiServerVerifier>,
    pin: Option<String>,
    host: String,
    port: u16,
}

impl PinnedServerVerifier {
    fn verify_pin(
        &self,
        cert: &CertificateDer<'_>,
        system_error: rustls::Error,
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let observed = certificate_fingerprint(cert);
        let Some(expected) = self.pin.as_deref() else {
            return Err(rustls::Error::General(format!(
                "RDP_CERTIFICATE_UNTRUSTED host={} port={} observed={} system_error={system_error}",
                self.host, self.port, observed
            )));
        };
        if expected != observed {
            return Err(rustls::Error::General(format!(
                "RDP_CERTIFICATE_CHANGED host={} port={} expected={} observed={}",
                self.host, self.port, expected, observed
            )));
        }

        let parsed = x509_cert::Certificate::from_der(cert.as_ref()).map_err(|e| {
            rustls::Error::General(format!("pinned RDP certificate could not be parsed: {e}"))
        })?;
        let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(now.as_secs());
        if now < parsed.tbs_certificate.validity.not_before.to_system_time() {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::NotValidYet,
            ));
        }
        if now > parsed.tbs_certificate.validity.not_after.to_system_time() {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::Expired,
            ));
        }

        match system_error {
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)
            | rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName)
            | rustls::Error::InvalidCertificate(
                rustls::CertificateError::NotValidForNameContext { .. },
            ) => Ok(ServerCertVerified::assertion()),
            rustls::Error::InvalidCertificate(rustls::CertificateError::BadSignature)
                if valid_self_signature(&parsed) =>
            {
                // A system anchor with the same issuer name but another key
                // can produce BadSignature for a valid self-signed RDP leaf.
                // Exact pinning plus its independently verified signature
                // establishes trust without using that conflicting anchor.
                Ok(ServerCertVerified::assertion())
            }
            other => Err(other),
        }
    }
}

fn valid_self_signature(cert: &x509_cert::Certificate) -> bool {
    if cert.tbs_certificate.issuer != cert.tbs_certificate.subject
        || cert.signature_algorithm != cert.tbs_certificate.signature
    {
        return false;
    }
    let spki = &cert.tbs_certificate.subject_public_key_info;
    let (Some(key), Some(signature)) = (
        spki.subject_public_key.as_bytes(),
        cert.signature.as_bytes(),
    ) else {
        return false;
    };
    let (Ok(key_algorithm), Ok(signature_algorithm), Ok(message)) = (
        spki.algorithm.to_der(),
        cert.signature_algorithm.to_der(),
        cert.tbs_certificate.to_der(),
    ) else {
        return false;
    };
    let (Ok(key_algorithm), Ok(signature_algorithm)) = (
        x509_cert::der::asn1::AnyRef::from_der(&key_algorithm),
        x509_cert::der::asn1::AnyRef::from_der(&signature_algorithm),
    ) else {
        return false;
    };
    rustls::crypto::ring::default_provider()
        .signature_verification_algorithms
        .all
        .iter()
        .any(|algorithm| {
            algorithm.public_key_alg_id().as_ref() == key_algorithm.value()
                && algorithm.signature_alg_id().as_ref() == signature_algorithm.value()
                && algorithm.verify_signature(key, &message, signature).is_ok()
        })
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.webpki.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(verified) => Ok(verified),
            Err(error) => self.verify_pin(end_entity, error, now),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki
            .verify_tls12_signature(message, cert, dss)
            .map_err(|error| {
                rustls::Error::General(format!(
                    "TLS 1.2 handshake signature {:?}: {error}",
                    dss.scheme
                ))
            })
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki
            .verify_tls13_signature(message, cert, dss)
            .map_err(|error| {
                rustls::Error::General(format!(
                    "TLS 1.3 handshake signature {:?}: {error}",
                    dss.scheme
                ))
            })
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests;
