use std::sync::Arc;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

use super::{
    certificate_fingerprint, format_fingerprint, normalize_fingerprint,
};

#[test]
fn fingerprints_are_normalized_and_formatted() {
    let raw = "AA:BB-CC dd".to_string() + &"11".repeat(28);
    let normalized = normalize_fingerprint(&raw).unwrap();
    assert_eq!(normalized.len(), 64);
    assert!(normalized.starts_with("aabbccdd"));
    assert_eq!(format_fingerprint(&normalized).len(), 95);
    assert!(normalize_fingerprint("abcd").is_err());
}

#[test]
fn exact_pin_accepts_a_trusted_certificate_with_a_different_server_name() {
    use rustls::client::danger::ServerCertVerifier as _;
    super::install_crypto_provider();
    let generated = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert = CertificateDer::from(generated.cert.der().to_vec());
    let fingerprint = certificate_fingerprint(&cert);
    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert.clone()).unwrap();
    let webpki = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
        .build()
        .unwrap();
    let server_name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    let now = rustls::pki_types::UnixTime::now();
    assert!(matches!(
        webpki.verify_server_cert(&cert, &[], &server_name, &[], now),
        Err(rustls::Error::InvalidCertificate(
            rustls::CertificateError::NotValidForNameContext { .. }
        ))
    ));
    let mut pinned = super::PinnedServerVerifier {
        webpki,
        pin: Some(fingerprint.clone()),
        host: "127.0.0.1".to_string(),
        port: 3389,
    };
    pinned
        .verify_server_cert(&cert, &[], &server_name, &[], now)
        .unwrap();
    pinned.pin = Some("00".repeat(32));
    assert!(
        pinned
            .verify_server_cert(&cert, &[], &server_name, &[], now)
            .unwrap_err()
            .to_string()
            .contains("RDP_CERTIFICATE_CHANGED")
    );
    pinned.pin = None;
    assert!(
        pinned
            .verify_server_cert(&cert, &[], &server_name, &[], now)
            .unwrap_err()
            .to_string()
            .contains("RDP_CERTIFICATE_UNTRUSTED")
    );
    pinned.pin = Some(fingerprint);
    assert!(
        pinned
            .verify_pin(
                &cert,
                rustls::Error::InvalidCertificate(rustls::CertificateError::Revoked),
                now,
            )
            .is_err()
    );
}

#[test]
fn pinned_termservice_certificate_survives_a_conflicting_system_anchor() {
    use rustls::client::danger::ServerCertVerifier as _;
    use x509_cert::der::Decode as _;

    super::install_crypto_provider();
    // Public certificate from hosted run 36962712369. A stale system
    // anchor with the same issuer name can make WebPKI report BadSignature
    // instead of UnknownIssuer for this valid, self-signed certificate.
    let cert = CertificateDer::from(include_bytes!("../testdata/termservice-public.der").to_vec());
    let parsed = x509_cert::Certificate::from_der(cert.as_ref()).unwrap();
    let public_key = parsed
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .unwrap();
    let mut stale = cert.as_ref().to_vec();
    let key_offset = stale
        .windows(public_key.len())
        .position(|bytes| bytes == public_key)
        .unwrap();
    stale[key_offset + public_key.len() - 8] ^= 2;
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(stale)).unwrap();
    let webpki = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
        .build()
        .unwrap();
    let server_name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    // Keep the public fixture usable after its real-world expiry.
    let now = rustls::pki_types::UnixTime::since_unix_epoch(std::time::Duration::from_secs(
        1_790_928_000,
    ));
    assert!(matches!(
        webpki.verify_server_cert(&cert, &[], &server_name, &[], now),
        Err(rustls::Error::InvalidCertificate(
            rustls::CertificateError::BadSignature
        ))
    ));
    let mut pinned = super::PinnedServerVerifier {
        webpki,
        pin: Some(certificate_fingerprint(&cert)),
        host: "127.0.0.1".to_string(),
        port: 3389,
    };
    pinned
        .verify_server_cert(&cert, &[], &server_name, &[], now)
        .unwrap();
    pinned.pin = None;
    assert!(
        pinned
            .verify_server_cert(&cert, &[], &server_name, &[], now)
            .unwrap_err()
            .to_string()
            .contains("RDP_CERTIFICATE_UNTRUSTED")
    );

    // Even an exact pin cannot accept a genuinely damaged signature.
    let mut damaged = cert.as_ref().to_vec();
    *damaged.last_mut().unwrap() ^= 1;
    let damaged = CertificateDer::from(damaged);
    pinned.pin = Some(certificate_fingerprint(&damaged));
    assert!(matches!(
        pinned.verify_server_cert(&damaged, &[], &server_name, &[], now),
        Err(rustls::Error::InvalidCertificate(
            rustls::CertificateError::BadSignature
        ))
    ));
}

#[tokio::test]
async fn self_signed_certificate_requires_and_honors_exact_pin() {
    super::install_crypto_provider();
    let generated = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert = CertificateDer::from(generated.cert.der().to_vec());
    let fingerprint = certificate_fingerprint(&cert);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        generated.signing_key.serialize_der(),
    ));
    let server = Arc::new(
        rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_task = tokio::spawn(async move {
        for _ in 0..2 {
            let (stream, _) = listener.accept().await.unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(server.clone());
            let _ = acceptor.accept(stream).await;
        }
    });

    let first = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let error = super::upgrade(first, "localhost", port, None)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("RDP_CERTIFICATE_UNTRUSTED"));
    assert!(error.contains(&fingerprint));

    let second = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let verified = super::upgrade(second, "localhost", port, Some(&fingerprint))
        .await
        .unwrap();
    assert_eq!(verified.fingerprint, fingerprint);
    assert!(verified.used_pin);
    server_task.await.unwrap();
}
