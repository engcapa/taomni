use super::model::Stream;
use rustls::DigitallySignedStruct;
use rustls::SignatureScheme;
use rustls::client::danger::HandshakeSignatureValid;
use rustls::client::danger::ServerCertVerified;
use rustls::client::danger::ServerCertVerifier;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::ServerName;
use rustls::pki_types::UnixTime;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use x509_cert::der::Decode;

#[derive(Debug)]
pub(super) struct AcceptAnyServerCert(pub(super) Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub(super) async fn tls_upgrade(
    stream: TcpStream,
    host: &str,
) -> Result<(Stream, Vec<u8>, String), String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS protocol versions: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();
    let domain = ServerName::try_from(host.to_owned()).map_err(|e| format!("server name: {e}"))?;
    let mut tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(domain, stream)
        .await
        .map_err(|e| format!("TLS handshake: {e}"))?;
    tls.flush().await.map_err(|e| format!("TLS flush: {e}"))?;
    let cert_der = tls
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .ok_or_else(|| "server presented no certificate".to_string())?;
    let cert = x509_cert::Certificate::from_der(cert_der.as_ref())
        .map_err(|e| format!("server certificate: {e}"))?;
    let public_key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| "server public key is not byte aligned".to_string())?
        .to_vec();
    let fingerprint = hex::encode(Sha256::digest(cert_der.as_ref()));
    Ok((tls, public_key, fingerprint))
}
